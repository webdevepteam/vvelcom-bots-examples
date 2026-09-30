import base64
import json
import os

import requests

VVELCOM_TOKEN = os.getenv("VVELCOM_BOT_TOKEN", "").strip()
WEBHOOK_SECRET = os.getenv("VVELCOM_WEBHOOK_SECRET", "").strip()
YANDEX_API_KEY = os.getenv("YANDEX_CLOUD_API_KEY", "").strip()
YANDEX_FOLDER_ID = os.getenv("YANDEX_CLOUD_FOLDER_ID", "").strip()
MODEL_URI = os.getenv("YANDEX_MODEL_URI", "").strip() or f"gpt://{YANDEX_FOLDER_ID}/yandexgpt/latest"
SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT", "Ты полезный русскоязычный помощник. Отвечай понятно и кратко."
).strip()

VVELCOM_API = f"https://apibots.vvelcom.online/bot{VVELCOM_TOKEN}"
YANDEX_API = "https://ai.api.cloud.yandex.net/v1/chat/completions"


def response(status_code: int, body: str = "ok") -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "text/plain; charset=utf-8"},
        "body": body,
        "isBase64Encoded": False,
    }


def parse_body(event: dict) -> dict:
    raw = event.get("body", "")
    if event.get("isBase64Encoded") and isinstance(raw, str):
        raw = base64.b64decode(raw).decode("utf-8")
    if isinstance(raw, dict):
        return raw
    return json.loads(raw or "{}")


def vvelcom_call(method: str, payload: dict):
    result = requests.post(f"{VVELCOM_API}/{method}", json=payload, timeout=8)
    data = result.json()
    if not result.ok or not data.get("ok"):
        raise RuntimeError(data.get("description", f"VVelcom HTTP {result.status_code}"))
    return data["result"]


def ask_yandex(prompt: str) -> str:
    result = requests.post(
        YANDEX_API,
        headers={
            "Authorization": f"Api-Key {YANDEX_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL_URI,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.6,
            "max_tokens": 600,
        },
        timeout=8,
    )
    if not result.ok:
        raise RuntimeError(f"Yandex Cloud HTTP {result.status_code}: {result.text[:300]}")
    return result.json()["choices"][0]["message"]["content"].strip()[:4096]


def command_name(text: str) -> str:
    first_word = text.split(maxsplit=1)[0].lower()
    return first_word.split("@", 1)[0]


def command_argument(text: str) -> str:
    parts = text.split(maxsplit=1)
    return parts[1].strip() if len(parts) == 2 else ""


def handle_message(message: dict) -> None:
    text = message.get("text", "").strip()
    if not text:
        return

    command = command_name(text) if text.startswith("/") else ""
    if command == "/start":
        answer = (
            "Привет! Я отвечаю с помощью YandexGPT. Напишите вопрос обычным сообщением "
            "или используйте /ask ваш вопрос."
        )
    elif command == "/help":
        answer = (
            "Команды:\n"
            "/start — начать работу\n"
            "/help — показать справку\n"
            "/ask вопрос — задать вопрос YandexGPT\n"
            "/about — узнать, как работает бот"
        )
    elif command == "/about":
        answer = (
            "Бот передаёт текст вопроса в Yandex Cloud AI Studio и возвращает ответ модели. "
            "Эта демонстрационная версия не хранит историю диалога."
        )
    elif command == "/ask":
        prompt = command_argument(text)
        answer = ask_yandex(prompt) if prompt else "Напишите вопрос после команды: /ask ваш вопрос"
    elif command:
        answer = "Неизвестная команда. Нажмите /help, чтобы увидеть список."
    else:
        answer = ask_yandex(text)

    vvelcom_call("sendMessage", {"chat_id": message["chat"]["id"], "text": answer})


def handler(event, context):
    if event.get("httpMethod") != "POST":
        return response(405, "Method Not Allowed")

    headers = {key.lower(): value for key, value in event.get("headers", {}).items()}
    if not WEBHOOK_SECRET or headers.get("x-messenger-webhook-secret") != WEBHOOK_SECRET:
        return response(403, "Forbidden")

    try:
        update = parse_body(event)
        if update.get("event_type") == "message" and update.get("message"):
            handle_message(update["message"])
        return response(200)
    except (KeyError, ValueError, requests.RequestException, RuntimeError) as error:
        print(f"Webhook error: {error}")
        return response(500, "Temporary error")

