# Примеры ботов для VVelcom.online

Готовые небольшие проекты, которые можно запустить локально и использовать как основу для своего бота.

## Перед началом

1. Откройте [@VVbotMother](https://uvvel.com/@VVbotMother) в VVelcom.online.
2. Отправьте `/newbot`, укажите имя и username, заканчивающийся на `vvbot`.
3. Скопируйте токен вида `vv_…`. Токен равнозначен паролю: не добавляйте его в Git и не отправляйте в чат.
4. Выберите пример, скопируйте его `.env.example` в `.env` и заполните значения.
5. Запустите проект по инструкции из его README.

Примеры используют `getUpdates` (long polling), поэтому для первого запуска не нужны домен, HTTPS и публичный сервер. Если у бота уже настроен webhook, сначала удалите его:

```bash
curl -X POST "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/deleteWebhook" \
  -H "Content-Type: application/json" \
  -d '{"drop_pending_updates":false}'
```

## Каталог

| Пример | Язык | Что показывает |
|---|---|---|
| [`echo-python`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/echo-python) | Python 3.10+ | Самый короткий эхо-бот без фреймворка |
| [`echo-js`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/echo-js) | Node.js 18+ | Базовая работа с Bot API через встроенный `fetch` |
| [`yandex-ai-python`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/yandex-ai-python) | Python 3.10+ | Диалог с YandexGPT через Yandex Cloud AI Studio |
| [`yandex-ai-function-python`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/yandex-ai-function-python) | Yandex Cloud Functions, Python 3.12 | Рекомендуемый серверный ИИ-бот с webhook и командами |
| [`sudoku`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/sudoku) | Yandex Cloud Functions, Node.js 22 + статический веб-апп | Мини-приложение «Судоку»: `/start` с кнопкой «Играть», результат в чат и «В ленту» |
| [`telegram-to-vvelcom-js`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/telegram-to-vvelcom-js) | Node.js 18+ | Кросспостинг текстовых публикаций из Telegram-канала в канал VVelcom |
| [`telegram-channel-crosspost-gigachat-yandex-function-js`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/telegram-channel-crosspost-gigachat-yandex-function-js) | Yandex Cloud Functions, Node.js 22 | Кросспост с ИИ-фильтром GigaChat Lite и чат-бот с ответами на вопросы |
| [`shopping-list-gigachat-yandex-function-js`](https://github.com/webdevepteam/vvelcom-bots-examples/tree/main/shopping-list-gigachat-yandex-function-js) | Yandex Cloud Functions, Node.js 22 | Списки покупок и дел из голосовых и текста: `transcribeVoice`, GigaChat, промпт и модель в переменных функции, чекбоксы, история 10 списков |

## Как бот попадает в группу или канал

- В личном чате пользователь должен сам открыть бота и нажать «Начать».
- В группу бота добавляет владелец или администратор. В группе бот по умолчанию получает только команды, упоминания и ответы на свои сообщения.
- В канал бота добавляют через «Информация о канале» → «Добавить бота». После добавления бот может публиковать сообщения методом `sendMessage`; `chat_id` канала можно проверить методом `getChat`.

## Что добавлять дальше

Каждый новый пример размещайте в отдельной папке и добавляйте:

- `README.md` с назначением, настройкой и запуском;
- `.env.example` без настоящих секретов;
- минимальный файл зависимостей;
- обработку ошибок API и понятное сообщение при отсутствии переменных окружения;
- примечание об ограничениях примера и шагах для production-запуска.

Полная справка: [документация Bot API](https://vvelcom.online/api/).
