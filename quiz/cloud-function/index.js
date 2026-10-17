'use strict';

// Yandex Cloud Functions, Node.js 22. Entry point: index.handler.
// Quiz bot for VVelcom: a web-app quiz (web-app/), results and rating stored in the mounted storage folder
// (see stats.js) and group «rounds»: the bot posts a round into a chat, every player opens the same questions
// with the button's start_param and the message with the results table is edited after each finished game.
// No external dependencies, no secrets in ZIP or front-end.
const crypto = require('node:crypto');
const stats = require('./stats');
const rules = require('./quiz-rules');
const bank = require('./questions.json').questions;
const bankMap = new Map(bank.map((q) => [q.id, q]));

const BOT_API = 'https://apibots.vvelcom.online';
const MAX_BODY_BYTES = 24 * 1024;
const BOARD_ROWS = 10;
const BOT_LINK = (process.env.QUIZ_BOT_LINK || '@quiz_vvbot').replace(/^(?!@)/, '@');
const ROUND_PARAM = /^r_([0-9a-f]{10})$/;

// ---- http helpers --------------------------------------------------------------------------------------

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

/** Checks the signature of the mini app's initData. start_param is signed too, so it can be trusted like `user`. */
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
  return { userId: String(user.id), name, queryId: params.get('query_id') || '', startParam: params.get('start_param') || '' };
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

// ---- texts ---------------------------------------------------------------------------------------------

const medals = ['🥇', '🥈', '🥉'];
const catById = new Map(rules.CATEGORIES.map((c) => [c.id, c]));
const diffById = new Map(rules.DIFFICULTIES.map((d) => [d.id, d]));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
function settingsLine(s) {
  const diff = diffById.get(s.difficulty);
  const cats = s.cats.map((id) => catById.get(id)).filter(Boolean).map((c) => `${c.emoji} ${c.title}`).join(' · ');
  return [`📚 ${cats}`, `${diff.emoji} ${diff.title} · ${s.count} ${plural(s.count, 'вопрос', 'вопроса', 'вопросов')} · ${rules.QUESTION_SECONDS} с на ответ`];
}
function formatDeadline(ms) {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)) + ' МСК';
  } catch { return ''; }
}
function boardLines(rows, limit = BOARD_ROWS) {
  const lines = rows.slice(0, limit).map((r, i) => `${medals[i] || `${i + 1}.`} ${r.name} — ${r.score} · ${r.correct}/${r.total}`);
  if (rows.length > limit) lines.push(`… и ещё ${rows.length - limit}`);
  return lines;
}
/** The group message: the round's settings, the deadline and the results table (edited after every finished game). */
function roundText(round, rows, forFeed = false) {
  const closed = stats.isClosed(round);
  const lines = [closed ? '🏁 Квиз-раунд завершён' : '🧠 Квиз-раунд', '', ...settingsLine(round)];
  if (!closed) lines.push(`⏳ Играть можно до ${formatDeadline(round.expiresAt)}`);
  lines.push('');
  if (!rows.length) lines.push(closed ? 'Никто не сыграл.' : 'Пока никто не сыграл — будьте первым! 👇');
  else lines.push(closed ? '🏆 Итоги:' : '🏆 Результаты:', ...boardLines(rows));
  if (forFeed) lines.push('', `Сыграй и ты 👉 ${BOT_LINK}`);
  return lines.join('\n');
}
function roundMarkup(round, rows) {
  const gameUrl = process.env.GAME_URL || '';
  const closed = stats.isClosed(round);
  const keyboard = [];
  if (!closed && gameUrl.startsWith('https://')) keyboard.push([{ text: '🎮 Играть в раунд', web_app: { url: gameUrl, start_param: `r_${round.id}` } }]);
  if (rows.length) keyboard.push([{ text: '📣 В ленту', share_to_feed: { text: roundText(round, rows, true) } }]);
  return keyboard.length ? { inline_keyboard: keyboard } : undefined;
}
/** Rewrites the round's chat message. A failure (message deleted, bot removed from the chat) never breaks a player's result. */
async function refreshRoundMessage(round) {
  if (!round.chatId || !round.messageId) return false;
  const rows = await stats.roundResults(round.id);
  try {
    await callBotApi('editMessageText', {
      chat_id: round.chatId, message_id: round.messageId, text: roundText(round, rows),
      ...(roundMarkup(round, rows) ? { reply_markup: roundMarkup(round, rows) } : {}),
    });
    return true;
  } catch (error) {
    console.error('round message update failed', error.statusCode || error.name || 'Error', error.detail || '');
    return false;
  }
}
/** An expired round is closed lazily: whoever touches it first rewrites the message into the final table. */
async function closeIfExpired(round) {
  if (!stats.isClosed(round)) return false;
  if (!round.closedPosted) {
    round.closedPosted = true;
    await stats.updateRound(round);
    await refreshRoundMessage(round);
  }
  return true;
}
function topText(board, invite) {
  if (!board.top.length) return '🏆 Рейтинг квиза пока пуст. Сыграйте первую партию!';
  const lines = ['🏆 Рейтинг квиза', ''];
  board.top.forEach((r) => lines.push(`${medals[r.place - 1] || `${r.place}.`} ${r.name} — ${r.value}`));
  if (board.me && board.me.place > board.top.length) lines.push('…', `${board.me.place}. Я — ${board.me.value}`);
  if (invite) lines.push('', `Сыграй и ты 👉 ${invite}`);
  return lines.join('\n');
}
function resultText(graded, forFeed = false) {
  const lines = [forFeed ? '🧠 Я сыграл(а) в квиз!' : '🧠 Квиз — Ваш результат!', '',
    `✅ Верно: ${graded.correct} из ${graded.total}`, `🏅 Очки: ${graded.score}`];
  const cats = rules.CATEGORIES.filter((c) => graded.byCat[c.id]);
  if (cats.length) lines.push(...cats.map((c) => `${c.emoji} ${c.title}: ${graded.byCat[c.id].ok}/${graded.byCat[c.id].all}`));
  lines.push('', forFeed ? `Сыграй и ты 👉 ${BOT_LINK}` : '📣 Нажмите кнопку ниже, чтобы поделиться результатом в ленте.');
  return lines.join('\n');
}

// ---- web-app API ---------------------------------------------------------------------------------------

const fail = (status, code, message, origin) => result(status, { ok: false, code, message }, origin);

async function authorized(body, origin) {
  const token = process.env.VVELCOM_BOT_TOKEN;
  if (!token) return { error: fail(503, 'NOT_CONFIGURED', 'Токен VVELCOM_BOT_TOKEN не настроен.', origin) };
  const auth = verifyInitData(body?.initData, token);
  if (!auth) return { error: fail(401, 'INVALID_INIT_DATA', 'Не удалось подтвердить вход. Откройте игру из чата бота ещё раз.', origin) };
  return { auth };
}
function cleanSettings(body) {
  const cats = Array.isArray(body?.cats) ? rules.CATEGORIES.map((c) => c.id).filter((id) => body.cats.includes(id)) : [];
  const difficulty = Number(body?.difficulty);
  const count = Number(body?.count);
  if (!cats.length || !diffById.has(difficulty) || !rules.COUNTS.includes(count)) return null;
  return { cats, difficulty, count };
}
function newRoundQuestions(settings) {
  const seed = crypto.randomInt(0, 2 ** 32);
  return rules.pickQuestions(bank, { ...settings, seed }).map((q) => q.id);
}
const publicRound = (round) => ({ id: round.id, cats: round.cats, difficulty: round.difficulty, count: round.ids.length, ids: round.ids, expiresAt: round.expiresAt, closed: stats.isClosed(round) });
const boardFor = (rows, userId) => rows.map((r, i) => ({ place: i + 1, name: r.name, score: r.score, correct: r.correct, total: r.total, me: r.userId === userId }));

async function roundInfo(auth, origin) {
  const match = ROUND_PARAM.exec(auth.startParam);
  const round = match && await stats.getRound(match[1]);
  if (!round) return fail(404, 'ROUND_NOT_FOUND', 'Раунд не найден. Возможно, он устарел.', origin);
  await closeIfExpired(round);
  const rows = await stats.roundResults(round.id);
  const mine = rows.findIndex((r) => r.userId === auth.userId);
  return result(200, {
    ok: true, round: publicRound(round), board: boardFor(rows, auth.userId).slice(0, BOARD_ROWS), players: rows.length,
    played: mine >= 0, myPlace: mine >= 0 ? mine + 1 : null, myResult: mine >= 0 ? { score: rows[mine].score, correct: rows[mine].correct, total: rows[mine].total } : null,
  }, origin);
}

async function recordAction(body, auth, origin) {
  const graded = stats.scoreAnswers(bankMap, body.answers);
  if (!graded) return fail(422, 'INVALID_RESULT', 'Результат не соответствует вопросам.', origin);
  const player = await stats.ensurePlayer(auth.userId, auth.name);
  if (body.round === true) {
    const match = ROUND_PARAM.exec(auth.startParam);
    const round = match && await stats.getRound(match[1]);
    if (!round) return fail(404, 'ROUND_NOT_FOUND', 'Раунд не найден. Возможно, он устарел.', origin);
    if (await closeIfExpired(round)) return fail(410, 'ROUND_CLOSED', 'Раунд уже завершён.', origin);
    const sameQuestions = graded.details.length === round.ids.length && graded.details.every((d) => round.ids.includes(d.id));
    if (!sameQuestions) return fail(422, 'WRONG_QUESTIONS', 'Ответы не относятся к вопросам этого раунда.', origin);
    const saved = await stats.addRoundResult(round.id, auth.userId, player.name, graded);
    if (saved.existing) return fail(409, 'ALREADY_PLAYED', 'Вы уже играли в этом раунде: у каждого одна попытка.', origin);
    const overall = await stats.recordGame(auth.userId, auth.name, graded, { roundId: round.id });
    await refreshRoundMessage(round);
    const rows = await stats.roundResults(round.id);
    const place = rows.findIndex((r) => r.userId === auth.userId) + 1;
    return result(200, { ok: true, score: graded.score, correct: graded.correct, total: graded.total, ranked: graded.ranked, ...overall, round: { place, players: rows.length, board: boardFor(rows, auth.userId).slice(0, BOARD_ROWS) } }, origin);
  }
  if (graded.total < 5 || graded.total > 30) return fail(422, 'INVALID_RESULT', 'Недопустимое число вопросов.', origin);
  const overall = await stats.recordGame(auth.userId, auth.name, graded);
  return result(200, { ok: true, score: graded.score, correct: graded.correct, total: graded.total, ranked: graded.ranked, ...overall }, origin);
}

/** The web app asks for a round for the chat it was opened from: the message goes out with answerWebAppQuery. */
async function createRoundAction(body, auth, origin) {
  const settings = cleanSettings(body);
  if (!settings) return fail(422, 'INVALID_SETTINGS', 'Выберите категории, сложность и число вопросов.', origin);
  if (!auth.queryId) return fail(409, 'QUERY_UNAVAILABLE', 'Раунд можно отправить, только если игра открыта кнопкой из чата.', origin);
  const round = await stats.createRound({ ...settings, ids: newRoundQuestions(settings), creatorId: auth.userId, chatId: '', messageId: '' });
  const article = {
    type: 'article', id: crypto.randomUUID(), title: '🧠 Квиз-раунд',
    input_message_content: { message_text: roundText(round, []) },
    reply_markup: roundMarkup(round, []),
  };
  try {
    const sent = await callBotApi('answerWebAppQuery', { web_app_query_id: auth.queryId, result: article });
    // If the platform tells where the message went, the results table will be kept up to date in it.
    const chatId = sent?.chat_id || sent?.chat?.id;
    const messageId = sent?.id || sent?.message_id;
    if (chatId && messageId) { round.chatId = String(chatId); round.messageId = String(messageId); await stats.updateRound(round); }
    return result(200, { ok: true, sentToChat: true, tracked: Boolean(round.messageId), roundId: round.id, message: 'Раунд отправлен в чат.' }, origin);
  } catch (error) {
    console.error('createRound bot API failure', error.name || 'Error', error.statusCode || 'no-http-status');
    return fail(502, 'BOT_DELIVERY_FAILED', 'VVelcom не принял раунд. Повторите попытку из чата бота.', origin);
  }
}

async function shareAction(body, auth, origin) {
  const graded = stats.scoreAnswers(bankMap, body.answers);
  if (!graded) return fail(422, 'INVALID_RESULT', 'Результат не соответствует вопросам.', origin);
  if (!auth.queryId) return fail(409, 'QUERY_UNAVAILABLE', 'VVelcom не передал query_id. Откройте игру через web_app-кнопку в сообщении бота, либо поделитесь результатом обычным способом.', origin);
  const article = {
    type: 'article', id: crypto.randomUUID(), title: '🧠 Мой результат в квизе',
    input_message_content: { message_text: resultText(graded) },
    reply_markup: { inline_keyboard: [[{ text: '📣 В ленту', share_to_feed: { text: resultText(graded, true) } }]] },
  };
  try {
    await callBotApi('answerWebAppQuery', { web_app_query_id: auth.queryId, result: article });
    return result(200, { ok: true, sentToChat: true, closesMiniApp: true, message: 'Результат отправлен в чат. Нажмите «В ленту» под сообщением, чтобы поделиться.' }, origin);
  } catch (error) {
    console.error('share bot API failure', error.name || 'Error', error.statusCode || 'no-http-status');
    return fail(502, 'BOT_DELIVERY_FAILED', 'VVelcom не принял результат. Повторите попытку из чата бота.', origin);
  }
}

async function playerAction(body, origin) {
  const { auth, error } = await authorized(body, origin);
  if (error) return error;
  try {
    switch (body.action) {
      case 'round': return await roundInfo(auth, origin);
      case 'record': return await recordAction(body, auth, origin);
      case 'createRound': return await createRoundAction(body, auth, origin);
      case 'share': return await shareAction(body, auth, origin);
      case 'rename': {
        const name = await stats.setName(auth.userId, auth.name, body.name);
        if (!name) return fail(422, 'INVALID_NAME', 'Введите имя от 1 до 24 символов.', origin);
        return result(200, { ok: true, name }, origin);
      }
      case 'leaderboard': {
        const [board, me] = await Promise.all([stats.leaderboard(10, auth.userId), stats.playerStats(auth.userId, auth.name)]);
        return result(200, { ok: true, board, me }, origin);
      }
      default: return fail(400, 'UNKNOWN_ACTION', 'Неизвестное действие.', origin);
    }
  } catch (e) {
    console.error('quiz failure', e.name || 'Error', e.code || '');
    return fail(500, 'STORAGE_UNAVAILABLE', 'Сервис сейчас недоступен. Попробуйте позже.', origin);
  }
}

// ---- chat: commands and buttons ------------------------------------------------------------------------

const HELP_UNKNOWN = '🤔 Я не понял Ваше сообщение.\n\nВот что я умею:';
const HELP_TEXT = [
  HELP_UNKNOWN,
  '🎮 /play — играть в одиночку',
  '🧠 /quiz — квиз-раунд для чата или группы',
  '🏆 /top — рейтинг игроков',
  '📊 /stats — моя статистика',
  '✏️ /name Новое имя — сменить имя в рейтинге',
  '',
  'Или нажмите кнопку ниже 👇',
].join('\n');

function menuMarkup() {
  const gameUrl = process.env.GAME_URL || '';
  const rows = [];
  if (gameUrl.startsWith('https://')) rows.push([{ text: '🎮 Играть', web_app: { url: gameUrl } }]);
  rows.push([{ text: '🧠 Раунд для чата', callback_data: 'qz:new' }]);
  rows.push([{ text: '🏆 Рейтинг', callback_data: 'qz:top' }, { text: '📊 Статистика', callback_data: 'qz:stats' }]);
  rows.push([{ text: '✏️ Сменить имя', callback_data: 'qz:name' }]);
  return { inline_keyboard: rows };
}
/**
 * Settings of a round, chosen with buttons. The whole state sits in callback_data («qz:c:<category mask>:<difficulty>:<count index>»):
 * every button carries the state it leads to, so nothing is stored while the creator is choosing.
 */
function settingsView(mask, difficulty, countIndex) {
  const data = (kind, m, d, n) => `qz:${kind}:${m}:${d}:${n}`;
  const all = (1 << rules.CATEGORIES.length) - 1;
  const rows = [];
  for (let i = 0; i < rules.CATEGORIES.length; i += 2) {
    rows.push(rules.CATEGORIES.slice(i, i + 2).map((c, k) => ({
      text: `${mask & (1 << (i + k)) ? '☑' : '☐'} ${c.emoji} ${c.title}`, callback_data: data('c', mask ^ (1 << (i + k)), difficulty, countIndex),
    })));
  }
  rows.push([mask === all ? { text: '☐ Снять все', callback_data: data('c', 0, difficulty, countIndex) } : { text: '☑ Выбрать все', callback_data: data('c', all, difficulty, countIndex) }]);
  for (let i = 0; i < rules.DIFFICULTIES.length; i += 2) {
    rows.push(rules.DIFFICULTIES.slice(i, i + 2).map((d) => ({
      text: `${d.id === difficulty ? '🔘' : '⚪'} ${d.emoji} ${d.title}`, callback_data: data('c', mask, d.id, countIndex),
    })));
  }
  rows.push(rules.COUNTS.map((n, i) => ({ text: `${i === countIndex ? '🔘' : '⚪'} ${n} вопр.`, callback_data: data('c', mask, difficulty, i) })));
  rows.push([{ text: '▶️ Создать раунд', callback_data: data('go', mask, difficulty, countIndex) }]);
  const text = ['🧠 Новый квиз-раунд', '', 'Отметьте категории, выберите сложность и число вопросов. У всех игроков раунда будут одни и те же вопросы, а таблица результатов обновляется прямо в этом сообщении.'].join('\n');
  return { text, markup: { inline_keyboard: rows } };
}
const DEFAULT_SETTINGS = [(1 << rules.CATEGORIES.length) - 1, 0, 0];

function profileNameOf(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '';
  return name === 'Пользователь' ? '' : name;
}
// One reply per command, shared by typed commands and menu buttons. Returns {text, markup}.
async function commandReply(cmd, arg, from) {
  const userId = String(from.id);
  const profileName = profileNameOf(from);
  if (cmd === 'top') {
    const board = await stats.leaderboard(10, userId);
    const text = topText(board);
    const shareable = board.top.length > 0;
    return { text, markup: shareable ? { inline_keyboard: [[{ text: '📣 В ленту', share_to_feed: { text: topText(board, BOT_LINK) } }]] } : undefined };
  }
  if (cmd === 'stats' || cmd === 'mystats') {
    const mine = await stats.playerStats(userId, profileName);
    const shareable = mine.games > 0;
    return { text: stats.statsText(mine), markup: shareable ? { inline_keyboard: [[{ text: '📣 В ленту', share_to_feed: { text: stats.statsText(mine, BOT_LINK) } }]] } : undefined };
  }
  if (cmd === 'name' || cmd === 'rename' || cmd === 'setname') {
    if (!arg) {
      const mine = await stats.playerStats(userId, profileName);
      return { text: `✏️ Сейчас Вас зовут «${mine.name}».\n\nЧтобы сменить имя в рейтинге, отправьте: /name Новое имя\nНапример: /name Алексей` };
    }
    const name = await stats.setName(userId, profileName, arg);
    if (!name) return { text: 'Введите имя от 1 до 24 символов, например: /name Алексей' };
    return { text: `✅ Готово! Теперь в рейтинге Вы — «${name}».` };
  }
  if (cmd === 'quiz' || cmd === 'round' || cmd === 'new') {
    const view = settingsView(...DEFAULT_SETTINGS);
    return { text: view.text, markup: view.markup };
  }
  if (cmd === 'help') return { text: HELP_TEXT.replace(HELP_UNKNOWN, '📋 Что я умею:'), markup: menuMarkup() };
  return null;
}
async function startReply(chatId) {
  const gameUrl = process.env.GAME_URL || '';
  const keyboard = [];
  if (gameUrl.startsWith('https://')) keyboard.push([{ text: '🎮 Играть', web_app: { url: gameUrl } }]);
  keyboard.push([{ text: '🧠 Раунд для чата', callback_data: 'qz:new' }]);
  await callBotApi('sendMessage', {
    chat_id: chatId,
    text: '🧠 Это квиз: автомобили, история, ИТ, фильмы и комиксы. Нажмите «Играть» или создайте раунд для друзей — все ответят на одни и те же вопросы, а результаты соберутся в одной таблице.',
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleCallback(query) {
  const answer = (extra = {}) => callBotApi('answerCallbackQuery', { callback_query_id: query.id, ...extra }).catch(() => {});
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.id;
  const data = String(query.data);
  const parts = data.split(':');
  if (parts[1] === 'c' || parts[1] === 'go') {
    const mask = Number(parts[2]), difficulty = Number(parts[3]), countIndex = Number(parts[4]);
    const valid = Number.isInteger(mask) && mask >= 0 && mask < (1 << rules.CATEGORIES.length) && diffById.has(difficulty) && rules.COUNTS[countIndex];
    if (!valid || !chatId || !messageId) { await answer(); return; }
    if (parts[1] === 'c') {
      const view = settingsView(mask, difficulty, countIndex);
      await answer();
      await callBotApi('editMessageText', { chat_id: chatId, message_id: messageId, text: view.text, reply_markup: view.markup }).catch(() => {});
      return;
    }
    if (!mask) { await answer({ text: 'Выберите хотя бы одну категорию', show_alert: true }); return; }
    const settings = { cats: rules.maskToCats(mask), difficulty, count: rules.COUNTS[countIndex] };
    const round = await stats.createRound({ ...settings, ids: newRoundQuestions(settings), creatorId: String(query.from?.id || ''), chatId: String(chatId), messageId: String(messageId) });
    await answer();
    await callBotApi('editMessageText', { chat_id: chatId, message_id: messageId, text: roundText(round, []), reply_markup: roundMarkup(round, []) });
    return;
  }
  const cmd = parts[1];
  if (!chatId || !query.from?.id) { await answer(); return; }
  if (cmd === 'new') {
    const view = settingsView(...DEFAULT_SETTINGS);
    await answer();
    await callBotApi('sendMessage', { chat_id: chatId, text: view.text, reply_markup: view.markup });
    return;
  }
  const reply = await commandReply(cmd, '', query.from);
  await answer();
  if (reply) await callBotApi('sendMessage', { chat_id: chatId, text: reply.text, ...(reply.markup ? { reply_markup: reply.markup } : {}) });
}

async function webhook(event) {
  const headers = headersOf(event);
  const secret = process.env.VVELCOM_WEBHOOK_SECRET;
  if (!secret || !constantTimeEqual(headers['x-messenger-webhook-secret'] || headers['x-telegram-bot-api-secret-token'] || '', secret)) {
    return result(403, { ok: false, code: 'WEBHOOK_FORBIDDEN' });
  }
  let update;
  try { update = parseBody(event); } catch { return result(400, { ok: false, code: 'BAD_UPDATE' }); }
  try {
    // Buttons of this bot (callback_data «qz:…»); any other callback is not ours and is ignored.
    const query = update?.callback_query;
    if (query && typeof query.data === 'string' && /^qz:/.test(query.data)) {
      await handleCallback(query);
      return result(200, { ok: true });
    }
    const message = update?.message;
    if (!message?.chat?.id || message.from?.is_bot) return result(200, { ok: true });
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/(start|play)(?:@\S+)?(?:\s|$)/i.test(text)) {
      await startReply(message.chat.id);
      return result(200, { ok: true });
    }
    if (!message.from?.id) return result(200, { ok: true });
    const command = text.match(/^\/(\w+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
    const reply = command ? await commandReply(command[1].toLowerCase(), (command[2] || '').trim(), message.from) : null;
    await callBotApi('sendMessage', { chat_id: message.chat.id, text: reply ? reply.text : HELP_TEXT, reply_markup: reply ? reply.markup : menuMarkup() });
  } catch (error) {
    console.error('webhook failure', error.name || 'Error', error.statusCode || error.code || '');
    return result(500, { ok: false, code: 'WEBHOOK_PROCESSING_FAILED' });
  }
  return result(200, { ok: true });
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
  // CORS is an extra safeguard, not authorization; initData is always required for every action.
  if (origin && !allowedOrigin(origin)) return fail(403, 'ORIGIN_FORBIDDEN', 'Адрес сайта не разрешён в ALLOWED_ORIGINS.');
  if (method === 'OPTIONS') return result(204, {}, origin);
  if (method === 'GET') return result(200, { ok: true, service: 'quiz', version: '1.0', configured: Boolean(process.env.VVELCOM_BOT_TOKEN), questions: bank.length }, origin);
  if (method !== 'POST') return result(405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, origin);
  let body;
  try { body = parseBody(event); } catch { return fail(400, 'INVALID_JSON', 'Неверный формат запроса.', origin); }
  return playerAction(body, origin);
}

module.exports = { handler, verifyInitData, roundText, roundMarkup, settingsView, topText, resultText };
