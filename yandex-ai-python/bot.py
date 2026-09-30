import os
import time
from collections import defaultdict, deque

import requests
from dotenv import load_dotenv

load_dotenv()

VVELCOM_TOKEN = os.getenv("VVELCOM_BOT_TOKEN", "").strip()
YANDEX_API_KEY = os.getenv("YANDEX_CLOUD_API_KEY", "").strip()
YANDEX_FOLDER_ID = os.getenv("YANDEX_CLOUD_FOLDER_ID", "").strip()
MODEL_URI = os.getenv("YANDEX_MODEL_URI", "").strip() or f"gpt://{YANDEX_FOLDER_ID}/yandexgpt/latest"
SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT", "Ты полезный русскоязычный помощник. Отвечай понятно и кратко."
).strip()

missing = [
    name
    for name, value in {
        "VVELCOM_BOT_TOKEN": VVELCOM_TOKEN,
        "YANDEX_CLOUD_API_KEY": YANDEX_API_KEY,
        "YANDEX_CLOUD_FOLDER_ID": YANDEX_FOLDER_ID,
    }.items()
    if not value
]
if missing:
    raise SystemExit(f"Заполните переменные в .env: {', '.join(missing)}")

VVELCOM_API = f"https://apibots.vvelcom.online/bot{VVELCOM_TOKEN}"
YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions"
histories = defaultdict(lambda: deque(maxlen=6))


def vvelcom_call(method: str, payload: dict | None = None):
    response = requests.post(f"{VVELCOM_API}/{method}", json=payload or {}, timeout=60)
    data = response.json()
    if not response.ok or not data.get("ok"):
        raise RuntimeError(data.get("description", f"VVelcom HTTP {response.status_code}"))
    return data["result"]


def ask_yandex(chat_id: str, text: str) -> str:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(histories[chat_id])
    messages.append({"role": "user", "content": text})

    response = requests.post(
        YANDEX_API,
        headers={
            "Authorization": f"Api-Key {YANDEX_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"model": MODEL_URI, "messages": messages, "temperature": 0.6, "max_tokens": 1000},
        timeout=90,
    )
    if not response.ok:
        raise RuntimeError(f"Yandex Cloud HTTP {response.status_code}: {response.text[:300]}")

    answer = response.json()["choices"][0]["message"]["content"].strip()
    histories[chat_id].append({"role": "user", "content": text})
    histories[chat_id].append({"role": "assistant", "content": answer})
    return answer[:4096]


def main():
    me = vvelcom_call("getMe")
    print(f"ИИ-бот @{me.get('username', me['id'])} запущен")
    offset = 0

    while True:
        try:
            for update in vvelcom_call("getUpdates", {"offset": offset, "timeout": 30}):
                message = update.get("message")
                if message and message.get("text"):
                    chat_id = message["chat"]["id"]
                    text = message["text"].strip()
                    if text == "/start":
                        answer = "Привет! Напишите вопрос, и я отвечу с помощью YandexGPT."
                    elif text == "/reset":
                        histories.pop(chat_id, None)
                        answer = "История диалога очищена."
                    else:
                        answer = ask_yandex(chat_id, text)
                    vvelcom_call("sendMessage", {"chat_id": chat_id, "text": answer})
                offset = update["update_id"] + 1
        except (requests.RequestException, RuntimeError, KeyError, ValueError) as error:
            print(f"Ошибка: {error}. Повтор через 3 секунды.")
            time.sleep(3)


if __name__ == "__main__":
    main()

