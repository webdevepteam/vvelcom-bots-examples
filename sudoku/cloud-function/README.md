# Yandex Cloud Function — Sudoku 1.4

- Node.js 22, обработчик `index.handler`, таймаут 15 секунд, без внешних зависимостей.
- ZIP функции должен содержать в корне: `index.js`, `package.json`, `puzzles.json`.
- Единственная обязательная секретная переменная — `VVELCOM_BOT_TOKEN` (бот @VVbotMother).
- `ALLOWED_ORIGINS` — origin статической игры, без пути.
- `GAME_URL` и `VVELCOM_WEBHOOK_SECRET` — только для необязательного webhook `/start`.
- `GET /` — статус без раскрытия секретов. `POST /` JSON `action=share` — защищённая отправка итога через `answerWebAppQuery`. `POST /?mode=webhook` — обработка команды `/start`.
- Сервер проверяет HMAC `initData`, `auth_date`, `query_id` и все числа решённой головоломки. Под сообщением кнопка «В ленту» (`share_to_feed`) публикует результат в ленту от имени игрока.

Подробная инструкция находится в корне полного комплекта.
