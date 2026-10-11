# Кросспостинг с ИИ-фильтром GigaChat + чат-бот (Yandex Cloud Functions, Node.js)

Кросспостинг из Telegram-канала в канал VVelcom: вместо (или вместе с) списка ключевых слов пост проверяет **GigaChat Lite**, а ещё бот умеет отвечать на вопросы. Одна функция, два режима — по типу вызова:

- **таймер-триггер** — кросспост с ИИ-фильтром;
- **HTTP (webhook VVelcom)** — чат: `/start`, личные сообщения, упоминание `@бота` в группе или канале.

## ИИ-фильтр постов

Задайте в `AI_FILTER_PROMPT`, что искать, например: `Пост про выход новых смартфонов`. Для каждого свежего поста GigaChat возвращает JSON:

```json
{"match": true, "reason": "анонс нового смартфона Samsung"}
```

`match: true` — пост уходит в канал VVelcom, `false` — пропускается. Вердикт, причина, сырой ответ модели и сам промт пишутся в лог записью `ai_filter_result` — по ней видно, верно ли отработал фильтр. Если `KEYWORDS_JSON` не пуст, слова работают как дешёвый предфильтр перед ИИ. Отклонённые посты запоминаются в SQLite (`status = 'rejected'`) и повторно не оцениваются. Ошибка ИИ (`ai_filter_failed`) пост не помечает — он будет оценён при следующем запуске. Посты без текста (только фото/видео) при включённом фильтре пропускаются. Пустой `AI_FILTER_PROMPT` выключает фильтр.

## Чат-бот

- **`/start`** — «Напишите свой вопрос, и я отвечу».
- **Личный чат** — любое сообщение считается вопросом.
- **Группа / канал** — вопрос с упоминанием `@ник_бота` (платформа доставляет боту в группе только упоминания, команды и ответы ему). Упоминание вырезается из вопроса.
- **Эффект «ИИ думает»**: бот сразу присылает «💭 Думаю над вопросом…», получает ответ GigaChat, **удаляет** это сообщение (`deleteMessage`) и присылает ответ. `sendChatAction` в VVelcom ничего не делает, поэтому «печатает» имитируется сообщением-заглушкой.
- При ошибке модели заглушка удаляется и бот пишет, что не получилось ответить. Функция всегда отвечает вебхуку `200`, чтобы VVelcom не присылал событие повторно.

Webhook:

```bash
curl -X POST "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://functions.yandexcloud.net/<FUNCTION_ID>\",\"secret_token\":\"$VVELCOM_WEBHOOK_SECRET\"}"
```

Функция должна быть публичной (`allow-unauthenticated-invoke`), а таймаут — не меньше 15 с; VVelcom ждёт ответ вебхука до 10 с, `GIGACHAT_TIMEOUT_MS` по умолчанию 8 с. Бота нужно добавить в группу/канал.

## GigaChat: ключи и сертификат

1. В [личном кабинете](https://developers.sber.ru/studio) создайте проект GigaChat API и скопируйте **ключ авторизации** → `GIGACHAT_AUTH_KEY` (в Lockbox).
2. Сервера Сбера используют сертификат российского УЦ, которого нет в Node. Скачайте корневой сертификат ([инструкция Сбера](https://developers.sber.ru/docs/ru/gigachat/certificates)), положите PEM рядом с `index.js` и укажите `GIGACHAT_CA_PATH=./russian_trusted_root_ca.pem`. Крайний вариант — `GIGACHAT_INSECURE_TLS=true` (проверка выключается, токены уязвимы для подмены).
3. Токен доступа (30 минут) функция получает и кэширует сама; запросы идут по REST: OAuth `ngw.devices.sberbank.ru:9443/api/v2/oauth`, чат `gigachat.devices.sberbank.ru/api/v1/chat/completions`.

## Новые переменные

| Имя | По умолчанию | Описание |
|---|---|---|
| `GIGACHAT_AUTH_KEY` | — | ключ авторизации (Lockbox) |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` | также `GIGACHAT_API_B2B`, `GIGACHAT_API_CORP` |
| `GIGACHAT_MODEL` | `GigaChat` | это Lite; можно `GigaChat-Pro`, `GigaChat-Max` |
| `GIGACHAT_TIMEOUT_MS` | `8000` | таймаут запросов к GigaChat |
| `GIGACHAT_CA_PATH` | — | путь к PEM российского УЦ |
| `GIGACHAT_INSECURE_TLS` | — | `true` — не проверять сертификат |
| `AI_FILTER_PROMPT` | — | что искать в постах; пусто — ИИ-фильтр выключен |
| `VVELCOM_WEBHOOK_SECRET` | — | секрет вебхука (`secret_token`) |
| `BOT_USERNAME` | из `getMe` | ник бота для распознавания упоминания |
| `CHAT_SYSTEM_PROMPT` | русскоязычный помощник | системный промт ответов в чате |

Остальное (подготовка, деплой, relay, переменные кросспоста) — как в исходном примере ниже.

---


> ⚠️ **Только для владельца канала.** Пример читает публичную веб-версию Telegram-канала (`t.me/s/…`) и republish-ит посты в канал VVelcom. Использовать его вправе **исключительно владелец (или администратор с явного разрешения владельца) исходного Telegram-канала** — для зеркалирования собственного контента. Копировать чужие каналы нельзя: это нарушает права авторов и правила платформ.

Функция запускается по таймеру (например, раз в час) в [Yandex Cloud Functions](https://yandex.cloud/ru/docs/functions/): забирает свежие посты канала, при необходимости фильтрует их по ключевым словам и публикует в канал VVelcom методами `sendMessage`, `sendPhoto` и `sendVideo`. Уже отправленные посты запоминаются в SQLite, поэтому дублей нет.

## Что пересылается

- **Текст** — `sendMessage`. Текст длиннее 4096 символов VVelcom сам разбивает на несколько сообщений, функция его не обрезает.
- **Фото** — `sendPhoto`: функция берёт ссылку на картинку из публичной страницы Telegram, а VVelcom сам скачивает её, сжимает (длинная сторона 1280 px, JPEG) и отправляет в канал.
- **Видео** — `sendVideo`, если Telegram отдаёт на странице прямую ссылку на ролик (обычно это небольшие видео); VVelcom сжимает его так же, как приложение (до 1280 px, H.264). Видео без прямой ссылки не пересылаются.
- До 10 файлов на пост. Несколько фото уходят одним сообщением-альбомом (`sendMediaGroup`); если альбом не принят, фото отправляются по одному, ничего не теряется. Видео идут отдельными сообщениями. Текст идёт подписью к первому файлу целиком; если он длиннее 4096 символов, остаток VVelcom отправляет следующими сообщениями.
- Если файл не приняли (недоступная ссылка, слишком большой), пост всё равно уходит текстом со ссылкой на оригинал.
- Лимит платформы — 60 сообщений в минуту в один чат и 20 фото/видео в минуту на бота: функция делает паузу между отправками и повторяет запрос при `429`.

Подробности методов — в [документации Bot API](https://vvelcom.online/api/).

## Подготовка

1. Создайте бота у [@VVbotMother](https://uvvel.com/@VVbotMother) (`/newbot`), получите токен `vv_…`.
2. Добавьте бота в свой канал VVelcom («Информация о канале» → «Добавить бота») — он станет администратором и сможет публиковать посты.
3. Запомните **ник канала** VVelcom (например, `@my_channel`) — он и есть `VVELCOM_CHANNEL`. Искать UUID канала не нужно: Bot API принимает `chat_id` в виде `@ник` для каналов, где бот состоит.
4. Токен храните в [Yandex Lockbox](https://yandex.cloud/ru/docs/lockbox/), остальное — в переменных окружения (см. `.env.example`).

## Деплой

Подробнее о сервисе: [документация Yandex Cloud Functions](https://yandex.cloud/ru/docs/functions/).

Рантайм `nodejs22` (или новее), точка входа `index.handler`, зависимости ставятся из `package.json`. SQLite-файл должен лежать на примонтированном хранилище (Object Storage) по пути `SQLITE_PATH`; функция должна работать в единственном экземпляре. Запускайте её таймер-триггером с периодом не больше `LOOKBACK_MINUTES`.

## Переменные

| Имя | По умолчанию | Описание |
|---|---|---|
| `VVELCOM_BOT_TOKEN` | — | токен бота (Lockbox) |
| `VVELCOM_CHANNEL` | — | ник канала VVelcom (`@my_channel` или `my_channel`); подойдёт и UUID канала |
| `CHANNELS_JSON` | `["https://t.me/s/bmpd_cast"]` | JSON-массив публичных Telegram-каналов |
| `KEYWORDS_JSON` | `[]` | фильтр по словам; пустой — отправлять всё |
| `LOOKBACK_MINUTES` | `70` | окно свежести постов |
| `MAX_POSTS_PER_CHANNEL` | `50` | максимум постов за запуск |
| `SQLITE_RETENTION_DAYS` | `60` | сколько хранить записи об отправленном |
| `REQUEST_TIMEOUT_MS` | `7000` | таймаут HTTP-запросов |
| `TELEGRAM_PROXY_URL` | — | HTTP-прокси вне РФ для запросов к t.me (`http://user:pass@host:port`); без него — напрямую |
| `RELAY_URL` | — | адрес relay: `https://relay.example.com/v1/request` (или `http://IP:ПОРТ/v1/request`); приоритетнее прокси |
| `RELAY_TOKEN` | — | токен relay (`RELAY_SERVICE_TOKEN` с сервера; хранить в Lockbox) |
| `VVELCOM_TIMEOUT_MS` | `45000` | таймаут запросов к VVelcom (загрузка фото/видео по ссылке дольше обычного; таймаут функции должен быть больше) |
| `SQLITE_PATH` | `/function/storage/…` | путь к файлу SQLite |

## Если t.me недоступен из Yandex Cloud: relay

Сеть Yandex Cloud может не пускать к `t.me` (в логе `diag_tcp` — `timeout`). Тогда запросы к Telegram идут через relay — маленький HTTP-сервис [restricted_relay.py](restricted_relay.py) на сервере, у которого доступ к Telegram есть. Функция шлёт relay `POST /v1/request` с токеном, relay делает HTTPS-запрос и возвращает текст страницы. Посты и отправка в VVelcom не меняются.

Защита relay: только `https://` на порт 443, только домены из `ALLOWED_HOSTS` (и поддомены), без IP в URL, запрет внутренних адресов, подключение к уже проверенному IP (защита от DNS rebinding), без редиректов, лимиты на размер и время, rate limit 60 запросов в минуту, токен через `Authorization: Bearer`.

### Установка relay на сервер (Debian/Ubuntu, от root)

```bash
useradd --system --home /home --shell /usr/sbin/nologin relay
apt-get update && apt-get install -y python3-flask gunicorn

# файлы лежат в /home: restricted_relay.py, relay.env (из relay.env.example)
cp restricted_relay.py /home/restricted_relay.py
cp relay.env.example /home/relay.env
nano /home/relay.env        # задайте RELAY_SERVICE_TOKEN: openssl rand -hex 32

chown relay:relay /home/restricted_relay.py /home/relay.env
touch /home/relay.log && chown relay:relay /home/relay.log
chmod 600 /home/relay.env && chmod 640 /home/relay.log

python3 -m py_compile /home/restricted_relay.py
cp simple-relay.service /etc/systemd/system/simple-relay.service
systemctl daemon-reload
systemctl enable --now simple-relay
systemctl status simple-relay --no-pager
```

### Проверка

```bash
ss -ltnp 'sport = :9010'                 # gunicorn на 127.0.0.1:9010
curl -sS 'http://127.0.0.1:9010/healthz'; echo

TOKEN="$(sed -n 's/^RELAY_SERVICE_TOKEN=//p' /home/relay.env | head -n 1)"
curl --http1.1 -sS 'http://127.0.0.1:9010/v1/request'   -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json'   --data-binary '{"url":"https://t.me/s/bmpd_cast","method":"GET"}' | head -c 400; echo
unset TOKEN

tail -n 30 /home/relay.log
journalctl -u simple-relay -n 50 --no-pager
```

### Доступ для функции

Relay слушает только `127.0.0.1:9010`. Чтобы функция из Yandex Cloud до него достучалась, поставьте перед ним обратный прокси с HTTPS (nginx или Caddy) и в `RELAY_URL` указывайте его адрес. Токен по голому `http://` передавать не стоит: его можно перехватить.

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate / ssl_certificate_key — например, от certbot
    location / {
        proxy_pass http://127.0.0.1:9010;
        proxy_set_header Host $host;
    }
}
```

Если без HTTPS не обойтись, ограничьте порт файрволом только IP функции.

### Обновление relay после правки кода

```bash
cp restricted_relay.py /home/restricted_relay.py && python3 -m py_compile /home/restricted_relay.py && systemctl restart simple-relay && sleep 1 && curl -sS 'http://127.0.0.1:9010/healthz' && echo && tail -n 10 /home/relay.log
```

При каждом изменении кода меняйте `APP_VERSION` в `restricted_relay.py` — версия и хеш файла пишутся в лог при запуске и видны в `/healthz`.

## Контекст в чате: пост и комментарий

Бот получает от VVelcom не только вопрос, но и контекст (см. раздел «Контекст сообщения» в [документации Bot API](../../docs/api/bot-api.md)):

- `comment_to_message.text` — пост канала, под которым написан комментарий;
- `reply_to_message.text` — комментарий, на который ответил пользователь (автор не передаётся; `from_bot: true`, если ответили на сообщение самого бота).

Функция собирает из них запрос к GigaChat блоками «Пост канала» / «Комментарий, на который отвечают» / «Вопрос пользователя». Так можно ответить на комментарий под постом, не повторяя в нём, о чём речь: ответьте (reply) на нужный комментарий и упомяните `@бота`. Историю переписки бот не хранит, лишние токены не тратятся. `CHAT_DEBUG=true` на время отладки пишет в лог всё сообщение из события.

## Ограничение расхода токенов

| Переменная | По умолчанию | Что ограничивает |
|---|---|---|
| `CHAT_MAX_TOKENS` | `500` | длину ответа в чате |
| `CHAT_MAX_INPUT_CHARS` | `1500` | вопрос и каждый блок контекста (пост, цитата), уходящие в модель |
| `CHAT_USER_LIMIT_PER_HOUR` | `10` | вопросов в час от одного пользователя (`0` — без лимита) |
| `CHAT_DAILY_TOKEN_LIMIT` | `0` (выкл.) | суточный бюджет токенов на чат по `usage` из ответов GigaChat |
| `AI_FILTER_MAX_CHARS` | `2000` | длину поста, отправляемого ИИ-фильтру |

Каждый вызов пишет в лог `gigachat_call` с `tokens`, `promptTokens`, `completionTokens` и `spentToday`; остаток по ключу — команда `/balance`. Счётчики лимитов хранятся в памяти контейнера и обнуляются при его холодном старте, поэтому это защита от «улёта», а не точная квота. Для строгого учёта нужно постоянное хранилище.

## Как отвечает чат: асинхронный вызов

VVelcom ждёт ответ вебхука 10 секунд, а GigaChat может отвечать дольше. Поэтому вебхук не ждёт модель: он проверяет секрет, отправляет заглушку «Думаю…» и запускает **эту же функцию асинхронно** (`POST https://functions.yandexcloud.net/<id>?integration=async`, ответ `202`) с задачей «ответить на вопрос», после чего сразу отвечает VVelcom `200`. Асинхронный вызов получает ответ GigaChat (до `CHAT_ANSWER_TIMEOUT_MS`), удаляет «Думаю…» и отправляет ответ. Если запустить асинхронный вызов не вышло (в логе `chat_async_dispatch_failed` или `chat_async_dispatch` со статусом не 2xx), бот отвечает прямо в окне вебхука, как раньше. Таймаут функции должен быть больше `CHAT_ANSWER_TIMEOUT_MS` на 5 с.
