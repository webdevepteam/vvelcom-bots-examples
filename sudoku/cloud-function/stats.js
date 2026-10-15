'use strict';

// Player results and the leaderboard. Data lives in a Yandex Cloud Functions mounted storage
// (SUDOKU_STORAGE_DIR, default /function/storage/sudoku-vv-app), one folder per VVelcom user id:
//   players/<userId>/player.json = { id, name, nameCustom, createdAt, games: [...], bests: {...} }
// The user id from initData is unique and permanent, so the history survives name changes.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const LEVELS = ['mini', 'junior', 'classic', 'challenge', 'master'];
const LEVEL_TITLES = { mini: 'Новичок 🌱', junior: 'Легко 🌈', classic: 'Средне 🧠', challenge: 'Сложно 🔥', master: 'Эксперт 🏆' };
// Points per empty cell: the harder the puzzle, the more a cell is worth.
const WEIGHT = { mini: 5, junior: 8, classic: 12, challenge: 18, master: 25 };
// "Par" pace in seconds per empty cell: solving at par gives the full base score.
const PAR_PER_CELL = { mini: 3, junior: 5, classic: 6, challenge: 8, master: 10 };
// Faster than this per empty cell is not humanly plausible: such a game is saved but not ranked.
const MIN_SECONDS_PER_CELL = 0.7;
const MAX_GAMES_KEPT = 500;
const CACHE_MS = 15000;

let cache = { at: 0, players: null };

function storageDir() { return process.env.SUDOKU_STORAGE_DIR || '/function/storage/sudoku-vv-app'; }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Score of one solved puzzle = empty cells × level weight × quality, where quality is
 *   speed:   par pace / your pace, clamped to 0.25…1.5 (faster than par pays up to +50 %),
 *   errors:  −8 % per mistake, at most −60 %,
 *   hints:   −15 % per hint used, at most −45 %.
 * Because the base grows with the number of cells and the level weight, a flawless 9×9 expert
 * game is worth far more than a flawless 4×4 one, while a slow, error-ridden game is never zero.
 */
function computeScore(level, emptyCells, elapsed, mistakes, hintsUsed) {
  const speed = clamp((PAR_PER_CELL[level] * emptyCells) / Math.max(elapsed, 1), 0.25, 1.5);
  const accuracy = Math.max(0.4, 1 - 0.08 * mistakes);
  const help = Math.max(0.55, 1 - 0.15 * hintsUsed);
  return Math.round(emptyCells * WEIGHT[level] * speed * accuracy * help);
}
const isPlausible = (emptyCells, elapsed) => elapsed >= emptyCells * MIN_SECONDS_PER_CELL;

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(name).slice(0, 24).join('');
}
function playerFile(userId) { return path.join(storageDir(), 'players', String(userId), 'player.json'); }

async function readPlayer(userId) {
  try { return JSON.parse(await fs.readFile(playerFile(userId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writePlayer(player) {
  const file = playerFile(player.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(player));
  await fs.rename(tmp, file);
  cache = { at: 0, players: null };
}

/** The player's record; a new one takes the VVelcom profile name, an existing custom name is kept. */
async function ensurePlayer(userId, profileName) {
  let player = await readPlayer(userId);
  const fallback = cleanName(profileName) || 'Игрок';
  if (!player) player = { id: String(userId), name: fallback, nameCustom: false, createdAt: Date.now(), games: [], bests: {} };
  else if (!player.nameCustom && player.name !== fallback) player.name = fallback;
  return player;
}

async function loadAll() {
  if (cache.players && Date.now() - cache.at < CACHE_MS) return cache.players;
  const players = [];
  let ids = [];
  try { ids = await fs.readdir(path.join(storageDir(), 'players')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const id of ids) {
    try { const p = await readPlayer(id); if (p) players.push(p); } catch { /* skip a broken file */ }
  }
  cache = { at: Date.now(), players };
  return players;
}

/** Rating = the sum of the player's best scores over all five levels (so every level matters). */
function ratingOf(player) { return LEVELS.reduce((sum, l) => sum + (player.bests?.[l]?.score || 0), 0); }

async function recordGame(userId, profileName, game) {
  const player = await ensurePlayer(userId, profileName);
  const level = game.puzzle.level;
  const empty = game.puzzle.givens.filter((v) => v === 0).length;
  const ranked = isPlausible(empty, game.elapsed);
  const score = computeScore(level, empty, game.elapsed, game.mistakes, game.hintsUsed);
  const last = player.games[player.games.length - 1];
  const duplicate = last && last.puzzleId === game.puzzle.id && last.elapsed === game.elapsed &&
    last.mistakes === game.mistakes && Date.now() - last.at < 60000;
  let newBest = false;
  if (!duplicate) {
    player.games.push({ at: Date.now(), puzzleId: game.puzzle.id, level, elapsed: game.elapsed, mistakes: game.mistakes, hints: game.hintsUsed, score, ranked });
    if (player.games.length > MAX_GAMES_KEPT) player.games.splice(0, player.games.length - MAX_GAMES_KEPT);
    const best = player.bests[level];
    if (ranked && (!best || score > best.score)) {
      player.bests[level] = { score, elapsed: game.elapsed, mistakes: game.mistakes, hints: game.hintsUsed, at: Date.now() };
      newBest = true;
    }
    await writePlayer(player);
  }
  const board = await leaderboard('all', 0, userId);
  return { score, ranked, newBest, rating: ratingOf(player), place: board.me?.place ?? null, total: board.total };
}

async function setName(userId, profileName, rawName) {
  const name = cleanName(rawName);
  if (!name) return null;
  const player = await ensurePlayer(userId, profileName);
  player.name = name; player.nameCustom = true;
  await writePlayer(player);
  return name;
}

/** level = 'all' ranks by rating, a level id ranks by the best score on that level. */
async function leaderboard(level, limit, userId) {
  const players = await loadAll();
  const valueOf = (p) => (level === 'all' ? ratingOf(p) : p.bests?.[level]?.score || 0);
  const rows = players.map((p) => ({ id: p.id, name: p.name, value: valueOf(p), games: p.games.length }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.place = i + 1; });
  const me = rows.find((r) => r.id === String(userId)) || null;
  return { level, total: rows.length, top: rows.slice(0, limit).map(({ id, ...rest }) => ({ ...rest, me: id === String(userId) })), me: me && { place: me.place, value: me.value } };
}

async function playerStats(userId, profileName) {
  const player = await ensurePlayer(userId, profileName);
  const avg = (list, key) => (list.length ? list.reduce((s, g) => s + g[key], 0) / list.length : 0);
  const perLevel = {};
  for (const level of LEVELS) {
    const games = player.games.filter((g) => g.level === level);
    if (!games.length) continue;
    perLevel[level] = {
      games: games.length,
      bestTime: Math.min(...games.map((g) => g.elapsed)),
      avgTime: Math.round(avg(games, 'elapsed')),
      avgMistakes: Math.round(avg(games, 'mistakes') * 10) / 10,
      avgHints: Math.round(avg(games, 'hints') * 10) / 10,
      bestScore: player.bests[level]?.score || 0,
    };
  }
  const all = player.games;
  const board = await leaderboard('all', 0, userId);
  return {
    name: player.name,
    games: all.length,
    totalTime: all.reduce((s, g) => s + g.elapsed, 0),
    avgTime: Math.round(avg(all, 'elapsed')),
    avgMistakes: Math.round(avg(all, 'mistakes') * 10) / 10,
    avgHints: Math.round(avg(all, 'hints') * 10) / 10,
    flawless: all.filter((g) => g.mistakes === 0 && g.hints === 0).length,
    rating: ratingOf(player),
    place: board.me?.place ?? null,
    total: board.total,
    perLevel,
  };
}

function formatTime(t) {
  const s = t % 60; const m = Math.floor(t / 60) % 60; const h = Math.floor(t / 3600);
  const mm = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${String(h).padStart(2, '0')}:${mm}` : mm;
}

/** Text of «Моя статистика»; with an invite it is the first-person feed version. */
function statsText(stats, invite = '') {
  if (!stats.games) return '📊 Пока нет сыгранных партий в Судоку.';
  const lines = ['📊 Моя статистика в Судоку', ''];
  lines.push(`🏅 Рейтинг: ${stats.rating}${stats.place ? ` · ${stats.place}-е место из ${stats.total}` : ''}`);
  lines.push(`🎮 Партий: ${stats.games} · без ошибок и подсказок: ${stats.flawless}`);
  lines.push(`⏱ Среднее время: ${formatTime(stats.avgTime)} · всего в игре: ${formatTime(stats.totalTime)}`);
  lines.push(`🎯 Ошибок в среднем: ${stats.avgMistakes} · 💡 подсказок: ${stats.avgHints}`);
  for (const level of LEVELS) {
    const l = stats.perLevel[level];
    if (!l) continue;
    lines.push('', `${LEVEL_TITLES[level]}: партий ${l.games}`,
      `   лучшее ${formatTime(l.bestTime)} · среднее ${formatTime(l.avgTime)} · ошибки ${l.avgMistakes} · очки ${l.bestScore}`);
  }
  if (invite) lines.push('', `Попробуй и ты 👉 ${invite}`);
  return lines.join('\n');
}

module.exports = { LEVELS, computeScore, isPlausible, cleanName, recordGame, setName, leaderboard, playerStats, statsText, ratingOf };
