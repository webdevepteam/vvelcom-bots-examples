# Кросспостинг Telegram → VVelcom

Бот получает новые публикации из одного Telegram-канала и публикует их в канале VVelcom.

Текущая версия переносит текст и подпись публикации. Для поста с медиа добавляется ссылка на исходную публикацию, если Telegram-канал публичный. Bot API VVelcom умеет отправлять фото и видео (`sendPhoto`, `sendVideo`), но в этом примере файлы не пересылаются: через Bot API Telegram они доступны только по ссылке с токеном вашего Telegram-бота, а отдавать её стороннему сервису нельзя. Пересылку фото и видео по публичным ссылкам показывает пример [telegram-channel-crosspost-yandex-function-js](../telegram-channel-crosspost-yandex-function-js).

## 1. Настройте Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather) и получите токен.
2. Добавьте бота администратором исходного Telegram-канала. Иначе он не получит событие `channel_post`.
3. Если у Telegram-бота был webhook, удалите его перед запуском long polling:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook?drop_pending_updates=false"
```

## 2. Настройте VVelcom

1. Создайте бота через @VVbotMother и скопируйте токен `vv_…`.
2. Откройте канал VVelcom → «Информация о канале» → «Добавить бота». Бот станет администратором и сможет публиковать посты в этом канале.
3. Узнайте **ник канала** VVelcom (например, `@my_channel`): он указан в «Информация о канале». Именно он задаёт, **в какой канал уходят посты**, — переменная `VVELCOM_CHANNEL`. UUID искать не нужно: Bot API принимает `chat_id` в виде `@ник` для канала, в котором бот состоит.

Проверить, что бот видит канал, можно запросом:

```bash
curl -X POST "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/getChat" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"@my_channel"}'
```

Если ответ `403 BOT_CHAT_ACCESS_DENIED`, бот не добавлен в этот канал или ник указан неверно.

## 3. Запустите

```bash
cp .env.example .env             # Windows: copy .env.example .env
npm start
```

Переменные:

- `TELEGRAM_SOURCE_CHANNEL` — `@username` публичного канала или числовой id вида `-100…`;
- `ADD_SOURCE_LINK=true` — добавлять ссылку на исходный пост, когда она доступна;
- `VVELCOM_CHANNEL` — ник канала VVelcom, куда публикуются посты (`@my_channel`; подойдёт и UUID канала);
- остальные значения — токены.

## Ограничения примера

- После перезапуска offset Telegram не сохраняется. Для production храните его в базе.
- Отредактированные и удалённые публикации не синхронизируются.
- Сообщения длиннее 4096 символов обрезаются.
- Не запускайте одновременно две копии: они будут конкурировать за `getUpdates`.
