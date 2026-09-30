# ИИ-бот на Yandex Cloud Functions

Рекомендуемый серверный пример: VVelcom отправляет события на webhook публичной Yandex Cloud Function, функция задаёт вопрос YandexGPT и возвращает ответ пользователю через Bot API.

Команды бота:

- `/start` — приветствие;
- `/help` — справка;
- `/ask вопрос` — вопрос модели;
- `/about` — информация об обработке сообщения.

Обычный текст без команды также отправляется модели. Пример не хранит историю: каждый вопрос независим. Вариант с историей потребует YDB или другого постоянного хранилища.

## 1. Создайте бота VVelcom

1. Откройте [@VVbotMother](https://uvvel.com/@VVbotMother).
2. Отправьте `/newbot` и получите токен `vv_…`.
3. Сохраните токен: он понадобится как `VVELCOM_BOT_TOKEN`.

## 2. Подготовьте Yandex Cloud

1. Создайте каталог и сервисный аккаунт.
2. Назначьте сервисному аккаунту роль `ai.languageModels.user` на каталог.
3. Создайте API-ключ с областью `yc.ai.foundationModels.execute` или `yc.ai.languageModels.execute`.
4. Сохраните API-ключ и идентификатор каталога.

Документация: [сервисные аккаунты](https://yandex.cloud/ru/docs/iam/concepts/users/service-accounts), [API-ключи](https://yandex.cloud/ru/docs/iam/concepts/authorization/api-key).

## 3. Создайте функцию

Установите и настройте Yandex Cloud CLI, затем из этой папки выполните:

```bash
yc serverless function create --name vvelcom-yandex-ai-bot

yc serverless function version create \
  --function-name vvelcom-yandex-ai-bot \
  --runtime python312 \
  --entrypoint index.handler \
  --memory 256MB \
  --execution-timeout 15s \
  --source-path . \
  --environment VVELCOM_BOT_TOKEN='vv_…' \
  --environment VVELCOM_WEBHOOK_SECRET='придумайте_случайную_строку' \
  --environment YANDEX_CLOUD_API_KEY='ваш_api_ключ' \
  --environment YANDEX_CLOUD_FOLDER_ID='идентификатор_каталога'

yc serverless function allow-unauthenticated-invoke vvelcom-yandex-ai-bot
```

Для рабочего проекта секреты лучше подключить из Yandex Lockbox через параметры `--secret`, а не хранить в истории командной строки.

Получите идентификатор функции:

```bash
yc serverless function get vvelcom-yandex-ai-bot
```

Webhook URL имеет вид:

```text
https://functions.yandexcloud.net/<FUNCTION_ID>
```

## 4. Подключите webhook и команды

```bash
export VVELCOM_BOT_TOKEN='vv_…'
export WEBHOOK_URL='https://functions.yandexcloud.net/<FUNCTION_ID>'
export WEBHOOK_SECRET='та_же_случайная_строка'

curl -X POST "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK_URL\",\"secret_token\":\"$WEBHOOK_SECRET\",\"drop_pending_updates\":false}"

curl -X POST "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"start","description":"Начать работу"},
    {"command":"help","description":"Показать справку"},
    {"command":"ask","description":"Задать вопрос YandexGPT"},
    {"command":"about","description":"Как работает бот"}
  ]}'
```

Проверьте подключение:

```bash
curl "https://apibots.vvelcom.online/bot$VVELCOM_BOT_TOKEN/getWebhookInfo"
```

После этого откройте бота в VVelcom, нажмите «Начать» и отправьте `/ask Что такое облачная функция?`.

## Куда развивать бота дальше

Yandex Cloud Functions здесь отвечает только за запуск кода по webhook. Саму ИИ-часть можно развивать в **Yandex AI Studio** — платформе Yandex Cloud для создания приложений, ассистентов и AI-агентов.

Возможные направления:

- выбрать другую доступную модель из Model Gallery и заменить `YANDEX_MODEL_URI` без изменения Bot API VVelcom;
- подготовить собственный датасет и дообучить поддерживаемую модель под стиль ответов, классификацию обращений, извлечение данных или нужный формат результата;
- подключить AI Assistant с поисковым индексом по собственной базе знаний, документам или справке компании;
- собрать агента в Agent Atelier и дать ему инструменты: поиск, внутренние API, MCP-серверы, CRM, календарь или систему заявок;
- разделить агентов по ролям: поддержка, продажи, редактор канала, помощник команды;
- подключить YDB для истории диалогов, пользовательских настроек и защиты от повторной обработки событий.

Важно различать два сценария. Дообучение помогает закрепить стиль, формат ответа, классификацию и извлечение сущностей, но не является лучшим способом загрузить постоянно обновляемую базу знаний. Для фактов, документов и инструкций лучше использовать поисковый индекс или другой RAG-сценарий, чтобы бот получал актуальные материалы во время запроса.

Таким образом, VVelcom-часть остаётся прежней: функция получает сообщение и отправляет ответ. Внутри вместо прямого запроса к `yandexgpt/latest` можно вызывать дообученную модель, ассистента или полноценного агента — дальше всё зависит от задачи и фантазии разработчика.

Подробнее: [Yandex AI Studio](https://yandex.cloud/ru/docs/ai-studio/), [дообучение моделей](https://yandex.cloud/ru/docs/ai-studio/concepts/tuning/).

## Группы и каналы

- В группе добавьте бота участником. Он сможет отвечать на команды, упоминания и ответы на свои сообщения.
- В канале бот может публиковать текст через `sendMessage`, но этот ИИ-пример не отвечает на `channel_post` автоматически.

## Важные ограничения

- VVelcom ждёт ответ webhook не более 10 секунд. В коде вызовы YandexGPT и Bot API ограничены восемью секундами. Если генерация регулярно занимает дольше, используйте очередь: webhook-функция быстро сохраняет задачу и отвечает `200`, а отдельная функция-обработчик вызывает модель.
- При `5xx` VVelcom повторит событие. Для production храните обработанные `update_id` в YDB, чтобы исключить повторные ответы.
- Тексты пользователей передаются в Yandex Cloud. Отразите это в описании бота и документах об обработке данных.
- Запросы к модели и выполнение функции могут тарифицироваться.
- Публичность функции нужна только для входящего webhook; запрос дополнительно защищён `VVELCOM_WEBHOOK_SECRET`.
