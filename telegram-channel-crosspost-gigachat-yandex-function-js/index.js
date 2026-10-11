import * as cheerio from 'cheerio';
import sqlite3 from 'sqlite3';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

/*
  Все environment variables — строки. CHANNELS_JSON и KEYWORDS_JSON
  передаются JSON-строками и разбираются через JSON.parse().
*/
const {
  CHANNELS_JSON = '["https://t.me/s/bmpd_cast"]',
  KEYWORDS_JSON = '[]',

  LOOKBACK_MINUTES = '70',
  SQLITE_RETENTION_DAYS = '60',
  MAX_POSTS_PER_CHANNEL = '50',
  REQUEST_TIMEOUT_MS = '7000',
  // VVelcom сам скачивает и сжимает фото/видео по ссылке — это дольше обычного запроса.
  VVELCOM_TIMEOUT_MS = '45000',

  SQLITE_PATH = '/function/storage/telegram-news-monitor/telegram-monitor.sqlite',

  // Канал VVelcom: его ник (`@my_channel` или `my_channel`) или UUID.
  // Бот должен быть добавлен в этот канал.
  VVELCOM_CHANNEL,

  // токен бота `vv_…` (в Yandex Lockbox)
  VVELCOM_BOT_TOKEN,

  // HTTP(S)-прокси вне РФ для запросов к t.me: `http://user:pass@host:port`.
  // Нужен, если Telegram недоступен из сети Yandex Cloud. Без него — напрямую.
  TELEGRAM_PROXY_URL,

  // Relay (restricted_relay.py) на сервере с доступом к Telegram: полный URL
  // `https://relay.example.com/v1/request` и токен. Приоритетнее прокси.
  RELAY_URL,
  RELAY_TOKEN,

  // GigaChat: ключ авторизации (Base64 от Client ID:Client Secret) из личного кабинета Сбера.
  GIGACHAT_AUTH_KEY,
  GIGACHAT_SCOPE = 'GIGACHAT_API_PERS',
  // «GigaChat» — это Lite; для более сильных моделей: GigaChat-Pro, GigaChat-Max.
  GIGACHAT_MODEL = 'GigaChat',
  // Модель для ответов в чате (режим вопросов). Не задана — та же, что GIGACHAT_MODEL.
  // Для более умных ответов: GigaChat-2-Pro / GigaChat-2-Max.
  CHAT_GIGACHAT_MODEL,
  // До какого числа действуют бесплатные токены (из личного кабинета), например 2027-10-09.
  // API Сбера дату не отдаёт, поэтому её показываем из этой переменной.
  GIGACHAT_TOKENS_EXPIRES,
  GIGACHAT_TIMEOUT_MS = '8000',
  // Таймаут запроса ИИ-фильтра постов (кросспост по таймеру, лимита вебхука нет).
  AI_FILTER_TIMEOUT_MS = '30000',
  // Сертификаты Сбера подписаны российским УЦ: путь к его PEM-файлу (лежит рядом с функцией)
  // или GIGACHAT_INSECURE_TLS=true, чтобы не проверять сертификат (хуже по безопасности).
  GIGACHAT_CA_PATH,
  GIGACHAT_INSECURE_TLS,

  // Что искать в постах («пост про выход новых смартфонов»). Пусто — ИИ-фильтр выключен.
  AI_FILTER_PROMPT,

  // Режим чата: секрет вебхука и (необязательно) ник бота, если getMe его не отдаёт.
  VVELCOM_WEBHOOK_SECRET,
  BOT_USERNAME,
  CHAT_DEBUG,
  // Длина ответа в чате: чем короче, тем быстрее генерация и тем вероятнее уложиться в 10 с вебхука.
  CHAT_MAX_TOKENS = '500',
  // Сколько ждать ответ GigaChat в асинхронной задаче (окно вебхука 10 с тут не действует).
  // Таймаут функции в Yandex Cloud должен быть больше: CHAT_ANSWER_TIMEOUT_MS + 5 с.
  CHAT_ANSWER_TIMEOUT_MS = '40000',
  // Ограничители расхода токенов (считаются в памяти контейнера: при холодном старте обнуляются).
  // Максимум символов вопроса и каждого блока контекста (пост, цитата), уходящих в модель.
  CHAT_MAX_INPUT_CHARS = '1500',
  // Сколько вопросов в час от одного пользователя; 0 — без лимита.
  CHAT_USER_LIMIT_PER_HOUR = '10',
  // Дневной бюджет токенов на ответы в чате (по usage из ответа GigaChat); 0 — без лимита.
  CHAT_DAILY_TOKEN_LIMIT = '0',
  // Максимум символов поста, отправляемых ИИ-фильтру.
  AI_FILTER_MAX_CHARS = '2000',
  CHAT_SYSTEM_PROMPT = 'Ты полезный русскоязычный помощник. Отвечай понятно и кратко.'
} = process.env;

// Через прокси идут только запросы к t.me; VVelcom API — напрямую.
const telegramProxy = TELEGRAM_PROXY_URL ? new ProxyAgent(TELEGRAM_PROXY_URL) : null;

const VVELCOM_API_BASE = 'https://apibots.vvelcom.online';

/*
  Лимит Bot API — 60 сообщений в минуту в один чат,
  поэтому между отправками делаем паузу.
*/
const SEND_DELAY_MS = 1100;
const MAX_SEND_ATTEMPTS = 3;
const MAX_MEDIA_PER_POST = 10;

function parseJsonArray(variableName, rawValue) {
  let parsed;

  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error(`${variableName} должен быть валидным JSON-массивом`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${variableName} должен быть JSON-массивом`);
  }

  return parsed;
}

const channels = parseJsonArray('CHANNELS_JSON', CHANNELS_JSON);
const keywords = parseJsonArray('KEYWORDS_JSON', KEYWORDS_JSON);

if (channels.length === 0) {
  throw new Error('CHANNELS_JSON пуст: добавьте минимум один публичный Telegram-канал');
}

if (!VVELCOM_CHANNEL) {
  throw new Error('Не задана переменная VVELCOM_CHANNEL (ник канала VVelcom)');
}

// Bot API принимает chat_id как UUID чата или как `@ник` канала.
const VVELCOM_CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(VVELCOM_CHANNEL)
  ? VVELCOM_CHANNEL
  : `@${VVELCOM_CHANNEL.replace(/^@/, '')}`;

if (RELAY_URL && !RELAY_TOKEN) {
  throw new Error('Задан RELAY_URL, но не задан секрет RELAY_TOKEN');
}

if (!VVELCOM_BOT_TOKEN) {
  throw new Error('Не задан секрет VVELCOM_BOT_TOKEN в Yandex Lockbox');
}

/*
  Какие переменные окружения заданы — только имена и «задана/нет», значения не выводим.
  Один раз при старте контейнера.
*/
{
  const ENV_REQUIRED = ['VVELCOM_BOT_TOKEN', 'VVELCOM_CHANNEL', 'GIGACHAT_AUTH_KEY', 'VVELCOM_WEBHOOK_SECRET'];
  const ENV_OPTIONAL = [
    'CHANNELS_JSON', 'KEYWORDS_JSON', 'LOOKBACK_MINUTES', 'MAX_POSTS_PER_CHANNEL', 'SQLITE_PATH',
    'RELAY_URL', 'RELAY_TOKEN', 'TELEGRAM_PROXY_URL',
    'GIGACHAT_SCOPE', 'GIGACHAT_MODEL', 'CHAT_GIGACHAT_MODEL', 'GIGACHAT_TIMEOUT_MS', 'AI_FILTER_TIMEOUT_MS',
    'GIGACHAT_CA_PATH', 'GIGACHAT_INSECURE_TLS', 'GIGACHAT_TOKENS_EXPIRES',
    'AI_FILTER_PROMPT', 'AI_FILTER_MAX_CHARS',
    'BOT_USERNAME', 'CHAT_SYSTEM_PROMPT', 'CHAT_MAX_TOKENS', 'CHAT_MAX_INPUT_CHARS',
    'CHAT_USER_LIMIT_PER_HOUR', 'CHAT_DAILY_TOKEN_LIMIT', 'CHAT_ANSWER_TIMEOUT_MS', 'CHAT_DEBUG'
  ];
  const isSet = (name) => Boolean(process.env[name]);

  log('INFO', 'env_check', {
    requiredMissing: ENV_REQUIRED.filter((name) => !isSet(name)),
    optionalSet: ENV_OPTIONAL.filter(isSet),
    optionalUnset: ENV_OPTIONAL.filter((name) => !isSet(name))
  });
}

let database = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(level, action, data = {}) {
  const write = level === 'ERROR' ? console.error : console.log;
  write(JSON.stringify({ level, action, ...data }));
}

/*
  Этап, на котором сейчас находится функция. Heartbeat раз в 2 секунды пишет его
  в лог, поэтому при зависании и таймауте платформы видно, где именно застряли.
*/
let currentStage = 'init';

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/ /g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChannelUsername(channelUrl) {
  const url = new URL(channelUrl);

  const allowedHosts = ['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'];

  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`Неподдерживаемый URL Telegram-канала: ${channelUrl}`);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const previewIndex = parts.indexOf('s');

  const username = previewIndex >= 0
    ? parts[previewIndex + 1]
    : parts[0];

  if (!username || !/^[A-Za-z0-9_]{5,}$/.test(username)) {
    throw new Error(`Не удалось извлечь username из: ${channelUrl}`);
  }

  return username;
}

function openDatabase() {
  if (database) {
    return Promise.resolve(database);
  }

  const directory = path.dirname(SQLITE_PATH);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      SQLITE_PATH,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      (error) => {
        if (error) {
          reject(new Error(`Не удалось открыть SQLite: ${error.message}`));
          return;
        }

        database = db;
        resolve(database);
      }
    );
  });
}

async function dbRun(sql, params = []) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function dbGet(sql, params = []) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
}

async function initializeDatabase() {
  /*
    WAL на примонтированном Object Storage не используем:
    при единственном экземпляре функции journal_mode=DELETE безопаснее.
  */
  await dbRun('PRAGMA journal_mode = DELETE');
  await dbRun('PRAGMA synchronous = FULL');
  await dbRun('PRAGMA busy_timeout = 10000');

  await dbRun(`
      CREATE TABLE IF NOT EXISTS processed_posts (
                                                     channel TEXT NOT NULL,
                                                     message_id INTEGER NOT NULL,
                                                     post_url TEXT NOT NULL,
                                                     published_at TEXT,
                                                     content_hash TEXT NOT NULL,
                                                     has_images INTEGER NOT NULL DEFAULT 0,
                                                     sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                                                     matched_keywords TEXT NOT NULL DEFAULT '[]',
                                                     status TEXT NOT NULL DEFAULT 'sent',

                                                     PRIMARY KEY (channel, message_id)
          )
  `);

  await dbRun(`
      CREATE INDEX IF NOT EXISTS idx_processed_posts_sent_at
          ON processed_posts(sent_at)
  `);
}

// 'rejected' — ИИ уже признал пост неподходящим: повторно его не оцениваем (экономим запросы).
async function isAlreadySent(channel, messageId) {
  const row = await dbGet(`
      SELECT 1
      FROM processed_posts
      WHERE channel = ?
        AND message_id = ?
        AND status IN ('sent', 'rejected')
          LIMIT 1
  `, [channel, messageId]);

  return Boolean(row);
}

async function markAsSent(post, matchedKeywords, status = 'sent') {
  await dbRun(`
      INSERT INTO processed_posts (
          channel,
          message_id,
          post_url,
          published_at,
          content_hash,
          has_images,
          matched_keywords,
          status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel, message_id) DO UPDATE SET
          post_url = excluded.post_url,
                                                  published_at = excluded.published_at,
                                                  content_hash = excluded.content_hash,
                                                  has_images = excluded.has_images,
                                                  matched_keywords = excluded.matched_keywords,
                                                  status = excluded.status,
                                                  sent_at = CURRENT_TIMESTAMP
  `, [
    post.channel,
    post.messageId,
    post.postUrl,
    post.publishedAt || null,
    post.contentHash,
    post.hasImages ? 1 : 0,
    JSON.stringify(matchedKeywords),
    status
  ]);
}

async function cleanupOldRecords() {
  const retentionDays = Math.max(1, Number(SQLITE_RETENTION_DAYS) || 60);

  const result = await dbRun(`
      DELETE FROM processed_posts
      WHERE sent_at < datetime('now', ?)
  `, [`-${retentionDays} days`]);

  return result.changes;
}

async function closeDatabase() {
  if (!database) {
    return;
  }

  const db = database;
  database = null;

  await new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

function isPostInsideLookback(post) {
  if (!post.publishedAt) {
    return false;
  }

  const publishedTimestamp = new Date(post.publishedAt).getTime();

  if (Number.isNaN(publishedTimestamp)) {
    return false;
  }

  const lookbackMs = Math.max(1, Number(LOOKBACK_MINUTES) || 70) * 60 * 1000;
  const now = Date.now();

  // небольшой запас на расхождение часов
  return publishedTimestamp >= now - lookbackMs &&
    publishedTimestamp <= now + 5 * 60 * 1000;
}

function findMatchedKeywords(text) {
  const normalizedPostText = normalizeText(text);

  return keywords.filter((keyword) => {
    const normalizedKeyword = normalizeText(keyword);

    return normalizedKeyword.length > 0 &&
      normalizedPostText.includes(normalizedKeyword);
  });
}

function shouldSendPost(post) {
  // Пустой список слов = без фильтра.
  if (keywords.length === 0) {
    return { shouldSend: true, matchedKeywords: [] };
  }

  // Фильтр включён, а текста нет — проверять нечего.
  if (!post.text) {
    return { shouldSend: false, matchedKeywords: [] };
  }

  const matchedKeywords = findMatchedKeywords(post.text);

  return { shouldSend: matchedKeywords.length > 0, matchedKeywords };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = Number(REQUEST_TIMEOUT_MS)) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    // С dispatcher (прокси) нужен fetch из того же undici, что и ProxyAgent.
    return await (options.dispatcher ? undiciFetch : fetch)(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Таймаут запроса ${timeoutMs} мс: ${url.replace(VVELCOM_BOT_TOKEN, '***')}`);
    }

    // undici прячет причину в error.cause: без неё остаётся голое «fetch failed».
    if (error.cause) {
      const cause = error.cause;
      const details = [cause.code, cause.message, cause.address && `${cause.address}:${cause.port}`]
        .filter(Boolean)
        .join(' ');

      throw new Error(`${error.message} (${details || String(cause)})`, { cause });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/*
  Диагностика сети до t.me: резолв DNS и TCP-подключение к каждому адресу :443.
  Показывает, где именно режется доступ: DNS, конкретный IP (v4/v6) или дальше.
  Выключается переменной NETWORK_DIAGNOSTICS=off.
*/
function tcpProbe(address, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host: address, port });
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve({ address, ms: Date.now() - startedAt, ...result });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'timeout' }));
    socket.once('error', (error) => finish({ ok: false, error: error.code || error.message }));
  });
}

async function diagnoseNetwork(hostname, port = 443) {
  const startedAt = Date.now();

  try {
    const addresses = await dns.lookup(hostname, { all: true });

    log('INFO', 'diag_dns', {
      hostname,
      ms: Date.now() - startedAt,
      addresses: addresses.map(({ address, family }) => `${address} (v${family})`)
    });

    const probes = await Promise.all(addresses.map(({ address }) => tcpProbe(address, port, 4000)));

    log('INFO', 'diag_tcp', { hostname, port, probes });
  } catch (error) {
    log('ERROR', 'diag_dns_failed', {
      hostname,
      ms: Date.now() - startedAt,
      error: error.code || error.message
    });
  }
}

/*
  Запрос к t.me через relay (restricted_relay.py на сервере с доступом к Telegram):
  POST {url, method} с Bearer-токеном, в ответ — статус и текст страницы.
*/
async function fetchViaRelay(url) {
  const response = await fetchWithTimeout(RELAY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RELAY_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TelegramNewsMonitor/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru,en;q=0.8'
      }
    })
  });

  const responseText = await response.text();

  log('INFO', 'relay_response', { status: response.status, bytes: responseText.length });

  if (!response.ok) {
    throw new Error(`Relay вернул HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  const result = JSON.parse(responseText);

  if (result.upstreamStatus !== 200) {
    throw new Error(`Telegram через relay вернул HTTP ${result.upstreamStatus} для ${url}`);
  }

  return result.data.text;
}

async function fetchHtml(url) {
  if (process.env.NETWORK_DIAGNOSTICS !== 'off') {
    if (RELAY_URL) {
      const relayUrl = new URL(RELAY_URL);
      await diagnoseNetwork(relayUrl.hostname, Number(relayUrl.port) || (relayUrl.protocol === 'https:' ? 443 : 80));
    } else {
      await diagnoseNetwork(telegramProxy ? new URL(TELEGRAM_PROXY_URL).hostname : new URL(url).hostname);
    }
  }

  const fetchStartedAt = Date.now();
  log('INFO', 'telegram_fetch_started', {
    url,
    route: RELAY_URL ? 'relay' : telegramProxy ? 'proxy' : 'direct',
    timeoutMs: Number(REQUEST_TIMEOUT_MS)
  });

  let html;

  if (RELAY_URL) {
    html = await fetchViaRelay(url);
  } else {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      ...(telegramProxy ? { dispatcher: telegramProxy } : {}),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TelegramNewsMonitor/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru,en;q=0.8'
      }
    });

    log('INFO', 'telegram_headers_received', {
      status: response.status,
      ms: Date.now() - fetchStartedAt
    });

    if (!response.ok) {
      throw new Error(`Telegram вернул HTTP ${response.status} для ${url}`);
    }

    html = await response.text();
  }

  log('INFO', 'telegram_fetch_finished', {
    bytes: html.length,
    ms: Date.now() - fetchStartedAt
  });

  return html;
}

function parseTelegramPreview(html, username) {
  const $ = cheerio.load(html);
  const posts = [];

  $('.tgme_widget_message').each((_, element) => {
    const root = $(element);

    const rawPostId = root.attr('data-post') || '';
    const messageId = Number(rawPostId.split('/').at(-1));

    if (!Number.isInteger(messageId) || messageId <= 0) {
      return;
    }

    const textElement = root.find('.tgme_widget_message_text').first();

    const text = textElement
      .clone()
      .find('br')
      .replaceWith('\n')
      .end()
      .text()
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    /*
      Картинки: Telegram кладёт адрес фото в style="background-image:url('…')"
      блока .tgme_widget_message_photo_wrap. Сами файлы не скачиваем —
      VVelcom сам загрузит их по ссылке (sendPhoto) и сожмёт.
    */
    const photoUrls = root
      .find('.tgme_widget_message_photo_wrap')
      .map((__, wrap) => {
        const style = $(wrap).attr('style') || '';
        const match = style.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
        return match ? match[1] : null;
      })
      .get()
      .filter((url) => url && url.startsWith('https://'));

    /*
      Видео: для роликов, которые Telegram показывает прямо на странице,
      в разметке есть <video src="https://…mp4">. Если ссылки нет
      (большое видео), ролик просто не пересылается.
    */
    const videoUrls = root
      .find('video.tgme_widget_message_video, video.tgme_widget_message_roundvideo')
      .map((__, video) => $(video).attr('src') || null)
      .get()
      .filter((url) => url && url.startsWith('https://'));

    const hasImages = photoUrls.length > 0;
    const hasMedia = hasImages || videoUrls.length > 0;

    // Полностью пустой пост (без текста и медиа) пропускаем.
    if (!text && !hasMedia) {
      return;
    }

    const postUrl = root.find('a.tgme_widget_message_date').attr('href')
      || `https://t.me/${username}/${messageId}`;

    const publishedAt = root.find('time').attr('datetime') || null;

    const contentHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ channel: username, messageId, text, hasImages }))
      .digest('hex');

    posts.push({
      channel: username,
      messageId,
      text,
      postUrl,
      publishedAt,
      hasImages,
      hasMedia,
      photoUrls,
      videoUrls,
      contentHash
    });
  });

  return posts;
}

// `imagesAttached` — фото/видео уйдут вместе с этим текстом, пометка про них не нужна.
function buildOutboundText(post, matchedKeywords, { imagesAttached = false } = {}) {
  const header = matchedKeywords.length > 0
    ? `Совпадения: ${matchedKeywords.join(', ')}\n\n`
    : '';

  const mediaNote = post.hasMedia && !imagesAttached
    ? '\n\n📷 В оригинале есть фото или видео'
    : '';

  const body = post.text || (imagesAttached ? '' : 'Публикация содержит фото или видео без подписи.');
  const footer = `${mediaNote}\n\nИсточник: ${post.postUrl}`;

  // Длину не режем: VVelcom сам разбивает длинный текст на сообщения по 4096 символов
  // (подпись к фото — первые 4096, остаток идёт следующими сообщениями).
  return `${header}${body}${footer}`;
}

class VvelcomHttpError extends Error {
  constructor(method, status, body) {
    super(`VVelcom ${method} HTTP ${status}: ${body.slice(0, 1000)}`);
    this.status = status;
  }
}

// JSON-запрос или multipart, если вместе с запросом загружается файл.
function buildVvelcomRequest(payload, upload) {
  if (!upload) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: VVELCOM_CHAT_ID, ...payload })
    };
  }

  const form = new FormData();
  form.append('chat_id', VVELCOM_CHAT_ID);

  for (const [name, value] of Object.entries(payload)) {
    form.append(name, String(value));
  }

  for (const file of [].concat(upload)) {
    form.append(file.field, new Blob([file.buffer], { type: file.contentType }), file.filename);
  }

  return { method: 'POST', body: form };
}

/*
  Скачивает фото с CDN Telegram: через relay (он отдаёт файл в base64) или напрямую.
  Сервер VVelcom не всегда может сам достучаться до Telegram, поэтому файл
  загружаем ему готовым.
*/
async function downloadImage(url) {
  const startedAt = Date.now();
  let buffer;
  let contentType;

  if (RELAY_URL) {
    const response = await fetchWithTimeout(RELAY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RELAY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, method: 'GET', responseEncoding: 'base64' })
    }, Number(VVELCOM_TIMEOUT_MS));

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Relay вернул HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    }

    const result = JSON.parse(responseText);

    if (result.upstreamStatus !== 200) {
      throw new Error(`Фото через relay: HTTP ${result.upstreamStatus}`);
    }

    buffer = Buffer.from(result.data.base64, 'base64');
    contentType = result.contentType;
  } else {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      ...(telegramProxy ? { dispatcher: telegramProxy } : {})
    }, Number(VVELCOM_TIMEOUT_MS));

    if (!response.ok) {
      throw new Error(`Фото: HTTP ${response.status}`);
    }

    buffer = Buffer.from(await response.arrayBuffer());
    contentType = response.headers.get('content-type');
  }

  const type = (contentType || '').split(';')[0].trim() || 'image/jpeg';

  log('INFO', 'image_downloaded', { bytes: buffer.length, type, ms: Date.now() - startedAt });

  return { buffer, contentType: type, filename: `photo.${type.split('/')[1] || 'jpg'}` };
}

// Один вызов Bot API: https://apibots.vvelcom.online/bot<TOKEN>/<method>
async function callVvelcom(method, payload, upload = null) {
  const apiUrl = `${VVELCOM_API_BASE}/bot${VVELCOM_BOT_TOKEN}/${method}`;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    const callStartedAt = Date.now();
    const response = await fetchWithTimeout(apiUrl, buildVvelcomRequest(payload, upload), Number(VVELCOM_TIMEOUT_MS));

    const responseText = await response.text();

    log('INFO', 'vvelcom_call', {
      method,
      attempt,
      status: response.status,
      ms: Date.now() - callStartedAt
    });

    if (response.ok) {
      return responseText;
    }

    // 429 — превышен лимит: ждём и повторяем.
    if (response.status === 429 && attempt < MAX_SEND_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after')) || 5;
      await sleep(Math.min(retryAfter, 30) * 1000);
      continue;
    }

    throw new VvelcomHttpError(method, response.status, responseText);
  }
}

/*
  Публикует пост: фото и видео (до 10 файлов; платформа сама скачивает их
  по ссылке и сжимает) и текст. Первый файл получает подпись целиком;
  если текст длиннее 4096 символов, VVelcom сам отправит остаток следующими сообщениями.
  Если файл не приняли (400 — недоступная ссылка, не фото/видео, слишком
  большой), пост всё равно уходит текстом с пометкой и ссылкой на оригинал.
*/
async function sendPostToVvelcom(post, matchedKeywords) {
  // Фото, затем видео.
  const mediaItems = [
    ...post.photoUrls.map((url) => ({ method: 'sendPhoto', field: 'photo', url })),
    ...post.videoUrls.map((url) => ({ method: 'sendVideo', field: 'video', url }))
  ].slice(0, MAX_MEDIA_PER_POST);

  if (mediaItems.length > 0) {
    const caption = buildOutboundText(post, matchedKeywords, { imagesAttached: true });

    try {
      // Несколько фото уходят одним сообщением (альбомом); остальное — по одному.
      const albumSent = await trySendPhotoAlbum(post, mediaItems, caption);
      const singles = albumSent ? mediaItems.filter((item) => item.field !== 'photo') : mediaItems;
      const captionGoesToFirstSingle = !albumSent;

      for (const [index, item] of singles.entries()) {
        const extra = index === 0 && captionGoesToFirstSingle ? { caption } : {};
        let image = null;

        // Фото сначала скачиваем сами и загружаем файлом; не вышло — просим VVelcom скачать по ссылке.
        if (item.field === 'photo') {
          try {
            image = await downloadImage(item.url);
          } catch (error) {
            log('WARN', 'image_download_failed', { messageId: post.messageId, error: error.message });
          }
        }

        if (image) {
          await callVvelcom(item.method, extra, { field: 'photo', ...image });
        } else {
          await callVvelcom(item.method, { [item.field]: item.url, ...extra });
        }

        await sleep(SEND_DELAY_MS);
      }

      return;
    } catch (error) {
      if (!(error instanceof VvelcomHttpError) || error.status !== 400) {
        throw error;
      }

      console.error(JSON.stringify({
        level: 'WARN',
        action: 'media_rejected_fallback_to_text',
        messageId: post.messageId,
        error: error.message
      }));
    }
  }

  await callVvelcom('sendMessage', { text: buildOutboundText(post, matchedKeywords) });
}

/*
  Если в посте несколько фото — отправляет их ОДНИМ сообщением (sendMediaGroup) с подписью
  у первого. Возвращает true, если альбом ушёл. Любая неудача (не скачались фото, старая версия
  сервера без sendMediaGroup, 400) — false: тогда фото уйдут по одному, ничего не теряется.
*/
async function trySendPhotoAlbum(post, mediaItems, caption) {
  const photoItems = mediaItems.filter((item) => item.field === 'photo');

  if (photoItems.length < 2) {
    return false;
  }

  try {
    const images = [];

    for (const item of photoItems) {
      images.push(await downloadImage(item.url));
    }

    const uploads = images.map((image, index) => ({ field: `file${index}`, ...image }));

    await callVvelcom('sendMediaGroup', {
      media: JSON.stringify(images.map((_, index) => ({
        type: 'photo',
        media: `attach://file${index}`,
        ...(index === 0 && caption ? { caption } : {})
      })))
    }, uploads);

    log('INFO', 'album_sent', { messageId: post.messageId, photos: images.length });

    await sleep(SEND_DELAY_MS);

    return true;
  } catch (error) {
    log('WARN', 'album_failed_fallback_to_singles', { messageId: post.messageId, error: error.message });

    return false;
  }
}

/* ───────────── GigaChat ───────────── */

const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const GIGACHAT_CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

// Сертификат Сбера выдан российским УЦ, которого нет в списке Node: подключаем его явно.
// Явный GIGACHAT_INSECURE_TLS=true главнее сертификата; иначе берём PEM из GIGACHAT_CA_PATH.
const gigachatInsecure = GIGACHAT_INSECURE_TLS === 'true';
// Относительный путь считаем от папки с index.js, а не от текущей папки процесса.
const gigachatCa = !gigachatInsecure && GIGACHAT_CA_PATH
  ? fs.readFileSync(path.resolve(import.meta.dirname, GIGACHAT_CA_PATH), 'utf8')
  : null;

// В логе видно, какой режим TLS включён и сколько сертификатов нашлось в файле.
log('INFO', 'gigachat_tls', {
  mode: gigachatInsecure ? 'insecure' : gigachatCa ? 'custom_ca' : 'system_ca',
  caPath: GIGACHAT_CA_PATH || null,
  certificatesInFile: gigachatCa ? (gigachatCa.match(/-----BEGIN CERTIFICATE-----/g) || []).length : 0
});

/*
  Запросы к GigaChat идут через node:https, а не через fetch/undici: из Yandex Cloud запросы
  undici к gigachat.devices.sberbank.ru зависали (/diag: тот же запрос через node:https —
  ответ за ~90 мс). Интерфейс как у fetch-ответа: status, ok, text().
*/
function gigachatFetch(url, { method = 'GET', headers = {}, body = null } = {}, timeoutMs = Number(GIGACHAT_TIMEOUT_MS)) {
  const target = new URL(url);
  const payload = body === null ? null : Buffer.from(body);

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const request = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
      ...(gigachatCa ? { ca: gigachatCa } : {}),
      ...(gigachatInsecure ? { rejectUnauthorized: false } : {})
    }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', (error) => finish(reject, error));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');

        finish(resolve, {
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          text: async () => text
        });
      });
    });

    // Общий таймаут на весь запрос, как у fetchWithTimeout.
    const timer = setTimeout(() => {
      request.destroy();
      finish(reject, new Error(`Таймаут запроса ${timeoutMs} мс: ${url}`));
    }, timeoutMs);

    request.on('error', (error) => finish(reject, new Error(`fetch failed (${error.code || error.message})`)));

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

let gigachatToken = null; // { value, expiresAt } — живёт 30 минут, кэшируем между вызовами

async function getGigachatToken(timeoutMs = Number(GIGACHAT_TIMEOUT_MS)) {
  if (!GIGACHAT_AUTH_KEY) {
    throw new Error('Не задан секрет GIGACHAT_AUTH_KEY');
  }

  if (gigachatToken && gigachatToken.expiresAt - 60_000 > Date.now()) {
    return gigachatToken.value;
  }

  const response = await gigachatFetch(GIGACHAT_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${GIGACHAT_AUTH_KEY}`,
      'RqUID': crypto.randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({ scope: GIGACHAT_SCOPE }).toString()
  }, timeoutMs);

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`GigaChat OAuth HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text);

  // expires_at — unix-время в миллисекундах.
  gigachatToken = { value: data.access_token, expiresAt: Number(data.expires_at) || Date.now() + 25 * 60_000 };

  return gigachatToken.value;
}

// Токены, потраченные этим контейнером за текущие сутки (UTC), по usage из ответов GigaChat.
const spentToday = { day: '', tokens: 0 };

function addSpentTokens(tokens) {
  const day = new Date().toISOString().slice(0, 10);

  if (spentToday.day !== day) {
    spentToday.day = day;
    spentToday.tokens = 0;
  }

  spentToday.tokens += tokens;
}

function isDailyLimitReached() {
  const limit = Number(CHAT_DAILY_TOKEN_LIMIT);

  addSpentTokens(0); // сброс счётчика при смене суток

  return limit > 0 && spentToday.tokens >= limit;
}

// Вопросы по пользователям за последний час: userKey -> метки времени.
const userQuestions = new Map();

function isUserLimitReached(userKey) {
  const limit = Number(CHAT_USER_LIMIT_PER_HOUR);

  if (!(limit > 0)) {
    return false;
  }

  const now = Date.now();
  const recent = (userQuestions.get(userKey) || []).filter((time) => now - time < 3_600_000);

  if (recent.length >= limit) {
    userQuestions.set(userKey, recent);
    return true;
  }

  recent.push(now);
  userQuestions.set(userKey, recent);

  // Не даём карте расти бесконечно.
  if (userQuestions.size > 1000) {
    userQuestions.delete(userQuestions.keys().next().value);
  }

  return false;
}

/*
  `retries` — сколько раз повторить при таймауте, сетевой ошибке, 429 или 5xx. В фильтре постов
  берём 1 (первый запрос к Сберу иногда зависает); в чате 0: вебхук ждёт ответ всего 10 секунд.
*/
async function askGigachat(messages, { retries = 0, deadlineAt = null, ...options } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // deadlineAt — момент, к которому надо успеть (конец окна вебхука): запрос не должен
      // идти дольше, чем осталось, а повтор без времени не делается.
      if (deadlineAt) {
        const left = deadlineAt - Date.now();

        if (left < 1500) {
          throw new Error('Таймаут: до конца окна вебхука не осталось времени');
        }

        options = { ...options, timeoutMs: Math.min(options.timeoutMs ?? Number(GIGACHAT_TIMEOUT_MS), left) };
      }

      return await askGigachatOnce(messages, options);
    } catch (error) {
      const retryable = isGigachatRetryable(error);

      if (attempt >= retries || !retryable) {
        throw error;
      }

      log('WARN', 'gigachat_retry', { attempt: attempt + 1, error: error.message });
      await sleep(300);
    }
  }
}

const isGigachatRetryable = (error) => /Таймаут|fetch failed|HTTP (429|5\d\d)/.test(error.message);

/*
  Потоковый ответ (stream: true, SSE): токены приходят по мере генерации. Если время вышло, а часть
  ответа уже есть, возвращаем её с пометкой, а не теряем целиком. Пишет в лог время до первого токена.
*/
function gigachatChatStream({ token, body, budgetMs, startedAt, model }) {
  return new Promise((resolve, reject) => {
    let content = '';
    let usage = null;
    let buffer = '';
    let firstTokenMs = null;
    let settled = false;

    const finish = (truncated, error = null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      request.destroy();

      if (error) {
        reject(error);
        return;
      }

      if (truncated && !content) {
        reject(new Error(`Таймаут запроса ${budgetMs} мс: ${GIGACHAT_CHAT_URL}`));
        return;
      }

      addSpentTokens(Number(usage?.total_tokens) || 0);

      log('INFO', 'gigachat_call', {
        model,
        stream: true,
        ms: Date.now() - startedAt,
        firstTokenMs,
        truncated,
        answerLength: content.length,
        tokens: usage?.total_tokens ?? null,
        spentToday: spentToday.tokens
      });

      resolve({ content: content.trim(), truncated });
    };

    const payload = Buffer.from(body);
    const target = new URL(GIGACHAT_CHAT_URL);

    const request = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Content-Length': payload.length
      },
      ...(gigachatCa ? { ca: gigachatCa } : {}),
      ...(gigachatInsecure ? { rejectUnauthorized: false } : {})
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const chunks = [];

        if (response.statusCode === 401) {
          gigachatToken = null;
        }

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => finish(false, new Error(
          `GigaChat HTTP ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`
        )));
        return;
      }

      response.setEncoding('utf8');
      response.on('error', (error) => finish(false, new Error(`fetch failed (${error.code || error.message})`)));
      response.on('end', () => finish(false));
      response.on('data', (chunk) => {
        buffer += chunk;

        let newline;

        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);

          if (!line.startsWith('data:')) {
            continue;
          }

          const data = line.slice(5).trim();

          if (data === '[DONE]') {
            finish(false);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || '';

            if (parsed.usage) {
              usage = parsed.usage;
            }

            if (delta) {
              firstTokenMs ??= Date.now() - startedAt;
              content += delta;
            }
          } catch {
            // Неполный или служебный фрагмент — пропускаем.
          }
        }
      });
    });

    // Время вышло: что успели получить — то и отдаём.
    const timer = setTimeout(() => finish(true), budgetMs);

    request.on('error', (error) => finish(false, new Error(`fetch failed (${error.code || error.message})`)));
    request.write(payload);
    request.end();
  });
}

async function askGigachatOnce(
  messages,
  {
    temperature = 0.5,
    maxTokens = 800,
    model = GIGACHAT_MODEL,
    timeoutMs = Number(GIGACHAT_TIMEOUT_MS),
    stream = false
  } = {}
) {
  const startedAt = Date.now();
  const token = await getGigachatToken(timeoutMs);

  if (stream) {
    const { content, truncated } = await gigachatChatStream({
      token,
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
      budgetMs: Math.max(1000, timeoutMs - (Date.now() - startedAt)),
      startedAt,
      model
    });

    return truncated ? `${content}…\n\n(ответ обрезан: не хватило времени)` : content;
  }

  const response = await gigachatFetch(GIGACHAT_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
    // Общий лимит на токен и ответ: что ушло на получение токена, из времени запроса вычитаем.
  }, Math.max(1000, timeoutMs - (Date.now() - startedAt)));

  const text = await response.text();

  if (response.status === 401) {
    gigachatToken = null; // токен протух раньше срока — в следующий раз получим новый
  }

  if (!response.ok) {
    throw new Error(`GigaChat HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const parsed = JSON.parse(text);
  const content = parsed.choices?.[0]?.message?.content?.trim() || '';
  const usage = parsed.usage || null; // { prompt_tokens, completion_tokens, total_tokens }

  addSpentTokens(Number(usage?.total_tokens) || 0);

  log('INFO', 'gigachat_call', {
    model,
    ms: Date.now() - startedAt,
    answerLength: content.length,
    tokens: usage?.total_tokens ?? null,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    spentToday: spentToday.tokens
  });

  return content;
}

/*
  ИИ-фильтр: модель отвечает JSON-ом {"match": true|false, "reason": "…"}.
  Результат целиком пишется в лог (ai_filter_result), чтобы было видно, как она рассудила.
*/
async function checkPostWithAi(post) {
  const content = await askGigachat([
    {
      role: 'system',
      content: 'Ты фильтр публикаций. Определи, подходит ли текст под критерий. '
        + 'Ответь СТРОГО одним JSON-объектом без пояснений и markdown: '
        + '{"match": true или false, "reason": "краткая причина"}.'
    },
    { role: 'user', content: `Критерий: ${AI_FILTER_PROMPT}\n\nТекст публикации:\n${post.text.slice(0, Number(AI_FILTER_MAX_CHARS))}` }
  ], {
    temperature: 0.1,
    maxTokens: 200,
    retries: 1,
    // Таймер не ограничен 10 секундами вебхука: даём Сберу время ответить.
    timeoutMs: Number(AI_FILTER_TIMEOUT_MS)
  });

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  let verdict = null;

  try {
    verdict = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    verdict = null;
  }

  if (!verdict || typeof verdict.match !== 'boolean') {
    throw new Error(`GigaChat вернул не JSON с полем match: ${content.slice(0, 200)}`);
  }

  log('INFO', 'ai_filter_result', {
    messageId: post.messageId,
    match: verdict.match,
    reason: verdict.reason || null,
    prompt: AI_FILTER_PROMPT,
    raw: content.slice(0, 300)
  });

  return verdict;
}

async function processChannel(channelUrl) {
  const username = extractChannelUsername(channelUrl);
  const previewUrl = `https://t.me/s/${username}`;

  console.log(JSON.stringify({
    level: 'INFO',
    action: 'channel_started',
    channel: username,
    previewUrl
  }));

  currentStage = `fetch:${username}`;
  const html = await fetchHtml(previewUrl);

  currentStage = `parse:${username}`;
  const allPosts = parseTelegramPreview(html, username);
  const publishedDates = allPosts
    .map((post) => post.publishedAt)
    .filter(Boolean)
    .sort();

  log('INFO', 'telegram_parsed', {
    channel: username,
    postsOnPage: allPosts.length,
    oldestPublishedAt: publishedDates[0] || null,
    newestPublishedAt: publishedDates.at(-1) || null,
    now: new Date().toISOString()
  });

  const recentPosts = allPosts
    .filter(isPostInsideLookback)
    .sort((first, second) => {
      return new Date(first.publishedAt).getTime()
        - new Date(second.publishedAt).getTime();
    })
    .slice(-Math.max(1, Number(MAX_POSTS_PER_CHANNEL) || 50));

  const statistics = {
    channel: username,
    postsInTimeWindow: recentPosts.length,
    sent: 0,
    sentWithImages: 0,
    skippedAlreadySent: 0,
    skippedNoKeywordMatch: 0,
    skippedByAi: 0,
    skippedNoText: 0,
    aiErrors: 0
  };

  log('INFO', 'posts_in_window', {
    channel: username,
    lookbackMinutes: Number(LOOKBACK_MINUTES),
    count: recentPosts.length,
    posts: recentPosts.map((post) => ({
      messageId: post.messageId,
      publishedAt: post.publishedAt,
      ageMinutes: Math.round((Date.now() - new Date(post.publishedAt).getTime()) / 60000),
      textPreview: post.text.slice(0, 60)
    }))
  });

  for (const post of recentPosts) {
    currentStage = `post:${username}/${post.messageId}`;

    if (await isAlreadySent(post.channel, post.messageId)) {
      statistics.skippedAlreadySent += 1;
      log('INFO', 'post_skipped_already_sent', { messageId: post.messageId });
      continue;
    }

    const { shouldSend, matchedKeywords } = shouldSendPost(post);

    if (!shouldSend) {
      statistics.skippedNoKeywordMatch += 1;
      log('INFO', 'post_skipped_no_keyword', { messageId: post.messageId });
      continue;
    }

    if (AI_FILTER_PROMPT) {
      if (!post.text) {
        statistics.skippedNoText += 1;
        log('INFO', 'post_skipped_no_text_for_ai', { messageId: post.messageId });
        continue;
      }

      let verdict;

      try {
        verdict = await checkPostWithAi(post);
      } catch (error) {
        // Пост не помечаем: при следующем запуске оценим заново.
        statistics.aiErrors += 1;
        log('ERROR', 'ai_filter_failed', { messageId: post.messageId, error: error.message });
        continue;
      }

      if (!verdict.match) {
        statistics.skippedByAi += 1;
        await markAsSent(post, matchedKeywords, 'rejected');
        continue;
      }
    }

    log('INFO', 'post_sending', {
      messageId: post.messageId,
      photos: post.photoUrls.length,
      videos: post.videoUrls.length,
      textLength: post.text.length
    });

    /*
      Порядок принципиален: сначала отправка в VVelcom, потом запись в SQLite.
      Если VVelcom недоступен, ID не сохранится и пост уйдёт при следующем запуске.
    */
    await sendPostToVvelcom(post, matchedKeywords);
    await markAsSent(post, matchedKeywords);

    statistics.sent += 1;

    if (post.hasImages) {
      statistics.sentWithImages += 1;
    }

    console.log(JSON.stringify({
      level: 'INFO',
      action: 'post_sent',
      channel: post.channel,
      messageId: post.messageId,
      postUrl: post.postUrl,
      hasImages: post.hasImages,
      matchedKeywords
    }));

    await sleep(SEND_DELAY_MS);
  }

  return statistics;
}

/* ───────────── Чат: ответы на вопросы (webhook) ───────────── */

const THINKING_TEXT = '💭 Думаю над вопросом…';
const START_TEXT = 'Привет! Напишите свой вопрос, и я отвечу.';
let botUsername = BOT_USERNAME ? BOT_USERNAME.replace(/^@/, '') : null;

// Bot API: ответ вида {ok, result}. Возвращает result.
async function vvelcomApi(method, payload) {
  const response = await fetchWithTimeout(`${VVELCOM_API_BASE}/bot${VVELCOM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
    // Вызовы чата идут в окне вебхука в 10 с, поэтому ждём ответ API не дольше 3 с.
  }, 3000);

  const data = JSON.parse(await response.text() || '{}');

  if (!response.ok || data.ok === false) {
    throw new Error(`VVelcom ${method} HTTP ${response.status}: ${data.description || ''}`);
  }

  return data.result;
}

async function getBotUsername() {
  if (botUsername !== null) {
    return botUsername;
  }

  try {
    const me = await vvelcomApi('getMe', {});
    botUsername = me?.username || me?.user?.username || '';
  } catch (error) {
    log('WARN', 'get_me_failed', { error: error.message });
    botUsername = '';
  }

  return botUsername;
}

/*
  /diag — где застревает запрос к Сберу. Тот же GET /api/v1/balance, но стандартным node:https
  (не undici) и с метками времени: DNS → TCP → TLS → первый байт ответа. Если здесь ответ приходит,
  а в обычных запросах таймаут — виноват клиент; если висит и здесь — сеть Yandex Cloud ↔ Сбер.
*/
async function diagGigachat(deadlineAt) {
  const lines = [];
  const host = 'gigachat.devices.sberbank.ru';

  try {
    const addresses = await dns.lookup(host, { all: true });
    lines.push(`DNS: ${addresses.map(({ address, family }) => `${address} (v${family})`).join(', ')}`);
  } catch (error) {
    lines.push(`DNS: ошибка ${error.code || error.message}`);
  }

  let token;

  try {
    token = await getGigachatToken(Math.max(1000, Math.min(3000, deadlineAt - 4500 - Date.now())));
    lines.push('OAuth: токен получен');
  } catch (error) {
    return [...lines, `OAuth: ${error.message}`].join('\n');
  }

  const startedAt = Date.now();
  const mark = (name) => lines.push(`${name}: ${Date.now() - startedAt} мс`);
  const budget = Math.max(1000, deadlineAt - 1500 - Date.now());

  await new Promise((resolve) => {
    const request = https.request({
      host,
      path: '/api/v1/balance',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      ...(gigachatCa ? { ca: gigachatCa } : {}),
      ...(gigachatInsecure ? { rejectUnauthorized: false } : {}),
      timeout: budget
    }, (response) => {
      mark('первый байт ответа');
      lines.push(`HTTP ${response.statusCode}`);
      response.resume();
      response.on('end', () => {
        mark('ответ получен целиком');
        resolve();
      });
    });

    request.on('socket', (socket) => {
      socket.on('lookup', () => mark('DNS (в запросе)'));
      socket.on('connect', () => mark('TCP подключён'));
      socket.on('secureConnect', () => mark('TLS установлен'));
    });
    request.on('timeout', () => {
      lines.push(`таймаут ${budget} мс: ответа нет`);
      request.destroy();
      resolve();
    });
    request.on('error', (error) => {
      lines.push(`ошибка: ${error.code || error.message}`);
      resolve();
    });
    request.end();
  });

  return lines.join('\n');
}

// Остаток токенов: GET /api/v1/balance → { balance: [{ usage: 'GigaChat', value: 123 }, …] }.
async function buildBalanceText(deadlineAt) {
  // Всё, включая токен, должно уложиться в окно вебхука; 1,5 с оставляем на отправку ответа.
  const timeLeft = () => deadlineAt - 1500 - Date.now();

  try {
    const token = await getGigachatToken(Math.max(1000, Math.min(4000, timeLeft())));
    let text;

    // Один повтор, если хватает времени: первое соединение с Сбером иногда зависает.
    for (let attempt = 1; ; attempt += 1) {
      const startedAt = Date.now();

      try {
        if (timeLeft() < 1000) {
          throw new Error('Таймаут: до конца окна вебхука не осталось времени');
        }

        const response = await gigachatFetch('https://gigachat.devices.sberbank.ru/api/v1/balance', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        }, Math.min(Number(GIGACHAT_TIMEOUT_MS), 4500, timeLeft()));

        text = await response.text();

        log('INFO', 'gigachat_balance_response', { attempt, status: response.status, ms: Date.now() - startedAt });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        }

        break;
      } catch (error) {
        if (attempt >= 2 || !isGigachatRetryable(error)) {
          throw error;
        }

        log('WARN', 'gigachat_retry', { attempt, error: error.message, ms: Date.now() - startedAt });
      }
    }

    const items = JSON.parse(text).balance || [];
    log('INFO', 'gigachat_balance', { items });

    const lines = items.map((item) => `${item.usage}: ${Number(item.value).toLocaleString('ru-RU')}`);
    const expires = GIGACHAT_TOKENS_EXPIRES
      ? `\nБесплатные токены действуют до ${new Date(GIGACHAT_TOKENS_EXPIRES).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}.`
      : '';

    return `Остаток токенов GigaChat:\n${lines.join('\n') || 'нет данных'}${expires}`;
  } catch (error) {
    log('ERROR', 'gigachat_balance_failed', { error: error.message });
    return 'Не получилось узнать остаток токенов, попробуйте позже.';
  }
}

// `deadlineAt` — до какого момента надо ответить вебхуку (он ждёт 10 с и иначе повторяет событие).
async function handleChatMessage(message, deadlineAt, dispatchAsync = null) {
  const chatId = message.chat?.id;
  let text = (message.text || '').trim();

  if (!chatId || !text || message.from?.is_bot) {
    return;
  }

  // Убираем @упоминание бота из вопроса.
  const username = await getBotUsername();
  const mention = username ? new RegExp(`@${username}\\b`, 'gi') : null;
  const wasMentioned = Boolean(mention && mention.test(text));

  if (mention) {
    text = text.replace(mention, '').trim();
  }

  const command = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : '';

  if (command === '/start') {
    await vvelcomApi('sendMessage', { chat_id: chatId, text: START_TEXT });
    return;
  }

  if (command === '/balance' || command === '/tokens') {
    await vvelcomApi('sendMessage', { chat_id: chatId, text: await buildBalanceText(deadlineAt) });
    return;
  }

  if (command === '/diagchat') {
    // Долго (до ~40 с), поэтому в асинхронной задаче; результат придёт отдельным сообщением.
    const started = dispatchAsync ? await dispatchAsync({ vvTask: DIAG_CHAT_TASK, chatId }) : false;

    await vvelcomApi('sendMessage', {
      chat_id: chatId,
      text: started ? 'Проверяю запросы чата к GigaChat, результат придёт сообщением (до минуты).' : 'Асинхронный вызов недоступен.'
    });
    return;
  }

  if (command === '/diag') {
    await vvelcomApi('sendMessage', { chat_id: chatId, text: await diagGigachat(deadlineAt) });
    return;
  }

  if (command === '/ask') {
    text = text.replace(/^\/ask(@\S+)?\s*/i, '');
  }

  if (!text) {
    await vvelcomApi('sendMessage', { chat_id: chatId, text: 'Напишите вопрос после упоминания, и я отвечу.' });
    return;
  }

  // Контекст от VVelcom: сообщение, на которое ответили (без автора), и пост канала, под которым
  // комментарий. Сам вопрос идёт отдельно, поэтому в запросе до трёх блоков.
  const maxInput = Number(CHAT_MAX_INPUT_CHARS);
  text = text.slice(0, maxInput);

  const repliedText = (message.reply_to_message?.text || '').trim().slice(0, maxInput);
  const repliedFromBot = message.reply_to_message?.from_bot === true;
  const postText = (message.comment_to_message?.text || '').trim().slice(0, maxInput);

  // Ограничители расхода: до заглушки и обращения к модели.
  if (isDailyLimitReached()) {
    log('WARN', 'chat_daily_limit_reached', { spentToday: spentToday.tokens, limit: Number(CHAT_DAILY_TOKEN_LIMIT) });
    await vvelcomApi('sendMessage', { chat_id: chatId, text: 'На сегодня лимит ответов исчерпан. Попробуйте завтра.' });
    return;
  }

  if (isUserLimitReached(message.from?.id || chatId)) {
    log('WARN', 'chat_user_limit_reached', { chatId, limitPerHour: Number(CHAT_USER_LIMIT_PER_HOUR) });
    await vvelcomApi('sendMessage', {
      chat_id: chatId,
      text: `Слишком много вопросов: не больше ${CHAT_USER_LIMIT_PER_HOUR} в час. Попробуйте чуть позже.`
    });
    return;
  }

  log('INFO', 'chat_question', {
    chatId,
    chatType: message.chat?.type || null,
    mentioned: wasMentioned,
    questionLength: text.length,
    // Что именно приходит в событии: по ключам видно, есть ли в нём пост/тред.
    messageKeys: Object.keys(message),
    replyTextLength: repliedText.length,
    postTextLength: postText.length,
    // CHAT_DEBUG=true — целиком сообщение из события (на время отладки: там текст пользователей).
    ...(CHAT_DEBUG === 'true' ? { rawMessage: JSON.stringify(message).slice(0, 2500) } : {})
  });

  // Эффект «ИИ думает»: показываем заглушку, а перед ответом удаляем её.
  let thinkingId = null;

  try {
    const sent = await vvelcomApi('sendMessage', { chat_id: chatId, text: THINKING_TEXT });
    thinkingId = sent?.message_id ?? sent?.id ?? null;

    // Без id заглушку не удалить — пишем, что именно вернул VVelcom.
    log(thinkingId === null ? 'WARN' : 'INFO', 'thinking_message_sent', {
      messageId: thinkingId,
      resultKeys: sent && typeof sent === 'object' ? Object.keys(sent) : typeof sent
    });
  } catch (error) {
    log('WARN', 'thinking_message_failed', { error: error.message });
  }

  const hasContext = Boolean(postText || repliedText);
  const question = [
    postText && `Пост канала, под которым идёт обсуждение:\n${postText}`,
    repliedText && `${repliedFromBot ? 'Предыдущий ответ бота' : 'Комментарий, на который отвечают'}:\n${repliedText}`,
    hasContext ? `Вопрос пользователя:\n${text}` : text
  ].filter(Boolean).join('\n\n');

  const job = { vvTask: CHAT_ANSWER_TASK, chatId, question, thinkingId };

  /*
    Ответ готовит ОТДЕЛЬНЫЙ асинхронный вызов этой же функции: вебхук тут же получает 200 и не держит
    связь с VVelcom, а GigaChat может думать сколько нужно. Не вышло запустить — отвечаем здесь же,
    в окне вебхука (потоком, с обрезкой по времени).
  */
  if (dispatchAsync && (await dispatchAsync(job))) {
    return;
  }

  await finishChatAnswer(job, deadlineAt, { inline: true });
}

const DIAG_CHAT_TASK = 'diag_chat';

/*
  /diagchat: три варианта запроса chat/completions прямо из функции, с временем каждого. По ним видно,
  от чего зависит зависание: от system-промта, от потокового режима или запрос не идёт вообще.
*/
async function runChatDiag(chatId) {
  const model = CHAT_GIGACHAT_MODEL || GIGACHAT_MODEL;
  const budgetMs = 12000;
  const lines = [`Модель: ${model}`, `system-промт: ${CHAT_SYSTEM_PROMPT.length} символов`];
  const ask = [{ role: 'user', content: 'Скажи ок' }];
  const variants = [
    ['1. минимальный (без system, без stream)', ask, false],
    ['2. с вашим system-промтом', [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...ask], false],
    ['3. потоком (stream)', ask, true]
  ];

  try {
    const token = await getGigachatToken(5000);

    for (const [name, messages, stream] of variants) {
      const startedAt = Date.now();

      try {
        if (stream) {
          await gigachatChatStream({
            token,
            body: JSON.stringify({ model, messages, max_tokens: 20, stream: true }),
            budgetMs,
            startedAt,
            model
          });
          lines.push(`${name}: ответ ${Date.now() - startedAt} мс`);
        } else {
          const response = await gigachatFetch(GIGACHAT_CHAT_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({ model, messages, max_tokens: 20 })
          }, budgetMs);

          lines.push(`${name}: HTTP ${response.status}, ${Date.now() - startedAt} мс`);
        }
      } catch (error) {
        lines.push(`${name}: ${/Таймаут/.test(error.message) ? `нет ответа за ${budgetMs / 1000} с` : error.message}`);
      }
    }
  } catch (error) {
    lines.push(`OAuth: ${error.message}`);
  }

  await vvelcomApi('sendMessage', { chat_id: chatId, text: lines.join('\n') });
}

// Метка задачи в теле асинхронного вызова: по ней handler отличает её от таймера и вебхука.
const CHAT_ANSWER_TASK = 'chat_answer';

// Запускает эту же функцию асинхронно (?integration=async): в ответ 202, работа идёт отдельно.
function createAsyncDispatcher(context) {
  // В Node.js-контексте Yandex Cloud идентификатор функции приходит как `functionName`
  // (functionId — на случай другого рантайма); FUNCTION_ID из переменных окружения — запасной вариант.
  const functionId = context?.functionId || context?.functionName || process.env.FUNCTION_ID;

  if (!functionId) {
    log('WARN', 'chat_async_unavailable', { contextKeys: context ? Object.keys(context) : null });
    return null;
  }

  return async (job) => {
    try {
      const response = await fetchWithTimeout(
        `https://functions.yandexcloud.net/${functionId}?integration=async`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) },
        3000
      );

      log(response.ok ? 'INFO' : 'WARN', 'chat_async_dispatch', { status: response.status });

      return response.ok;
    } catch (error) {
      log('WARN', 'chat_async_dispatch_failed', { error: error.message });

      return false;
    }
  };
}

/*
  Ответ на вопрос: GigaChat → удалить «Думаю…» → отправить ответ. Вызывается из асинхронной задачи
  (времени много) или прямо из вебхука (inline: укладываемся в `deadlineAt`).
*/
async function finishChatAnswer({ chatId, question, thinkingId }, deadlineAt, { inline = false } = {}) {
  let answer;

  try {
    answer = await askGigachat([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: question }
    ], {
      model: CHAT_GIGACHAT_MODEL || GIGACHAT_MODEL,
      maxTokens: Number(CHAT_MAX_TOKENS),
      // Потоком: если время выйдет, пользователь получит уже сгенерированную часть ответа.
      stream: true,
      timeoutMs: inline ? Number(GIGACHAT_TIMEOUT_MS) : Number(CHAT_ANSWER_TIMEOUT_MS),
      // Запас в конце — на удаление «Думаю…» и отправку ответа.
      deadlineAt: deadlineAt - 2000
    });
  } catch (error) {
    log('ERROR', 'chat_answer_failed', { error: error.message });
    answer = '';
  }

  const answerText = (answer || 'Не получилось ответить, попробуйте ещё раз чуть позже.').slice(0, 4096);

  if (thinkingId !== null) {
    try {
      await vvelcomApi('deleteMessage', { chat_id: chatId, message_id: thinkingId });
      log('INFO', 'thinking_deleted', { messageId: thinkingId });
    } catch (error) {
      log('WARN', 'thinking_delete_failed', { messageId: thinkingId, error: error.message });

      // Не удалилась — превращаем заглушку в ответ, чтобы «Думаю…» не висело в чате.
      try {
        await vvelcomApi('editMessageText', { chat_id: chatId, message_id: thinkingId, text: answerText });
        return;
      } catch (editError) {
        log('WARN', 'thinking_edit_failed', { messageId: thinkingId, error: editError.message });
      }
    }
  }

  await vvelcomApi('sendMessage', { chat_id: chatId, text: answerText });
}

function parseAsyncTask(event) {
  let body = event;

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }

  return body && typeof body === 'object' && [CHAT_ANSWER_TASK, DIAG_CHAT_TASK].includes(body.vvTask) && body.chatId
    ? body
    : null;
}

// VVelcom ждёт ответ вебхука 10 с, поэтому укладываемся в 9,3 с с запасом на сеть.
const WEBHOOK_BUDGET_MS = 9300;
// Уже обработанные события этого контейнера (при холодном старте список пуст).
const seenEvents = new Set();

async function handleWebhook(event, context) {
  const startedAt = Date.now();
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );

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

  // Сообщение в личке/группе — `message`, пост в канале — `channel_post`.
  const message = update.message || update.channel_post;

  if (message) {
    // Повторная доставка того же события (VVelcom повторяет, если не дождался ответа) — не отвечаем второй раз.
    const eventKey = String(headers['x-messenger-update-id'] || message.id || '');

    if (eventKey && seenEvents.has(eventKey)) {
      log('INFO', 'chat_event_duplicate', { eventKey });
      return { statusCode: 200, body: 'ok' };
    }

    if (eventKey) {
      seenEvents.add(eventKey);

      if (seenEvents.size > 500) {
        seenEvents.delete(seenEvents.values().next().value);
      }
    }

    try {
      await handleChatMessage(message, startedAt + WEBHOOK_BUDGET_MS, createAsyncDispatcher(context));
    } catch (error) {
      // 200, чтобы VVelcom не присылал событие повторно и мы не отвечали дважды.
      log('ERROR', 'chat_handler_failed', { error: error.message });
    }
  }

  return { statusCode: 200, body: 'ok' };
}

export async function handler(event, context) {
  // Вызов по HTTP (webhook VVelcom) — чат; иначе таймер-триггер — кросспост.
  if (event?.httpMethod) {
    return handleWebhook(event, context);
  }

  // Асинхронная задача «ответить на вопрос» (?integration=async): тело приходит как есть, строкой или объектом.
  const task = parseAsyncTask(event);

  if (task) {
    const budgetMs = Number(CHAT_ANSWER_TIMEOUT_MS) + 5000;

    log('INFO', 'chat_answer_task_started', { requestId: context?.requestId || null, chatId: task.chatId });

    try {
      if (task.vvTask === DIAG_CHAT_TASK) {
        await runChatDiag(task.chatId);
      } else {
        await finishChatAnswer(task, Date.now() + budgetMs);
      }
    } catch (error) {
      log('ERROR', 'chat_answer_task_failed', { error: error.message });
    }

    return { statusCode: 200, body: 'ok' };
  }

  const startedAt = Date.now();

  console.log(JSON.stringify({
    level: 'INFO',
    action: 'function_started',
    requestId: context?.requestId || null,
    channelsCount: channels.length,
    keywordFilterEnabled: keywords.length > 0,
    lookbackMinutes: Number(LOOKBACK_MINUTES)
  }));

  const heartbeat = setInterval(() => {
    log('INFO', 'heartbeat', { stage: currentStage, elapsedMs: Date.now() - startedAt });
  }, 2000);

  try {
    currentStage = 'db_init';
    await initializeDatabase();
    log('INFO', 'db_ready', { sqlitePath: SQLITE_PATH, elapsedMs: Date.now() - startedAt });

    currentStage = 'db_cleanup';
    const deletedRows = await cleanupOldRecords();
    const results = [];
    const errors = [];

    // Каналы обрабатываются последовательно: SQLite без конкурентных записей.
    for (const channelUrl of channels) {
      try {
        results.push(await processChannel(channelUrl));
      } catch (error) {
        errors.push({ channelUrl, error: error.message });

        console.error(JSON.stringify({
          level: 'ERROR',
          action: 'channel_processing_failed',
          channelUrl,
          error: error.message
        }));
      }
    }

    const durationMs = Date.now() - startedAt;

    console.log(JSON.stringify({
      level: 'INFO',
      action: 'function_finished',
      durationMs,
      deletedRows,
      results,
      errors
    }));

    // Ошибку отдаём наверх, чтобы таймер-триггер сделал повтор.
    if (errors.length > 0) {
      throw new Error(
        `Не удалось обработать ${errors.length} канал(а/ов): ${JSON.stringify(errors)}`
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, durationMs, deletedRows, results })
    };
  } finally {
    clearInterval(heartbeat);
    currentStage = 'db_close';
    await closeDatabase();
    log('INFO', 'db_closed', { elapsedMs: Date.now() - startedAt });
  }
}
