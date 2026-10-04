import * as cheerio from 'cheerio';
import sqlite3 from 'sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
  REQUEST_TIMEOUT_MS = '20000',

  SQLITE_PATH = '/function/storage/telegram-news-monitor/telegram-monitor.sqlite',

  // Канал VVelcom: его ник (`@my_channel` или `my_channel`) или UUID.
  // Бот должен быть добавлен в этот канал.
  VVELCOM_CHANNEL,

  // токен бота `vv_…` (в Yandex Lockbox)
  VVELCOM_BOT_TOKEN
} = process.env;

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

if (!VVELCOM_BOT_TOKEN) {
  throw new Error('Не задан секрет VVELCOM_BOT_TOKEN в Yandex Lockbox');
}

let database = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, Number(REQUEST_TIMEOUT_MS));

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHtml(url) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TelegramNewsMonitor/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`Telegram вернул HTTP ${response.status} для ${url}`);
  }

  return response.text();
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
  const title = keywords.length > 0
    ? '🔎 Найдено совпадение'
    : '📰 Новый пост';

  const matchesLine = matchedKeywords.length > 0
    ? `\nСовпадения: ${matchedKeywords.join(', ')}`
    : '';

  const imagesLine = post.hasMedia && !imagesAttached
    ? '\n📷 В исходном посте есть фото или видео'
    : '';

  const header = [
    title,
    `Канал: @${post.channel}${matchesLine}${imagesLine}`,
    ''
  ].join('\n');

  const body = post.text || (imagesAttached ? '' : 'Публикация содержит фото или видео без подписи.');
  const footer = `\n\nИсточник: ${post.postUrl}`;

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

// Один вызов Bot API: https://apibots.vvelcom.online/bot<TOKEN>/<method>
async function callVvelcom(method, payload) {
  const apiUrl = `${VVELCOM_API_BASE}/bot${VVELCOM_BOT_TOKEN}/${method}`;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: VVELCOM_CHAT_ID, ...payload })
    });

    const responseText = await response.text();

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
        await callVvelcom(item.method, {
          [item.field]: item.url,
          ...(index === 0 && fitsCaption ? { caption } : {})
        });
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

  const html = await fetchHtml(previewUrl);

  const recentPosts = parseTelegramPreview(html, username)
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

  for (const post of recentPosts) {
    if (await isAlreadySent(post.channel, post.messageId)) {
      statistics.skippedAlreadySent += 1;
      continue;
    }

    const { shouldSend, matchedKeywords } = shouldSendPost(post);

    if (!shouldSend) {
      statistics.skippedNoKeywordMatch += 1;
      continue;
    }

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

  try {
    await initializeDatabase();

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
    await closeDatabase();
  }
}
