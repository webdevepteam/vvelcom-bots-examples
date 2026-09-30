# ИИ-бот VVelcom с YandexGPT

Бот принимает сообщение в личном чате, передаёт его модели YandexGPT через Yandex Cloud AI Studio и отправляет ответ обратно. Для каждого чата в памяти процесса сохраняются последние шесть реплик.

## 1. Подготовьте Yandex Cloud

1. Создайте каталог и сервисный аккаунт в [консоли Yandex Cloud](https://console.yandex.cloud/).
2. Назначьте сервисному аккаунту роль `ai.languageModels.user` на каталог.
3. Создайте API-ключ с областью действия `yc.ai.foundationModels.execute` или `yc.ai.languageModels.execute`.
4. Сохраните идентификатор каталога и секрет API-ключа. Секрет показывается только при создании.

Документация Yandex Cloud: [API-ключи](https://yandex.cloud/ru/docs/iam/concepts/authorization/api-key) и [сервисные аккаунты](https://yandex.cloud/ru/docs/iam/concepts/users/service-accounts).

## 2. Настройте и запустите

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # Windows: copy .env.example .env
python bot.py
```

В `.env` заполните:

- `VVELCOM_BOT_TOKEN` — токен от @VVbotMother;
- `YANDEX_CLOUD_API_KEY` — API-ключ сервисного аккаунта;
- `YANDEX_CLOUD_FOLDER_ID` — идентификатор каталога;
- `YANDEX_MODEL_URI` — необязательно; по умолчанию используется `gpt://<folder_id>/yandexgpt/latest`;
- `SYSTEM_PROMPT` — характер и правила ответов бота.

## Добавление в группу

Добавьте бота как участника группы. Он будет отвечать только на сообщения, которые платформа передала ему: команды, упоминания и ответы на сообщения бота. В канале этот пример не отвечает автоматически на каждый пост.

## Важно

- Текст сообщения отправляется в Yandex Cloud для генерации ответа. Сообщите об этом пользователям в описании бота и своей политике обработки данных.
- Запросы к модели могут быть платными.
- История хранится только в оперативной памяти и пропадает после перезапуска.
- Для production добавьте постоянное хранилище истории, ограничение частоты запросов, модерацию, мониторинг и webhook.

