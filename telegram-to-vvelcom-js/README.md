# Кросспостинг Telegram → VVelcom

Бот получает новые публикации из одного Telegram-канала и публикует их в канале VVelcom.

Текущая версия переносит текст и подпись публикации. Bot API VVelcom пока не отправляет медиафайлы, поэтому для поста с медиа добавляется ссылка на исходную публикацию, если Telegram-канал публичный.

## 1. Настройте Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather) и получите токен.
2. Добавьте бота администратором исходного Telegram-канала. Иначе он не получит событие `channel_post`.
3. Если у Telegram-бота был webhook, удалите его перед запуском long polling:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook?drop_pending_updates=false"
```

## 2. Настройте VVelcom

1. Создайте бота через @VVbotMother и скопируйте токен `vv_…`.
2. Откройте канал VVelcom → «Информация о канале» → «Добавить бота».
3. Опубликуйте в канале тестовый пост и вызовите `getUpdates`. Скопируйте значение `channel_post.chat.id` из ответа — это UUID для `VVELCOM_CHANNEL_ID`:

```bash
curl -X POST "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/getUpdates" \
  -H "Content-Type: application/json" \
  -d '{"timeout":10,"allowed_updates":["channel_post"]}'
```

Если у VVelcom-бота настроен webhook, перед этим удалите его методом `deleteWebhook`.

Проверить id и доступ можно запросом:

```bash
curl -X POST "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/getChat" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\":\"$VVELCOM_CHANNEL_ID\"}"
```

## 3. Запустите

```bash
cp .env.example .env             # Windows: copy .env.example .env
npm start
```

Переменные:

- `TELEGRAM_SOURCE_CHANNEL` — `@username` публичного канала или числовой id вида `-100…`;
- `ADD_SOURCE_LINK=true` — добавлять ссылку на исходный пост, когда она доступна;
- остальные значения — токены и UUID целевого канала.

## Ограничения примера

- После перезапуска offset Telegram не сохраняется. Для production храните его в базе.
- Отредактированные и удалённые публикации не синхронизируются.
- Сообщения длиннее 4096 символов обрезаются.
- Не запускайте одновременно две копии: они будут конкурировать за `getUpdates`.
