# Судоку — мини-приложение для VVelcom

Игра-судоку (4×4, 6×6, 9×9) как мини-приложение бота VVelcom и серверная часть на Yandex Cloud Functions.

- `web-app/` — статический фронтенд (HTML/CSS/JS без зависимостей и сборки). Хостится в Yandex Object Storage или на любом HTTPS-хостинге.
- `cloud-function/` — облачная функция Node.js 22 без зависимостей: отправка результата игры и ответ на `/start`.
- `tests/` и `web-app/tests/` — тесты.

## Что делает бот

- **`/start`** (и `/play`) — бот присылает сообщение «Это приложение «Судоку». Для начала игры нажмите кнопку «Играть» ниже» и под ним кнопку **🎮 Играть**, открывающую веб-приложение.
- **«Поделиться результатом»** после победы — функция проверяет подпись `initData` и решение, затем через `answerWebAppQuery` отправляет в чат с ботом сообщение с результатом (уровень, время, ошибки, подсказки) и кнопкой **📣 В ленту** (`share_to_feed`). По нажатию результат публикуется в ленту от имени игрока после подтверждения.

## Развёртывание

1. Создайте бота в [@VVbotMother](https://uvvel.com/@VVbotMother) (`/newbot`) и получите токен `vv_…`.
2. Создайте облачную функцию: Node.js 22, обработчик `index.handler`, таймаут 15 с. Загрузите в корень архива содержимое `cloud-function/` (`index.js`, `package.json`, `puzzles.json`).
3. Переменные окружения функции (см. `cloud-function/.env.example`):

   | Имя | Назначение |
   |---|---|
   | `VVELCOM_BOT_TOKEN` | токен бота |
   | `ALLOWED_ORIGINS` | origin фронтенда без пути, через запятую |
   | `GAME_URL` | HTTPS-адрес `index.html` (кнопка «Играть») |
   | `VVELCOM_WEBHOOK_SECRET` | секрет webhook, например `openssl rand -hex 24` |

4. Загрузите `web-app/` (без `tests/`) в бакет, в `config.json` укажите `backendUrl` — URL функции.
5. Подключите webhook (если у бота уже есть другой webhook, сначала объедините обработчики):

```bash
curl -sS -X POST "https://apibots.vvelcom.online/bot${VVELCOM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://functions.yandexcloud.net/ВАШ_ID?mode=webhook\",\"secret_token\":\"${VVELCOM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\"]}"
```

Проверка: `GET` на URL функции возвращает `{"service":"sudoku-share","configured":true}`.

> Отправка результата работает, когда в `initData` есть `query_id`, то есть игра открыта кнопкой `web_app` из сообщения бота (именно такая кнопка в ответе на `/start`). При открытии иначе игра предложит обычное системное «Поделиться».

Время, ошибки и подсказки приходят с клиента, поэтому не годятся для публичного соревновательного рейтинга; проверяется только правильность решения.

## Тесты

```bash
node --test tests/backend.test.cjs
node web-app/tests/runtime_smoke.cjs
python web-app/tests/verify_puzzles.py
python tests/browser_controls_test.py   # нужен Playwright + Chromium
python tests/browser_share_test.py
```
