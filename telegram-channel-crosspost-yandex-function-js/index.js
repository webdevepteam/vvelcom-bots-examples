import * as cheerio from 'cheerio';
import sqlite3 from 'sqlite3';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
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
  RELAY_TOKEN
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
const PHOTO_CAPTION_MAX_LENGTH = 1000;

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

async function isAlreadySent(channel, messageId) {
  const row = await dbGet(`
    SELECT 1
    FROM processed_posts
    WHERE channel = ?
      AND message_id = ?
      AND status = 'sent'
    LIMIT 1
  `, [channel, messageId]);

  return Boolean(row);
}

async function markAsSent(post, matchedKeywords) {
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
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')
    ON CONFLICT(channel, message_id) DO UPDATE SET
      post_url = excluded.post_url,
      published_at = excluded.published_at,
      content_hash = excluded.content_hash,
      has_images = excluded.has_images,
      matched_keywords = excluded.matched_keywords,
      status = 'sent',
      sent_at = CURRENT_TIMESTAMP
  `, [
    post.channel,
    post.messageId,
    post.postUrl,
    post.publishedAt || null,
    post.contentHash,
    post.hasImages ? 1 : 0,
    JSON.stringify(matchedKeywords)
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
function buildOutboundText(post, matchedKeywords, { imagesAttached = false, maxLength = 3900 } = {}) {
  const header = matchedKeywords.length > 0
    ? `Совпадения: ${matchedKeywords.join(', ')}\n\n`
    : '';

  const mediaNote = post.hasMedia && !imagesAttached
    ? '\n\n📷 В оригинале есть фото или видео'
    : '';

  const body = post.text || (imagesAttached ? '' : 'Публикация содержит фото или видео без подписи.');
  const footer = `${mediaNote}\n\nИсточник: ${post.postUrl}`;

  // Лимит sendMessage — 4096 символов, подписи к фото — 1024.
  const availableTextLength = Math.max(1, maxLength - header.length - footer.length);

  const truncatedBody = body.length > availableTextLength
    ? `${body.slice(0, availableTextLength - 1)}…`
    : body;

  return `${header}${truncatedBody}${footer}`;
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

  form.append(upload.field, new Blob([upload.buffer], { type: upload.contentType }), upload.filename);

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
  по ссылке и сжимает) и текст. Первый файл получает подпись, если она влезает
  в лимит подписи; иначе текст уходит отдельным сообщением после файлов.
  Если файл не приняли (400 — недоступная ссылка, не фото/видео, слишком
  большой), пост всё равно уходит текстом с пометкой и ссылкой на оригинал.
*/
async function sendPostToVvelcom(post, matchedKeywords) {
  // Фото, затем видео; каждое — отдельное сообщение (альбомов в API пока нет).
  const mediaItems = [
    ...post.photoUrls.map((url) => ({ method: 'sendPhoto', field: 'photo', url })),
    ...post.videoUrls.map((url) => ({ method: 'sendVideo', field: 'video', url }))
  ].slice(0, MAX_MEDIA_PER_POST);

  if (mediaItems.length > 0) {
    const caption = buildOutboundText(post, matchedKeywords, {
      imagesAttached: true,
      maxLength: PHOTO_CAPTION_MAX_LENGTH
    });
    const fitsCaption = (post.text || '').length + 200 <= PHOTO_CAPTION_MAX_LENGTH;

    try {
      for (const [index, item] of mediaItems.entries()) {
        const extra = index === 0 && fitsCaption ? { caption } : {};
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

      if (!fitsCaption) {
        await callVvelcom('sendMessage', {
          text: buildOutboundText(post, matchedKeywords, { imagesAttached: true })
        });
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
    skippedNoKeywordMatch: 0
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

export async function handler(event, context) {
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
