'use strict';

// Yandex Cloud Functions, Node.js 22. Entry point: index.handler.
// No external dependencies, no secrets in ZIP or front-end.
const crypto = require('node:crypto');
const stats = require('./stats');
const puzzles = require('./puzzles.json').puzzles;
const puzzleMap = new Map(puzzles.map((p) => [p.id, p]));
const BOT_API = 'https://apibots.vvelcom.online';
const MAX_BODY_BYTES = 12 * 1024;

function result(statusCode, data, origin = '') {
  const allowed = allowedOrigin(origin);
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      ...(allowed ? {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      } : {}),
    },
    body: JSON.stringify(data),
  };
}
function allowedOrigin(origin) {
  if (!origin) return '';
  const candidates = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return candidates.includes(origin) ? origin : '';
}
function headersOf(event) {
  return Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
}
function parseBody(event) {
  const raw = event.body;
  if (typeof raw === 'object' && raw !== null && !event.isBase64Encoded) return raw;
  if (typeof raw !== 'string') throw new Error('INVALID_BODY');
  if (raw.length > MAX_BODY_BYTES * 2) throw new Error('BODY_TOO_LARGE');
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  return JSON.parse(text);
}
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}
function verifyInitData(initData, token, maxAge = 86400, now = Date.now()) {
  if (typeof initData !== 'string' || initData.length < 30 || initData.length > 8192 || !token) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  const authDate = params.get('auth_date');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash) || !authDate || !/^\d{9,12}$/.test(authDate)) return null;
  const issued = Number(authDate);
  const age = Math.floor(now / 1000) - issued;
  if (!Number.isFinite(issued) || age < -60 || age > maxAge) return null;
  if (params.getAll('hash').length !== 1) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const actual = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!constantTimeEqual(hash.toLowerCase(), actual)) return null;
  let user;
  try { user = JSON.parse(params.get('user')); } catch { return null; }
  if (!user || (typeof user.id !== 'string' && typeof user.id !== 'number') ||
      !/^[\w-]{1,128}$/.test(String(user.id))) return null;
  const name = [user.first_name, user.last_name].filter((v) => typeof v === 'string' && v).join(' ') || (typeof user.username === 'string' ? user.username : '');
  return { userId: String(user.id), name, queryId: params.get('query_id') || '' };
}
function validateGame(body) {
  if (!body || typeof body !== 'object' || typeof body.puzzleId !== 'string') return null;
  const p = puzzleMap.get(body.puzzleId);
  if (!p || !Array.isArray(body.board) || body.board.length !== p.size * p.size) return null;
  if (!body.board.every((v, i) => Number.isInteger(v) && v === p.solution[i])) return null;
  for (let i = 0; i < p.givens.length; i++) {
    if (p.givens[i] !== 0 && body.board[i] !== p.givens[i]) return null;
  }
  if (![body.elapsed, body.mistakes, body.hintsUsed].every(Number.isSafeInteger)) return null;
  if (body.elapsed < 0 || body.elapsed > 604800 || body.mistakes < 0 || body.mistakes > 9999 ||
      body.hintsUsed < 0 || body.hintsUsed > 3) return null;
  return { puzzle: p, elapsed: body.elapsed, mistakes: body.mistakes, hintsUsed: body.hintsUsed };
}
function formatTime(t) {
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
// Bot mention for the feed post, e.g. SUDOKU_BOT_LINK=@sudoku_vvbot (the feed turns @name into a link).
const BOT_LINK = (process.env.SUDOKU_BOT_LINK || '@sudoku_vvbot').replace(/^(?!@)/, '@');
function scoreOf(game) {
  const empty = game.puzzle.givens.filter((v) => v === 0).length;
  return stats.computeScore(game.puzzle.level, empty, game.elapsed, game.mistakes, game.hintsUsed);
}
function buildText(game, forFeed = false) {
  const titles = { mini: 'Новичок 🌱', junior: 'Легко 🌈', classic: 'Средне 🧠', challenge: 'Сложно 🔥', master: 'Эксперт 🏆' };
  const stats = [
    `🧩 Уровень: ${titles[game.puzzle.level]} · ${game.puzzle.size}×${game.puzzle.size}`,
    `⏱ Время: ${formatTime(game.elapsed)}`,
    `🎯 Ошибки: ${game.mistakes}`,
    `💡 Подсказки: ${game.hintsUsed} из 3`,
    `🏅 Очки: ${scoreOf(game)}`,
  ];
  if (!forFeed) return ['🏆 Судоку — Ваш результат!', '', ...stats, '', '🎉 Отличная работа!', '📣 Нажмите кнопку ниже, чтобы поделиться результатом в ленте.'].join('\n');
  // The feed post goes out under the player's own name, so it is written in the first person.
  return ['🏆 Я решил(а) судоку!', '', ...stats, '', `Попробуй и ты 👉 ${BOT_LINK}`].join('\n');
}
async function callBotApi(method, payload) {
  const token = process.env.VVELCOM_BOT_TOKEN;
  if (!token) throw new Error('MISSING_BOT_TOKEN');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const response = await fetch(`${BOT_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      // No request body or URL logging: never expose token or initData.
      const err = new Error('BOT_API_ERROR');
      err.statusCode = response.status;
      err.detail = String(data.description || '').slice(0, 150);
      throw err;
    }
    return data.result;
  } finally { clearTimeout(timeout); }
}
async function share(body, origin) {
  if (!process.env.VVELCOM_BOT_TOKEN) return result(503, {ok:false,code:'NOT_CONFIGURED',message:'Токен VVELCOM_BOT_TOKEN не настроен.'}, origin);
  const auth = verifyInitData(body?.initData, process.env.VVELCOM_BOT_TOKEN);
  if (!auth) return result(401, {ok:false,code:'INVALID_INIT_DATA',message:'Не удалось подтвердить вход. Откройте игру из чата бота ещё раз.'}, origin);
  const game = validateGame(body);
  if (!game) return result(422, {ok:false,code:'INVALID_RESULT',message:'Поле не завершено или результат не соответствует заданию.'}, origin);
  if (!auth.queryId) return result(409, {ok:false,code:'QUERY_UNAVAILABLE',message:'VVelcom не передал query_id. Откройте игру через web_app-кнопку в сообщении бота, либо поделитесь результатом обычным способом.'}, origin);
  const article = {
    type: 'article', id: crypto.randomUUID(), title: '🏆 Мой результат в Судоку',
    input_message_content: {message_text: buildText(game)},
    reply_markup: {inline_keyboard: [
      [{text: '📣 В ленту', share_to_feed: {text: buildText(game, true)}}],
    ]},
  };
  try {
    await callBotApi('answerWebAppQuery', {web_app_query_id: auth.queryId, result: article});
    return result(200, {ok:true,sentToChat:true,closesMiniApp:true,message:'Результат отправлен в чат. Нажмите «В ленту» под сообщением, чтобы поделиться.'}, origin);
  } catch (error) {
    console.error('share bot API failure', error.name || 'Error', error.statusCode || 'no-http-status');
    return result(502, {ok:false,code:'BOT_DELIVERY_FAILED',message:'VVelcom не принял результат. Повторите попытку из чата бота.'}, origin);
  }
}
async function authorized(body, origin) {
  const token = process.env.VVELCOM_BOT_TOKEN;
  if (!token) return { error: result(503, {ok:false,code:'NOT_CONFIGURED',message:'Токен VVELCOM_BOT_TOKEN не настроен.'}, origin) };
  const auth = verifyInitData(body?.initData, token);
  if (!auth) return { error: result(401, {ok:false,code:'INVALID_INIT_DATA',message:'Не удалось подтвердить вход. Откройте игру из чата бота ещё раз.'}, origin) };
  return { auth };
}
async function playerAction(body, origin) {
  const { auth, error } = await authorized(body, origin);
  if (error) return error;
  try {
    if (body.action === 'record') {
      const game = validateGame(body);
      if (!game) return result(422, {ok:false,code:'INVALID_RESULT',message:'Результат не соответствует заданию.'}, origin);
      const saved = await stats.recordGame(auth.userId, auth.name, game);
      return result(200, {ok:true, ...saved}, origin);
    }
    if (body.action === 'rename') {
      const name = await stats.setName(auth.userId, auth.name, body.name);
      if (!name) return result(422, {ok:false,code:'INVALID_NAME',message:'Введите имя от 1 до 24 символов.'}, origin);
      return result(200, {ok:true, name}, origin);
    }
    if (body.action === 'leaderboard') {
      const level = stats.LEVELS.includes(body.level) ? body.level : 'all';
      const [board, me] = await Promise.all([stats.leaderboard(level, 10, auth.userId), stats.playerStats(auth.userId, auth.name)]);
      return result(200, {ok:true, board, me}, origin);
    }
    return result(400, {ok:false,code:'UNKNOWN_ACTION',message:'Неизвестное действие.'}, origin);
  } catch (e) {
    console.error('stats failure', e.name || 'Error', e.code || '');
    return result(500, {ok:false,code:'STORAGE_UNAVAILABLE',message:'Рейтинг сейчас недоступен. Попробуйте позже.'}, origin);
  }
}
function topText(board, invite) {
  if (!board.top.length) return '🏆 Рейтинг Судоку пока пуст. Сыграйте первую партию!';
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['🏆 Рейтинг Судоку', ''];
  board.top.forEach((r) => lines.push(`${medals[r.place - 1] || `${r.place}.`} ${r.name} — ${r.value}`));
  if (board.me && board.me.place > board.top.length) lines.push('…', `${board.me.place}. Я — ${board.me.value}`);
  if (invite) lines.push('', `Попробуй и ты 👉 ${invite}`);
  return lines.join('\n');
}
const HELP_UNKNOWN = '🤔 Я не понял Ваше сообщение.\n\nВот что я умею:';
const HELP_TEXT = [
  HELP_UNKNOWN,
  '🎮 /play — начать игру',
  '🏆 /top — рейтинг игроков',
  '📊 /stats — моя статистика',
  '✏️ /name Новое имя — сменить имя в рейтинге',
  '',
  'Или нажмите кнопку ниже 👇',
].join('\n');
function menuMarkup() {
  const gameUrl = process.env.GAME_URL || '';
  const rows = [];
  if (gameUrl.startsWith('https://')) rows.push([{text: '🎮 Играть', web_app: {url: gameUrl}}]);
  rows.push([{text: '🏆 Рейтинг', callback_data: 'sd:top'}, {text: '📊 Статистика', callback_data: 'sd:stats'}]);
  rows.push([{text: '✏️ Сменить имя', callback_data: 'sd:name'}]);
  return {inline_keyboard: rows};
}
// The platform never gives bots a real name (first_name is always the placeholder), so the
// player's name comes from /name or the in-game form; until then it is «Игрок».
function profileNameOf(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '';
  return name === 'Пользователь' ? '' : name;
}
async function nameText(from) {
  const mine = await stats.playerStats(String(from.id), profileNameOf(from));
  return `✏️ Сейчас Вас зовут «${mine.name}».

Чтобы сменить имя в рейтинге, отправьте: /name Новое имя
Например: /name Алексей`;
}
// One reply per command, shared by typed commands and menu buttons. Returns {text, markup}.
async function commandReply(cmd, arg, from) {
  const userId = String(from.id);
  const profileName = profileNameOf(from);
  if (cmd === 'top') {
    const board = await stats.leaderboard('all', 10, userId);
    const text = topText(board);
    const feedText = topText(board, BOT_LINK);
    const shareable = !/^🏆 Рейтинг Судоку пока/.test(text);
    return {text, markup: shareable ? {inline_keyboard: [[{text: '📣 В ленту', share_to_feed: {text: feedText}}]]} : undefined};
  }
  if (cmd === 'stats' || cmd === 'mystats') {
    const mine = await stats.playerStats(userId, profileName);
    const text = stats.statsText(mine);
    const feedText = stats.statsText(mine, BOT_LINK);
    const shareable = !/^📊 Пока/.test(text);
    return {text, markup: shareable ? {inline_keyboard: [[{text: '📣 В ленту', share_to_feed: {text: feedText}}]]} : undefined};
  }
  if (cmd === 'name' || cmd === 'rename' || cmd === 'setname') {
    if (!arg) return {text: await nameText(from)};
    const name = await stats.setName(userId, profileName, arg);
    if (!name) return {text: 'Введите имя от 1 до 24 символов, например: /name Алексей'};
    return {text: `✅ Готово! Теперь в рейтинге Вы — «${name}».`};
  }
  if (cmd === 'help') return {text: HELP_TEXT.replace(HELP_UNKNOWN, '📋 Что я умею:'), markup: menuMarkup()};
  return null;
}
async function webhook(event) {
  const headers = headersOf(event);
  const secret = process.env.VVELCOM_WEBHOOK_SECRET;
  if (!secret || !constantTimeEqual(headers['x-messenger-webhook-secret'] || headers['x-telegram-bot-api-secret-token'] || '', secret)) {
    return result(403, {ok:false,code:'WEBHOOK_FORBIDDEN'});
  }
  let update;
  try { update = parseBody(event); } catch { return result(400, {ok:false,code:'BAD_UPDATE'}); }
  try {
    // Menu buttons of this bot (callback_data «sd:…»); any other callback is not ours and is ignored.
    const query = update?.callback_query;
    if (query && typeof query.data === 'string' && /^sd:(top|stats|name)$/.test(query.data) && query.message?.chat?.id && query.from?.id) {
      const reply = await commandReply(query.data.slice(3), '', query.from);
      await callBotApi('answerCallbackQuery', {callback_query_id: query.id}).catch(() => {});
      await callBotApi('sendMessage', {chat_id: query.message.chat.id, text: reply.text, ...(reply.markup ? {reply_markup: reply.markup} : {})});
      return result(200, {ok:true});
    }
    const message = update?.message;
    if (!message?.chat?.id || message.from?.is_bot) return result(200, {ok:true});
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/(start|play)(?:@\S+)?(?:\s|$)/i.test(text)) {
      const gameUrl = process.env.GAME_URL || '';
      const markup = gameUrl.startsWith('https://') ? {inline_keyboard: [
        [{text:'🎮 Играть',web_app:{url:gameUrl}}],
      ]} : undefined;
      await callBotApi('sendMessage', {chat_id:message.chat.id,
        text:'🧩 Это приложение «Судоку». Для начала игры нажмите кнопку «Играть» ниже.',
        ...(markup ? {reply_markup:markup} : {})});
      return result(200, {ok:true});
    }
    if (!message.from?.id) return result(200, {ok:true});
    const command = text.match(/^\/(\w+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
    const reply = command ? await commandReply(command[1].toLowerCase(), (command[2] || '').trim(), message.from) : null;
    await callBotApi('sendMessage', {chat_id: message.chat.id, text: reply ? reply.text : HELP_TEXT,
      reply_markup: reply ? reply.markup : menuMarkup()});
  } catch (error) {
    console.error('webhook failure', error.name || 'Error', error.statusCode || error.code || '');
    return result(500,{ok:false,code:'WEBHOOK_PROCESSING_FAILED'});
  }
  return result(200, {ok:true});
}
async function handler(event = {}) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const headers = headersOf(event);
  const origin = headers.origin || '';
  const mode = event.queryStringParameters?.mode || '';
  if (mode === 'webhook') {
    if (method !== 'POST') return result(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    return webhook(event);
  }
  // CORS is an extra safeguard, not authorization; initData is always required for sharing.
  if (origin && !allowedOrigin(origin)) return result(403, { ok: false, code: 'ORIGIN_FORBIDDEN', message: 'Адрес сайта не разрешён в ALLOWED_ORIGINS.' });
  if (method === 'OPTIONS') return result(204, {}, origin);
  if (method === 'GET') return result(200, { ok: true, service: 'sudoku-share', version: '1.4', configured: Boolean(process.env.VVELCOM_BOT_TOKEN) }, origin);
  if (method !== 'POST') return result(405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, origin);
  let body;
  try { body = parseBody(event); } catch { return result(400, { ok: false, code: 'INVALID_JSON', message: 'Неверный формат запроса.' }, origin); }
  if (body?.action === 'share') return share(body, origin);
  return playerAction(body, origin);
}

module.exports = { handler, verifyInitData, validateGame, buildText, topText };
