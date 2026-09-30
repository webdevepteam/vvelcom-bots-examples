import os
import time

import requests
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("VVELCOM_BOT_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit("Укажите VVELCOM_BOT_TOKEN в файле .env")

API = f"https://apibots.vvelcom.online/bot{TOKEN}"


def call(method: str, payload: dict | None = None):
    response = requests.post(f"{API}/{method}", json=payload or {}, timeout=60)
    data = response.json()
    if not response.ok or not data.get("ok"):
        raise RuntimeError(data.get("description", f"HTTP {response.status_code}"))
    return data["result"]


def main():
    me = call("getMe")
    print(f"Бот @{me.get('username', me['id'])} запущен")

    offset = 0
    while True:
        try:
            for update in call("getUpdates", {"offset": offset, "timeout": 30}):
                message = update.get("message")
                if message and message.get("text"):
                    text = (
                        "Привет! Я эхо-бот. Напишите мне что-нибудь."
                        if message["text"] == "/start"
                        else f"Вы написали: {message['text']}"
                    )
                    call("sendMessage", {"chat_id": message["chat"]["id"], "text": text})
                offset = update["update_id"] + 1
        except (requests.RequestException, RuntimeError, ValueError) as error:
            print(f"Ошибка: {error}. Повтор через 3 секунды.")
            time.sleep(3)


if __name__ == "__main__":
    main()

