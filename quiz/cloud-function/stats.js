'use strict';

// Everything the quiz remembers lives in a Yandex Cloud Functions mounted storage
// (QUIZ_STORAGE_DIR, default /function/storage/quiz-vv-app):
//   players/<userId>/player.json          { id, name, nameCustom, createdAt, games, top, answered, correct, byCat }
//   rounds/<roundId>/round.json           the round's settings, its question ids and the chat message to keep up to date
//   rounds/<roundId>/results/<userId>.json   one file per player, so two players finishing at once never overwrite each other
// The user id from the signed initData is permanent, so history survives name changes.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const rules = require('./quiz-rules');

const MAX_GAMES_KEPT = 200;
const TOP_GAMES = 10;
// A human cannot read and tap a question faster than this on average: such a game is saved but not ranked.
const MIN_AVG_MS = 1200;
const CACHE_MS = 15000;

let cache = { at: 0, players: null };

function storageDir() { return process.env.QUIZ_STORAGE_DIR || '/function/storage/quiz-vv-app'; }

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(name).slice(0, 24).join('');
}
function anonymousName(userId) {
  return `Игрок ${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 4)}`;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

// ---- players -------------------------------------------------------------------------------------------

const playerFile = (userId) => path.join(storageDir(), 'players', String(userId), 'player.json');

async function ensurePlayer(userId, profileName) {
  let player = await readJson(playerFile(userId));
  const profile = cleanName(profileName);
  const fallback = !profile || profile === 'Пользователь' ? anonymousName(userId) : profile;
  if (!player) player = { id: String(userId), name: fallback, nameCustom: false, createdAt: Date.now(), games: [], top: [], answered: 0, correct: 0, byCat: {} };
  else if (!player.nameCustom && player.name !== fallback) player.name = fallback;
  return player;
}
async function savePlayer(player) {
  await writeJson(playerFile(player.id), player);
  cache = { at: 0, players: null };
}
async function setName(userId, profileName, rawName) {
  const name = cleanName(rawName);
  if (!name) return null;
  const player = await ensurePlayer(userId, profileName);
  player.name = name; player.nameCustom = true;
  await savePlayer(player);
  return name;
}
async function loadAll() {
  if (cache.players && Date.now() - cache.at < CACHE_MS) return cache.players;
  const players = [];
  let ids = [];
  try { ids = await fs.readdir(path.join(storageDir(), 'players')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const id of ids) {
    try { const p = await readJson(playerFile(id)); if (p) players.push(p); } catch { /* skip a broken file */ }
  }
  cache = { at: Date.now(), players };
  return players;
}

/** Rating = the sum of the player's TOP_GAMES best games: it grows with play, but cannot be farmed by repeating. */
const ratingOf = (player) => (player.top || []).reduce((sum, v) => sum + v, 0);

/**
 * Checks the answers against the question bank and scores them.
 * answers: [{ id, a, t }] — a is the index in the question's original `a` array (0 is the right one; −1 = time ran out),
 * t is how many ms the player thought. Returns null for anything malformed.
 */
function scoreAnswers(bankMap, answers) {
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 60) return null;
  const seen = new Set();
  let score = 0, correct = 0, totalMs = 0;
  const byCat = {};
  const details = [];
  for (const item of answers) {
    const q = item && bankMap.get(item.id);
    if (!q || seen.has(q.id) || !Number.isInteger(item.a) || item.a < -1 || item.a > 3) return null;
    seen.add(q.id);
    const ms = Math.min(Math.max(Number.isFinite(item.t) ? Math.round(item.t) : rules.QUESTION_SECONDS * 1000, 400), rules.QUESTION_SECONDS * 1000);
    const ok = item.a === 0;
    if (ok) correct++;
    score += rules.pointsFor(q.d, ok, ms);
    totalMs += ms;
    byCat[q.c] = byCat[q.c] || { ok: 0, all: 0 };
    byCat[q.c].all++;
    if (ok) byCat[q.c].ok++;
    details.push({ id: q.id, ok });
  }
  return { score, correct, total: answers.length, totalMs, ranked: totalMs / answers.length >= MIN_AVG_MS, byCat, details };
}

async function recordGame(userId, profileName, graded, meta = {}) {
  const player = await ensurePlayer(userId, profileName);
  const last = player.games[player.games.length - 1];
  const duplicate = last && last.score === graded.score && last.correct === graded.correct && last.total === graded.total &&
    last.roundId === (meta.roundId || null) && Date.now() - last.at < 60000;
  let newBest = false;
  if (!duplicate) {
    player.games.push({ at: Date.now(), roundId: meta.roundId || null, correct: graded.correct, total: graded.total, score: graded.score, ranked: graded.ranked });
    if (player.games.length > MAX_GAMES_KEPT) player.games.splice(0, player.games.length - MAX_GAMES_KEPT);
    player.answered += graded.total; player.correct += graded.correct;
    for (const [cat, v] of Object.entries(graded.byCat)) {
      const own = player.byCat[cat] = player.byCat[cat] || { ok: 0, all: 0 };
      own.ok += v.ok; own.all += v.all;
    }
    if (graded.ranked) {
      newBest = player.top.length < TOP_GAMES || graded.score > player.top[player.top.length - 1];
      player.top = [...player.top, graded.score].sort((a, b) => b - a).slice(0, TOP_GAMES);
    }
    await savePlayer(player);
  }
  const board = await leaderboard(0, userId);
  return { newBest: newBest && graded.ranked, rating: ratingOf(player), place: board.me?.place ?? null, total: board.total };
}

async function leaderboard(limit, userId) {
  const players = (await loadAll()).filter((p) => ratingOf(p) > 0);
  const sorted = players.map((p) => ({ id: p.id, name: p.name, value: ratingOf(p) }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  sorted.forEach((row, i) => { row.place = i + 1; });
  const me = sorted.find((row) => row.id === String(userId)) || null;
  return { top: sorted.slice(0, limit).map(({ place, name, value }) => ({ place, name, value })), me: me && { place: me.place, name: me.name, value: me.value }, total: sorted.length };
}

async function playerStats(userId, profileName) {
  const player = await ensurePlayer(userId, profileName);
  const board = await leaderboard(0, userId);
  return {
    name: player.name, games: player.games.length, answered: player.answered, correct: player.correct,
    rating: ratingOf(player), best: player.top[0] || 0, place: board.me?.place ?? null, total: board.total,
    byCat: player.byCat,
  };
}
function statsText(s, invite) {
  if (!s.games) return '📊 Пока нет сыгранных партий. Нажмите «Играть» и ответьте на первые вопросы!';
  const accuracy = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
  const lines = [`📊 Статистика: ${s.name}`, '', `🎮 Партий: ${s.games}`, `✅ Верных ответов: ${s.correct} из ${s.answered} (${accuracy} %)`, `🏅 Лучшая партия: ${s.best}`, `⭐ Рейтинг: ${s.rating}${s.place ? ` · ${s.place}-е место из ${s.total}` : ''}`];
  const cats = rules.CATEGORIES.filter((c) => s.byCat[c.id]?.all);
  if (cats.length) lines.push('', ...cats.map((c) => `${c.emoji} ${c.title}: ${s.byCat[c.id].ok}/${s.byCat[c.id].all}`));
  if (invite) lines.push('', `Сыграй и ты 👉 ${invite}`);
  return lines.join('\n');
}

// ---- rounds --------------------------------------------------------------------------------------------

const ROUND_ID = /^[0-9a-f]{10}$/;
const roundDir = (id) => path.join(storageDir(), 'rounds', id);
const roundHours = () => Math.max(1, Number(process.env.ROUND_HOURS) || 24);

async function createRound(round) {
  const id = crypto.randomBytes(5).toString('hex');
  const data = { id, createdAt: Date.now(), expiresAt: Date.now() + roundHours() * 3600 * 1000, closedPosted: false, ...round };
  await writeJson(path.join(roundDir(id), 'round.json'), data);
  return data;
}
async function getRound(id) {
  if (!ROUND_ID.test(String(id))) return null;
  return readJson(path.join(roundDir(id), 'round.json'));
}
async function updateRound(round) { await writeJson(path.join(roundDir(round.id), 'round.json'), round); }
const isClosed = (round) => Date.now() > round.expiresAt;
/** Rounds created by a person that still accept results, newest first. */
async function activeRoundsOf(userId) {
  let ids = [];
  try { ids = await fs.readdir(path.join(storageDir(), 'rounds')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const out = [];
  for (const id of ids) {
    const round = ROUND_ID.test(id) ? await readJson(path.join(roundDir(id), 'round.json')).catch(() => null) : null;
    if (round && round.creatorId === String(userId) && !isClosed(round)) out.push(round);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
}
/** Ends a round ahead of time: results stop being accepted at once. */
async function closeRound(round) { round.expiresAt = Date.now() - 1; round.closedPosted = false; await updateRound(round); return round; }

async function roundResults(id) {
  let files = [];
  try { files = await fs.readdir(path.join(roundDir(id), 'results')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rows = [];
  for (const f of files) {
    try { const r = await readJson(path.join(roundDir(id), 'results', f)); if (r) rows.push(r); } catch { /* skip */ }
  }
  // The best score first; equal scores — more right answers, then the faster player.
  rows.sort((a, b) => b.score - a.score || b.correct - a.correct || a.totalMs - b.totalMs || a.at - b.at);
  return rows;
}
/** One attempt per player. Returns the stored result, or { existing } when the player has already played. */
async function addRoundResult(roundId, userId, name, graded) {
  const file = path.join(roundDir(roundId), 'results', `${String(userId)}.json`);
  const existing = await readJson(file);
  if (existing) return { existing };
  const row = { userId: String(userId), name, score: graded.score, correct: graded.correct, total: graded.total, totalMs: graded.totalMs, ranked: graded.ranked, at: Date.now() };
  await writeJson(file, row);
  return { row };
}

module.exports = {
  cleanName, scoreAnswers, recordGame, setName, leaderboard, playerStats, statsText, ensurePlayer,
  createRound, getRound, updateRound, isClosed, activeRoundsOf, closeRound, roundResults, addRoundResult, roundHours,
};
