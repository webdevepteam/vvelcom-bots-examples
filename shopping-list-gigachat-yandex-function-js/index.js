/*
  Бот «Списки» для VVelcom: Yandex Cloud Functions (Node.js 22), без зависимостей.

  - Голосовое или текст → распознавание (метод transcribeVoice) → GigaChat → список-чекбоксы.
    Какие списки вести (покупки, дела, что угодно) — задаёт промпт в переменных окружения
    (BOT_PROMPT), модель сама определяет, какой это список.
  - В группе бота зовут ответом (reply) на голосовое с «@бот», голосовым ответом на сообщение
    бота, текстом с «@бот» или командой /add. В личном чате — просто голосовым или текстом.
  - Ключ GigaChat, модель, промпт и справка — в переменных окружения функции, настроек в самом
    боте нет. Можно ограничить бота своими чатами (ALLOWED_CHAT_IDS).
  - Данные — JSON-файлы в папке DATA_DIR (бакет Object Storage, примонтированный к функции).
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

const {
  VVELCOM_BOT_TOKEN,
  VVELCOM_WEBHOOK_SECRET,
  GIGACHAT_AUTH_KEY,
  GIGACHAT_SCOPE = '',
  GIGACHAT_MODEL = 'GigaChat',
  GIGACHAT_CA_PATH = './russian_trusted_root_ca.pem',
  GIGACHAT_INSECURE_TLS,
  GIGACHAT_TIMEOUT_MS = '30000',
  BOT_PROMPT = '',
  BOT_PROMPT_FILE = '',
  BOT_ABOUT = '',
  ALLOWED_CHAT_IDS = '',
  DATA_DIR = '/function/storage/shopping',
  BOT_USERNAME = '',
  TIME_ZONE = 'Europe/Moscow',
  LIST_MAX_TOKENS = '1500',
  LISTS_KEEP = '10'
} = process.env;

const VVELCOM_API_BASE = 'https://apibots.vvelcom.online';
const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const GIGACHAT_API_URL = 'https://gigachat.devices.sberbank.ru/api/v1';
const GIGACHAT_SCOPES = ['GIGACHAT_API_PERS', 'GIGACHAT_API_B2B', 'GIGACHAT_API_CORP'];

// Ограничения кнопок VVelcom: до 20 рядов, текст кнопки до 64 символов.
const MAX_KEYBOARD_ROWS = 20;
const MAX_BUTTON_TEXT = 60;
const MAX_ITEMS = 40;
// Сколько списков чата хранится: более старые удаляются вместе с файлами.
const KEEP_LISTS = Math.max(1, Number(LISTS_KEEP) || 10);
// Сколько последних списков модель видит, чтобы понять, какой из них менять.
const LISTS_IN_PROMPT = 3;
const WEBHOOK_BUDGET_MS = 9300;
const TASK = 'lists_task';
const DEFAULT_TITLE = 'Список';
const DEFAULT_EMOJI = '📝';

const COMMANDS = [
  { command: 'add', description: 'Составить или изменить список: /add молоко, хлеб' },
  { command: 'list', description: 'Последний список' },
  { command: 'lists', description: `Последние ${KEEP_LISTS} списков` },
  { command: 'stats', description: 'Расход токенов GigaChat' },
  { command: 'help', description: 'Что умеет бот' }
];

/*
  Что за списки ведёт бот — меняется переменной BOT_PROMPT (или файлом BOT_PROMPT_FILE),
  без правки кода. Здесь — значение по умолчанию: покупки и дела для семьи.
*/
const DEFAULT_PROMPT = `Ты помощник семьи в общем чате: ведёшь списки покупок и списки дел.
- Покупки (продукты, вещи, лекарства — всё, что надо купить) — список «Список покупок», эмодзи 🛒. В note — количество с единицами («2 шт», «1 кг», «3 пачки»).
- Дела (что сделать, позвонить, оплатить, записаться, починить) — список «Список дел», эмодзи 📋. В note — срок или кто делает («до пятницы», «папа»), если сказано.
- Если в одной просьбе и покупки, и дела — раздели их на два списка.`;

const DEFAULT_ABOUT = '📝 Я веду общие списки — покупок и дел — из голосовых и текстовых сообщений. Отмечайте сделанное прямо в списке.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(level, action, data = {}) {
  console.log(JSON.stringify({ level, action, ...data }));
}

// Промпт: файл (для длинных текстов — у переменных функции общий лимит 4 КБ) или переменная.
const botPrompt = (() => {
  if (BOT_PROMPT_FILE) {
    try {
      return fs.readFileSync(path.resolve(import.meta.dirname, BOT_PROMPT_FILE), 'utf8').trim();
    } catch (error) {
      log('ERROR', 'prompt_file_missing', { path: BOT_PROMPT_FILE, error: error.message });
    }
  }

  return BOT_PROMPT.replace(/\\n/g, '\n').trim() || DEFAULT_PROMPT;
})();
const botAbout = BOT_ABOUT.replace(/\\n/g, '\n').trim() || DEFAULT_ABOUT;
const allowedChats = new Set(ALLOWED_CHAT_IDS.split(/[\s,;]+/).filter(Boolean));

const isAllowed = (chatId) => allowedChats.size === 0 || allowedChats.has(String(chatId));

/* ───────────── VVelcom Bot API ───────────── */

async function vv(method, payload = {}, timeoutMs = 15_000) {
  const response = await fetch(`${VVELCOM_API_BASE}/bot${VVELCOM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));

  if (!data.ok) {
    const error = new Error(`${method}: ${data.description || `HTTP ${response.status}`}`);
    error.status = data.error_code || response.status;
    throw error;
  }

  return data.result;
}

// sendMessage возвращает сообщение; длинный текст — массив сообщений.
const messageIdOf = (result) => (Array.isArray(result) ? result[0] : result)?.id ?? null;

async function send(chatId, text, extra = {}) {
  return messageIdOf(await vv('sendMessage', { chat_id: chatId, text, ...extra }));
}

async function quietly(promise) {
  try {
    return await promise;
  } catch (error) {
    log('WARN', 'vv_call_failed', { error: error.message });
    return null;
  }
}

let botUsername = BOT_USERNAME.replace(/^@/, '');

async function getBotUsername() {
  if (!botUsername) {
    botUsername = (await quietly(vv('getMe')))?.username || '';
  }

  return botUsername;
}

/* ───────────── Хранилище: JSON-файлы в DATA_DIR ───────────── */

const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');

async function readJson(relative, fallback) {
  try {
    return JSON.parse(await fsp.readFile(path.join(DATA_DIR, relative), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('WARN', 'storage_read_failed', { file: relative, error: error.message });
    }

    return fallback;
  }
}

async function writeJson(relative, data) {
  const file = path.join(DATA_DIR, relative);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(temp, JSON.stringify(data, null, 1));
  await fsp.rename(temp, file);
}

const STATS_FILE = 'stats.json';
const chatFile = (chatId) => `chats/${safeName(chatId)}/chat.json`;
const listFile = (chatId, listId) => `chats/${safeName(chatId)}/lists/${safeName(listId)}.json`;

const loadChat = async (chatId) => readJson(chatFile(chatId), { id: chatId, lists: [] });
const saveChat = (chat) => writeJson(chatFile(chat.id), chat);
const loadList = (chatId, listId) => readJson(listFile(chatId, listId), null);
const saveList = (list) => writeJson(listFile(list.chatId, list.id), list);

/* ───────────── Статистика токенов ───────────── */

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(date); // YYYY-MM-DD
}

function addUsage(usage = {}, tokens, model) {
  const day = dayKey();
  const days = { ...(usage.days || {}), [day]: (usage.days?.[day] || 0) + tokens };

  // Храним по дням два месяца — этого хватает для «сегодня» и «за месяц».
  for (const key of Object.keys(days).sort().slice(0, -62)) {
    delete days[key];
  }

  return {
    total: (usage.total || 0) + tokens,
    requests: (usage.requests || 0) + 1,
    days,
    models: { ...(usage.models || {}), [model]: (usage.models?.[model] || 0) + tokens }
  };
}

function usageLines(usage = {}) {
  const today = dayKey();
  const month = today.slice(0, 7);
  const monthTotal = Object.entries(usage.days || {})
    .filter(([day]) => day.startsWith(month))
    .reduce((sum, [, tokens]) => sum + tokens, 0);
  const number = (value) => Number(value || 0).toLocaleString('ru-RU');
  const lines = [
    `Сегодня: ${number(usage.days?.[today])}`,
    `В этом месяце: ${number(monthTotal)}`,
    `Всего: ${number(usage.total)} (запросов: ${number(usage.requests)})`
  ];
  const models = Object.entries(usage.models || {});

  if (models.length > 1) {
    lines.push('По моделям:', ...models.map(([model, tokens]) => `• ${model}: ${number(tokens)}`));
  }

  return lines;
}

/* ───────────── GigaChat ───────────── */

const gigachatInsecure = GIGACHAT_INSECURE_TLS === 'true';
const gigachatCa = (() => {
  if (gigachatInsecure || !GIGACHAT_CA_PATH) {
    return null;
  }

  try {
    return fs.readFileSync(path.resolve(import.meta.dirname, GIGACHAT_CA_PATH), 'utf8');
  } catch (error) {
    log('WARN', 'gigachat_ca_missing', { path: GIGACHAT_CA_PATH, error: error.message });
    return null;
  }
})();

// node:https, а не fetch: из Yandex Cloud запросы undici к Сберу зависали (см. пример с кросспостом).
function gigachatFetch(url, { method = 'GET', headers = {}, body = null } = {}, timeoutMs = Number(GIGACHAT_TIMEOUT_MS)) {
  const target = new URL(url);
  const payload = body === null ? null : Buffer.from(body);

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: { Accept: 'application/json', ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
      timeout: timeoutMs,
      ...(gigachatCa ? { ca: gigachatCa } : {}),
      ...(gigachatInsecure ? { rejectUnauthorized: false } : {})
    }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;

        try {
          json = JSON.parse(text);
        } catch {
          // не JSON — оставляем текст для сообщения об ошибке
        }

        resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, text, json });
      });
    });

    request.on('timeout', () => request.destroy(new Error(`Таймаут ${timeoutMs} мс: ${target.hostname}`)));
    request.on('error', reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

// Токен доступа живёт 30 минут — кэшируем в памяти контейнера.
let accessToken = null;
let detectedScope = GIGACHAT_SCOPE;

async function requestAccessToken(scope) {
  const response = await gigachatFetch(GIGACHAT_OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${GIGACHAT_AUTH_KEY}`,
      RqUID: crypto.randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ scope }).toString()
  }, 10_000);

  if (!response.ok || !response.json?.access_token) {
    const error = new Error(`GigaChat OAuth HTTP ${response.status}: ${response.text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }

  return {
    value: response.json.access_token,
    expiresAt: Number(response.json.expires_at) || Date.now() + 25 * 60_000
  };
}

async function getAccessToken() {
  if (accessToken && accessToken.expiresAt - 60_000 > Date.now()) {
    return accessToken.value;
  }

  if (detectedScope) {
    accessToken = await requestAccessToken(detectedScope);
    return accessToken.value;
  }

  // GIGACHAT_SCOPE не задан: ключ подходит к одному scope — физлицо, ИП/юрлицо или корпоративный.
  let lastError = null;

  for (const scope of GIGACHAT_SCOPES) {
    try {
      accessToken = await requestAccessToken(scope);
      detectedScope = scope;
      log('INFO', 'gigachat_scope_detected', { scope });
      return accessToken.value;
    } catch (error) {
      lastError = error;

      // Сетевая ошибка — перебирать дальше бессмысленно.
      if (!error.status) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function getBalance() {
  const token = await getAccessToken();
  const response = await gigachatFetch(`${GIGACHAT_API_URL}/balance`, { headers: { Authorization: `Bearer ${token}` } }, 10_000);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json?.balance || [];
}

// Запрос к модели; расход пишется в статистику чата и в общую.
async function askGigachat(messages, { chatId = null, maxTokens = Number(LIST_MAX_TOKENS) } = {}) {
  const token = await getAccessToken();
  const response = await gigachatFetch(`${GIGACHAT_API_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GIGACHAT_MODEL, messages, temperature: 0.1, max_tokens: maxTokens })
  });

  if (!response.ok) {
    const error = new Error(`GigaChat HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }

  const tokens = Number(response.json?.usage?.total_tokens) || 0;
  const model = response.json?.model || GIGACHAT_MODEL;

  log('INFO', 'gigachat_call', { model, tokens, chatId });

  if (tokens > 0) {
    const stats = await readJson(STATS_FILE, {});
    await writeJson(STATS_FILE, { ...stats, usage: addUsage(stats.usage, tokens, model) });

    if (chatId) {
      const chat = await loadChat(chatId);
      await saveChat({ ...chat, usage: addUsage(chat.usage, tokens, model) });
    }
  }

  return response.json?.choices?.[0]?.message?.content || '';
}

/* ───────────── Списки ───────────── */

function newListId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

function formatDate(iso) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(iso));
}

const shortDate = (iso) => new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
}).format(new Date(iso));

const itemLabel = (item) => (item.qty ? `${item.name} — ${item.qty}` : item.name);
// Списки, сохранённые до появления видов, — это списки покупок.
const listTitle = (list) => list.title || 'Список покупок';
const listEmoji = (list) => list.emoji || '🛒';

function cut(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Сообщение-чекбоксы: каждая позиция — кнопка, нажатие отмечает «готово».
function renderList(list) {
  const done = list.items.filter((item) => item.done).length;
  const shown = list.items.slice(0, MAX_ITEMS);
  const hidden = list.items.slice(MAX_ITEMS);
  const lines = [`${listEmoji(list)} ${listTitle(list)} от ${formatDate(list.createdAt)}`];

  if (list.basedOnAt) {
    lines.push(`На основе списка от ${formatDate(list.basedOnAt)}`);
  } else if (list.updatedAt && list.updatedAt !== list.createdAt) {
    // Списки, изменённые на месте до того, как правка стала создавать новый список.
    lines.push(`Изменён ${formatDate(list.updatedAt)}`);
  }

  lines.push('', list.items.length > 0 && done === list.items.length
    ? '✅ Всё готово!'
    : `Готово: ${done} из ${list.items.length}. Нажмите на пункт, чтобы отметить.`);

  if (hidden.length > 0) {
    lines.push('', 'Не поместились в кнопки:', ...hidden.map((item) => `${item.done ? '✅' : '⬜'} ${itemLabel(item)}`));
  }

  const buttons = shown.map((item) => ({
    text: cut(`${item.done ? '✅' : '⬜'} ${itemLabel(item)}`, MAX_BUTTON_TEXT),
    callback_data: `t:${list.id}:${item.id}`
  }));
  // До 20 пунктов — по одному в ряд, больше — по два (лимит 20 рядов).
  const perRow = buttons.length > MAX_KEYBOARD_ROWS ? 2 : 1;
  const keyboard = [];

  for (let index = 0; index < buttons.length; index += perRow) {
    keyboard.push(buttons.slice(index, index + perRow));
  }

  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: keyboard }
  };
}

// Отправляет список в чат и запоминает сообщение, чтобы обновлять его вместе с остальными копиями.
async function postList(list, extra = {}) {
  const view = renderList(list);
  const messageId = await send(list.chatId, view.text, { reply_markup: view.reply_markup, ...extra });

  if (messageId) {
    const fresh = (await loadList(list.chatId, list.id)) || list;
    await saveList({ ...fresh, messageIds: [...(fresh.messageIds || []), messageId].slice(-5) });
  }

  return messageId;
}

// Обновляет все показанные копии списка (кроме уже обновлённой `skipId`).
async function refreshListMessages(list, skipId = null) {
  const view = renderList(list);

  for (const messageId of list.messageIds || []) {
    if (messageId !== skipId) {
      await quietly(vv('editMessageText', { chat_id: list.chatId, message_id: messageId, ...view }));
    }
  }
}

function normalizeName(name) {
  return String(name).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}

function cleanItems(raw) {
  const seen = new Set();
  const items = [];

  for (const entry of Array.isArray(raw) ? raw : []) {
    const name = cut(String(typeof entry === 'string' ? entry : entry?.name || '').trim(), 80);
    const note = typeof entry === 'object' && entry ? entry.note ?? entry.qty : '';
    const qty = cut(String(note || '').trim(), 30);
    const key = normalizeName(name);

    if (name && !seen.has(key)) {
      seen.add(key);
      items.push({ name, qty });
    }
  }

  return items.slice(0, 100);
}

function cleanTitle(raw) {
  return cut(String(raw || '').replace(/\s+/g, ' ').trim(), 40) || DEFAULT_TITLE;
}

// Одна «картинка»-эмодзи (без текста), иначе — эмодзи по умолчанию.
function cleanEmoji(raw) {
  const value = String(raw || '').trim();
  return value && value.length <= 8 && /\p{Extended_Pictographic}/u.test(value) && !/[\p{L}\p{N}]/u.test(value) ? value : DEFAULT_EMOJI;
}

/*
  Список не меняется задним числом: и новый список, и правка («добавь», «убери», «начни заново»)
  сохраняются новым списком, а прежний остаётся в истории. В чате хранятся KEEP_LISTS последних
  списков, более старые удаляются.
*/
async function saveNewList(chatId, authorId, { title, emoji, items }, sourceText, basedOn = null) {
  const now = new Date().toISOString();
  const list = {
    id: newListId(),
    chatId,
    title: cleanTitle(title),
    emoji: cleanEmoji(emoji),
    createdAt: now,
    authorId,
    items: items.map((item, index) => ({ id: index + 1, name: item.name, qty: item.qty, done: Boolean(item.done) })),
    source: cut(sourceText, 2000),
    ...(basedOn ? { basedOn: basedOn.id, basedOnAt: basedOn.createdAt } : {}),
    messageIds: []
  };
  const chat = await loadChat(chatId);
  const entries = [{ id: list.id, title: list.title, emoji: list.emoji, createdAt: now, count: list.items.length }, ...(chat.lists || [])];

  await saveList(list);
  await saveChat({ ...chat, lists: entries.slice(0, KEEP_LISTS) });

  for (const old of entries.slice(KEEP_LISTS)) {
    await fsp.rm(path.join(DATA_DIR, listFile(chatId, old.id)), { force: true }).catch((error) => {
      log('WARN', 'list_delete_failed', { chatId, listId: old.id, error: error.message });
    });
  }

  return list;
}

const createList = (chatId, authorId, op, sourceText) =>
  saveNewList(chatId, authorId, { ...op, items: cleanItems(op.items).map((item) => ({ ...item, done: false })) }, sourceText);

// Новый список на основе прежнего: отметки «готово» переходят к пунктам с тем же названием,
// если не просили начать заново (`reset`).
function deriveList(chatId, authorId, source, op, sourceText) {
  const old = new Map(source.items.map((item) => [normalizeName(item.name), item]));
  const items = cleanItems(op.items).map((item) => ({
    ...item,
    done: !op.reset && Boolean(old.get(normalizeName(item.name))?.done)
  }));

  return saveNewList(chatId, authorId, {
    title: op.title || listTitle(source),
    emoji: op.emoji || listEmoji(source),
    items
  }, sourceText, source);
}

async function recentLists(chatId, count = KEEP_LISTS) {
  const chat = await loadChat(chatId);
  const lists = [];

  for (const entry of (chat.lists || []).slice(0, count)) {
    const list = await loadList(chatId, entry.id);

    if (list) {
      lists.push(list);
    }
  }

  return lists;
}

// Список, на сообщение с которым ответили (свайп по списку от бота).
async function listByMessage(chatId, messageId) {
  if (!messageId) {
    return null;
  }

  return (await recentLists(chatId)).find((list) => (list.messageIds || []).includes(messageId)) || null;
}

async function lastList(chatId) {
  return (await recentLists(chatId, 1))[0] || null;
}

/* ───────────── Разбор просьбы моделью ───────────── */

// Формат ответа зашит в коде (по нему бот разбирает ответ); что за списки — в BOT_PROMPT.
const RESPONSE_FORMAT = `Тебе приходит просьба пользователя: расшифровка голосового сообщения (в ней возможны ошибки распознавания) или текст. Реши, что сделать со списками, и ответь СТРОГО одним JSON-объектом без пояснений и без markdown:
{"ops":[{"action":"new"|"edit","list":1,"reset":false,"title":"Название списка","emoji":"📝","items":[{"name":"Пункт","note":""}]}],"comment":"короткая фраза для пользователя"}
Правила:
- "new" — новый список с нуля. title — его короткое название (какой это список), emoji — один подходящий эмодзи. items — все пункты из просьбы.
- "edit" — новый список на основе одного из списков ниже: добавить, убрать, заменить, исправить («добавь», «убери», «ещё», «не надо», «вместо», «возьми этот список», «повтори», «на основе этого»). list — номер этого списка из перечня ниже. items — ПОЛНЫЙ итоговый состав; неизменные пункты перепиши как есть. title и emoji для "edit" можно не указывать (останутся прежние), укажи их, только если просят другой список (например, «сделай из него список дел»).
- reset (только для "edit"): true — если просят начать заново, обнулить, снять все отметки, повторить список как новый («сделай нулевым», «сбрось галочки», «закажем то же самое снова»); иначе false — отмеченные пункты останутся отмеченными.
- Если пользователь ответил на конкретный список, он помечен в перечне «ОТВЕТИЛИ НА ЭТОТ СПИСОК» — менять нужно его.
- Если подходящего списка нет, вместо "edit" используй "new".
- В ops может быть несколько операций, если просьба касается разных списков.
- Если просьба не про списки — ops пустой, в comment — короткий ответ.
- name — с заглавной буквы, коротко, без уточнений; note — уточнение к пункту или пустая строка.
- Исправляй очевидные ошибки распознавания («малако» → «Молоко»). Объединяй повторы.`;

const systemPrompt = () => `${botPrompt}\n\n${RESPONSE_FORMAT}`;

// `lists[0]` — список, на который ответили, если `replied`.
function buildListPrompt(request, lists, replied = false) {
  const current = lists.length > 0
    ? `Последние списки:\n${lists.map((list, index) => [
      `${index + 1}. ${listTitle(list)} (от ${formatDate(list.createdAt)})${replied && index === 0 ? ' — ОТВЕТИЛИ НА ЭТОТ СПИСОК' : ''}:`,
      ...list.items.map((item) => `   - ${item.done ? '[x]' : '[ ]'} ${itemLabel(item)}`)
    ].join('\n')).join('\n')}`
    : 'Списков пока нет.';

  return `${current}\n\nПросьба пользователя:\n${request}`;
}

function parseModelJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start < 0 || end <= start) {
    return null;
  }

  let data;

  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  // Старый одиночный формат { action, items } тоже принимаем.
  const rawOps = Array.isArray(data.ops) ? data.ops : data.action ? [data] : null;

  if (!rawOps) {
    return null;
  }

  const ops = rawOps
    .filter((op) => op && (op.action === 'new' || op.action === 'edit'))
    .map((op) => ({
      action: op.action,
      list: Number(op.list) || 1,
      reset: op.reset === true || op.reset === 'true',
      title: op.title,
      emoji: op.emoji,
      items: op.items
    }));

  return { ops, comment: typeof data.comment === 'string' ? data.comment : '' };
}

/* ───────────── Асинхронные задачи ───────────── */

/*
  Вебхук VVelcom ждёт ответ 10 секунд, а распознавание и GigaChat дольше. Поэтому вебхук
  запускает эту же функцию асинхронно (?integration=async) и сразу отвечает 200. Задача
  подписывается HMAC от секрета вебхука: функция публичная, чужую задачу она не выполнит.
*/
function signTask(payload) {
  return crypto.createHmac('sha256', String(VVELCOM_WEBHOOK_SECRET)).update(JSON.stringify(payload)).digest('hex');
}

function createDispatcher(context) {
  const functionId = context?.functionName || context?.functionId || process.env.FUNCTION_ID;

  return async (payload) => {
    if (functionId) {
      try {
        const response = await fetch(`https://functions.yandexcloud.net/${functionId}?integration=async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vvTask: TASK, payload, sig: signTask(payload) }),
          signal: AbortSignal.timeout(3000)
        });

        if (response.ok) {
          return;
        }

        log('WARN', 'async_dispatch_status', { status: response.status });
      } catch (error) {
        log('WARN', 'async_dispatch_failed', { error: error.message });
      }
    }

    // Не получилось запустить асинхронно — делаем прямо в вебхуке (VVelcom может прислать событие повторно).
    await runTask(payload);
  };
}

function parseTask(event) {
  let body = event;

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }

  if (!body || body.vvTask !== TASK || !body.payload || typeof body.sig !== 'string') {
    return null;
  }

  const expected = Buffer.from(signTask(body.payload));
  const actual = Buffer.from(body.sig);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? body.payload : null;
}

async function runTask(task) {
  try {
    if (task.kind === 'request') {
      await processRequest(task);
    } else if (task.kind === 'stats') {
      await sendStats(task.chatId);
    }
  } catch (error) {
    log('ERROR', 'task_failed', { kind: task.kind, error: error.message });
  }
}

/* ───────────── Голосовое / текст → список ───────────── */

async function transcribe(fileId) {
  // Метод ждёт до ~45 с; если распознавание ещё идёт — status: pending, спрашиваем снова.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await vv('transcribeVoice', { file_id: fileId }, 60_000);

    if (result.status === 'done') {
      return (result.text || '').trim();
    }

    await sleep(3000);
  }

  throw new Error('распознавание не успело завершиться');
}

async function processRequest({ chatId, fileId, text, placeholderId, replyToId, repliedMessageId, authorId }) {
  const finish = async (message) => {
    if (placeholderId) {
      const edited = await quietly(vv('editMessageText', { chat_id: chatId, message_id: placeholderId, text: message }));

      if (edited) {
        return;
      }
    }

    await quietly(send(chatId, message));
  };

  let request = text || '';

  if (fileId) {
    try {
      const heard = await transcribe(fileId);
      request = [heard, text].filter(Boolean).join('\n');
    } catch (error) {
      log('WARN', 'transcribe_failed', { error: error.message });
      await finish(/not recognised/i.test(error.message)
        ? '🙉 Не получилось разобрать речь. Попробуйте записать ещё раз.'
        : '🙉 Не получилось распознать голосовое, попробуйте чуть позже.');
      return;
    }
  }

  if (!request.trim()) {
    await finish('🙉 В сообщении нет слов — нечего добавить в список.');
    return;
  }

  // Ответили на список бота — он первый в перечне для модели, за ним последние.
  const replied = await listByMessage(chatId, repliedMessageId);
  const lists = [
    ...(replied ? [replied] : []),
    ...(await recentLists(chatId, LISTS_IN_PROMPT)).filter((list) => list.id !== replied?.id)
  ].slice(0, LISTS_IN_PROMPT + (replied ? 1 : 0));
  let decision;

  try {
    decision = parseModelJson(await askGigachat([
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: buildListPrompt(cut(request, 3000), lists, Boolean(replied)) }
    ], { chatId }));
  } catch (error) {
    log('ERROR', 'gigachat_failed', { error: error.message });
    await finish(error.status === 402
      ? '💸 Закончились токены GigaChat. Подробнее — /stats.'
      : '🤖 GigaChat не ответил, попробуйте ещё раз чуть позже.');
    return;
  }

  const heardLine = fileId ? `🎙 «${cut(request, 400)}»\n\n` : '';

  if (!decision) {
    await finish(`${heardLine}Не понял, что сделать со списком. Скажите, что добавить, или что изменить в последнем списке.`);
    return;
  }

  const results = [];
  const toPost = [];

  for (const op of decision.ops) {
    if (cleanItems(op.items).length === 0) {
      continue;
    }

    const target = op.action === 'edit' ? lists[op.list - 1] : null;

    if (target) {
      const derived = await deriveList(chatId, authorId, target, op, request);
      results.push(`✏️ ${listTitle(derived)}: новый на основе списка от ${shortDate(target.createdAt)}, ${derived.items.length} п.${op.reset ? ', отметки сброшены' : ''}`);
      toPost.push(derived);
    } else {
      const created = await createList(chatId, authorId, op, request);
      results.push(`${listEmoji(created)} ${listTitle(created)}: новый, ${created.items.length} п.`);
      toPost.push(created);
    }
  }

  if (toPost.length === 0) {
    await finish(`${heardLine}${decision.comment || 'Не нашёл, что добавить в список.'}`);
    return;
  }

  await finish(`${heardLine}${results.join('\n')}`);

  for (const list of toPost) {
    await postList(list, replyToId ? { reply_to_message_id: replyToId } : {});
  }
}

/* ───────────── Тексты ───────────── */

async function helpText(isPrivate) {
  const username = await getBotUsername();
  const mention = username ? `@${username}` : '@бот';
  const howTo = isPrivate
    ? [
      '• Запишите голосовое или напишите, что добавить: «купить молоко и хлеб, завтра позвонить врачу».',
      '• Добавьте меня в группу — списки станут общими для всех участников.'
    ]
    : [
      `• Запишите голосовое, а потом ответьте на него сообщением «${mention}». Или ответьте голосовым на любое моё сообщение.`,
      `• Текстом: «${mention} молоко, хлеб, 2 кг яблок» или /add молоко, хлеб.`
    ];

  return [
    botAbout,
    '',
    ...howTo,
    '• Изменить список — ответьте (свайп) на него голосом или текстом: «убери хлеб, добавь сыр». Получится новый список на его основе, отметки сохранятся. Скажите «начни заново» или «сбрось галочки» — отметки снимутся.',
    '• Без ответа на список меняется последний подходящий.',
    '• Отметить сделанное — нажмите на пункт в списке.',
    '',
    '/add <текст> — составить или изменить список',
    '/list — последний список',
    `/lists — последние ${KEEP_LISTS} списков (старые не хранятся)`,
    '/stats — расход токенов',
    '/help — эта справка'
  ].join('\n');
}

const noListsText = (isPrivate) => (isPrivate
  ? 'Списков пока нет. Запишите голосовое или напишите, что добавить.'
  : 'Списков пока нет. Запишите голосовое и ответьте на него, упомянув меня, или отправьте /add и текст.');

async function sendStats(chatId) {
  const chat = await loadChat(chatId);
  const stats = await readJson(STATS_FILE, {});
  const lines = [
    `📊 Расход токенов GigaChat (модель ${GIGACHAT_MODEL})`,
    '',
    'В этом чате:',
    ...usageLines(chat.usage),
    '',
    'Всего у бота:',
    ...usageLines(stats.usage),
    '',
    `Списков в этом чате: ${(chat.lists || []).length}`
  ];

  try {
    const balance = await getBalance();

    lines.push('', 'Остаток по ключу:', ...(balance.length > 0
      ? balance.map((item) => `• ${item.usage}: ${Number(item.value).toLocaleString('ru-RU')}`)
      : ['нет данных (баланс показывается для оплаченных пакетов)']));
  } catch (error) {
    lines.push('', `Остаток по ключу узнать не удалось (${error.message}).`);
  }

  await send(chatId, lines.join('\n'));
}

async function sendListIndex(chatId, isPrivate) {
  const chat = await loadChat(chatId);
  const recent = (chat.lists || []).slice(0, KEEP_LISTS);

  if (recent.length === 0) {
    await send(chatId, noListsText(isPrivate));
    return;
  }

  await vv('sendMessage', {
    chat_id: chatId,
    text: `🗂 Последние списки (${recent.length}). Нажмите, чтобы открыть:`,
    reply_markup: {
      inline_keyboard: recent.map((entry) => [{
        text: cut(`${listEmoji(entry)} ${listTitle(entry)} · ${shortDate(entry.createdAt)} · ${entry.count} п.`, MAX_BUTTON_TEXT),
        callback_data: `o:${entry.id}`
      }])
    }
  });
}

/* ───────────── Сообщения ───────────── */

function parseCommand(message) {
  const entity = (message.entities || []).find((item) => item.type === 'bot_command' && item.offset === 0);

  if (!entity) {
    return null;
  }

  const [name, target] = message.text.slice(1, entity.length).split('@');

  // «/list@другой_бот» — не нам.
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) {
    return '__other__';
  }

  return name.toLowerCase();
}

// Текст без упоминаний бота.
function stripMentions(message) {
  const text = message.text || '';
  const mentions = (message.entities || []).filter((item) => item.type === 'mention').sort((a, b) => b.offset - a.offset);
  let result = text;

  for (const mention of mentions) {
    result = result.slice(0, mention.offset) + result.slice(mention.offset + mention.length);
  }

  return result.replace(/\s+/g, ' ').trim();
}

// Текст после команды: «/add@бот молоко, хлеб» → «молоко, хлеб».
function commandArgument(message) {
  const entity = (message.entities || []).find((item) => item.type === 'bot_command' && item.offset === 0);
  return (message.text || '').slice(entity ? entity.length : 0).replace(/\s+/g, ' ').trim();
}

const accessDeniedText = (chatId) =>
  `🔒 Это частный бот. ID этого чата: ${chatId}\nЧтобы он здесь работал, владелец бота добавляет этот ID в переменную ALLOWED_CHAT_IDS.`;

async function handleMessage(message, dispatch) {
  const chatId = message.chat.id;
  const isPrivate = message.chat.type === 'private';
  await getBotUsername();
  const command = parseCommand(message);

  if (command === '__other__') {
    return;
  }

  // ID чата для ALLOWED_CHAT_IDS — отвечает везде, даже где бот закрыт.
  if (command === 'id') {
    await send(chatId, `ID этого чата: ${chatId}`);
    return;
  }

  if (!isAllowed(chatId)) {
    log('INFO', 'chat_not_allowed', { chatId, type: message.chat.type });
    await send(chatId, accessDeniedText(chatId));
    return;
  }

  if (command === 'start' || command === 'help') {
    if (command === 'start') {
      await quietly(vv('setMyCommands', { commands: COMMANDS }));
    }

    await send(chatId, await helpText(isPrivate));
    return;
  }

  if (command === 'list') {
    const list = await lastList(chatId);

    if (list) {
      await postList(list);
    } else {
      await send(chatId, noListsText(isPrivate));
    }

    return;
  }

  if (command === 'lists') {
    await sendListIndex(chatId, isPrivate);
    return;
  }

  if (command === 'stats') {
    await dispatch({ kind: 'stats', chatId });
    return;
  }

  if (command && command !== 'add') {
    await send(chatId, 'Не знаю такой команды. Справка — /help.');
    return;
  }

  // Голосовое: в самом сообщении (в личке или ответ голосом боту) или в том, на которое ответили с «@бот».
  const voice = message.voice || message.reply_to_message?.voice;
  const ownText = command === 'add' ? commandArgument(message) : stripMentions(message);
  const quoted = !voice && !message.reply_to_message?.from_bot ? (message.reply_to_message?.text || '').trim() : '';
  const text = [quoted, ownText].filter(Boolean).join('\n');

  if (!voice && !text) {
    await send(chatId, command === 'add' ? 'Напишите после /add, что добавить: /add молоко, хлеб' : await helpText(isPrivate));
    return;
  }

  const placeholderId = await send(chatId, voice ? '🎙 Слушаю голосовое…' : '📝 Разбираю…', { reply_to_message_id: message.id });

  await dispatch({
    kind: 'request',
    chatId,
    fileId: voice?.file_id || null,
    text,
    placeholderId,
    replyToId: message.id,
    // Свайп по списку бота: правка относится к этому списку.
    repliedMessageId: message.reply_to_message?.from_bot ? message.reply_to_message.id : null,
    authorId: message.from?.id || null
  });
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (!isAllowed(chatId)) {
    await vv('answerCallbackQuery', { callback_query_id: query.id, text: '🔒 Бот не работает в этом чате' });
    return;
  }

  if (data.startsWith('o:')) {
    const list = await loadList(chatId, data.slice(2));

    await vv('answerCallbackQuery', { callback_query_id: query.id, ...(list ? {} : { text: 'Список не найден' }) });

    if (list) {
      await postList(list);
    }

    return;
  }

  if (data.startsWith('t:')) {
    const [, listId, itemId] = data.split(':');
    const list = await loadList(chatId, listId);
    const item = list?.items.find((entry) => String(entry.id) === itemId);

    if (!item) {
      await vv('answerCallbackQuery', {
        callback_query_id: query.id,
        text: list ? 'Этого пункта уже нет в списке' : `Список уже не хранится (храню последние ${KEEP_LISTS})`
      });
      return;
    }

    item.done = !item.done;
    await saveList(list);
    await vv('answerCallbackQuery', { callback_query_id: query.id, text: `${item.done ? '✅' : '⬜'} ${cut(item.name, 150)}` });

    const view = renderList(list);
    await quietly(vv('editMessageText', { chat_id: chatId, message_id: query.message.id, ...view }));
    // Остальные показанные копии этого списка — в то же состояние.
    await refreshListMessages(list, query.message.id);
    return;
  }

  await vv('answerCallbackQuery', { callback_query_id: query.id });
}

async function handleMyChatMember(update) {
  const event = update.my_chat_member;

  if (event.chat?.type !== 'group' || event.new_status !== 'member') {
    return;
  }

  if (!isAllowed(event.chat.id)) {
    log('INFO', 'chat_not_allowed', { chatId: event.chat.id, type: 'group' });
    await send(event.chat.id, accessDeniedText(event.chat.id));
    return;
  }

  await quietly(vv('setMyCommands', { commands: COMMANDS }));
  await send(event.chat.id, await helpText(false));
}

/* ───────────── Вебхук ───────────── */

const seenUpdates = new Set();

async function handleUpdate(update, dispatch) {
  if (update.message) {
    const type = update.message.chat?.type;

    if (type === 'private' || type === 'group') {
      await handleMessage(update.message, dispatch);
    }
  } else if (update.callback_query?.message) {
    await handleCallback(update.callback_query);
  } else if (update.my_chat_member) {
    await handleMyChatMember(update);
  }
}

async function handleWebhook(event, context) {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));

  if (!VVELCOM_WEBHOOK_SECRET || headers['x-messenger-webhook-secret'] !== VVELCOM_WEBHOOK_SECRET) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  let update;

  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    update = typeof raw === 'object' && raw !== null ? raw : JSON.parse(raw || '{}');
  } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  // Повтор того же события (VVelcom повторяет, если не дождался ответа) не обрабатываем дважды.
  const updateKey = String(update.update_id ?? headers['x-messenger-update-id'] ?? '');

  if (updateKey && seenUpdates.has(updateKey)) {
    return { statusCode: 200, body: 'ok' };
  }

  if (updateKey) {
    seenUpdates.add(updateKey);

    if (seenUpdates.size > 1000) {
      seenUpdates.delete(seenUpdates.values().next().value);
    }
  }

  const startedAt = Date.now();

  try {
    await handleUpdate(update, createDispatcher(context));
  } catch (error) {
    // 200 всё равно: иначе VVelcom пришлёт событие ещё раз.
    log('ERROR', 'update_failed', { error: error.message, type: update.event_type });
  }

  log('INFO', 'update_done', { type: update.event_type, ms: Date.now() - startedAt, overBudget: Date.now() - startedAt > WEBHOOK_BUDGET_MS });

  return { statusCode: 200, body: 'ok' };
}

export async function handler(event, context) {
  const missing = ['VVELCOM_BOT_TOKEN', 'VVELCOM_WEBHOOK_SECRET', 'GIGACHAT_AUTH_KEY'].filter((name) => !process.env[name]);

  if (missing.length > 0) {
    log('ERROR', 'config_missing', { missing });
    return { statusCode: 500, body: `Missing env: ${missing.join(', ')}` };
  }

  if (event?.httpMethod) {
    return handleWebhook(event, context);
  }

  // Асинхронная задача (?integration=async) — тело приходит как есть.
  const task = parseTask(event?.body ?? event);

  if (task) {
    await runTask(task);
  } else {
    log('WARN', 'unknown_invocation', { keys: event ? Object.keys(event) : null });
  }

  return { statusCode: 200, body: 'ok' };
}

// Для тестов.
export const internals = {
  renderList,
  cleanItems,
  cleanTitle,
  cleanEmoji,
  parseModelJson,
  buildListPrompt,
  systemPrompt,
  addUsage,
  usageLines,
  stripMentions,
  parseCommand,
  commandArgument,
  isAllowed,
  createList,
  deriveList,
  recentLists,
  listByMessage
};
