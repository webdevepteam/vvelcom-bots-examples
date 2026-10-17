'use strict';

// Rules shared by the web app and the cloud function (scripts/build-questions.js copies this file
// to cloud-function/): categories, how a round's questions are picked and how answers are scored.
// Both sides MUST use the same code, otherwise the server would disagree with the player's screen.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuizRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // The order is part of the format: bit i of a category mask (chat settings) is CATEGORIES[i].
  const CATEGORIES = [
    { id: 'cars', title: 'Автомобили', emoji: '🚗' },
    { id: 'history', title: 'История', emoji: '🏛' },
    { id: 'it', title: 'ИТ', emoji: '💻' },
    { id: 'movies', title: 'Фильмы', emoji: '🎬' },
    { id: 'comics', title: 'Комиксы', emoji: '🦸' },
  ];
  // difficulty: 1..3 = only that level, 0 = mixed (40 % easy, 40 % medium, 20 % hard).
  const DIFFICULTIES = [
    { id: 1, title: 'Лёгкая', emoji: '🌱' },
    { id: 2, title: 'Средняя', emoji: '🧠' },
    { id: 3, title: 'Сложная', emoji: '🔥' },
    { id: 0, title: 'Смешанная', emoji: '🎲' },
  ];
  const COUNTS = [15, 20, 30];
  const QUESTION_SECONDS = 20;
  const WEIGHT = { 1: 10, 2: 20, 3: 30 };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, rnd) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // The level to take from first, then the nearest ones, when a category has too few of that level.
  function levelOrder(level) {
    return level === 1 ? [1, 2, 3] : level === 3 ? [3, 2, 1] : [2, 1, 3];
  }
  function levelNeeds(difficulty, n) {
    if (difficulty >= 1 && difficulty <= 3) return { [difficulty]: n };
    const hard = Math.round(n * 0.2);
    const easy = Math.round(n * 0.4);
    return { 1: easy, 2: n - easy - hard, 3: hard };
  }

  /**
   * Picks the questions of a round. Same {cats, difficulty, count, seed} → the same questions in the same
   * order, so every player of a group round gets one set. Categories are represented evenly; a level
   * that a category does not have enough of is topped up from the nearest level.
   * Returns question objects from `bank` (the caller sends only ids over the network).
   */
  function pickQuestions(bank, { cats, difficulty, count, seed }) {
    const rnd = mulberry32(seed);
    const ids = CATEGORIES.map((c) => c.id).filter((id) => cats.includes(id));
    if (!ids.length) return [];
    const total = Math.min(count, bank.filter((q) => ids.includes(q.c)).length);
    const lists = {};
    for (const id of ids) {
      lists[id] = { 1: [], 2: [], 3: [] };
      for (const q of shuffle(bank.filter((x) => x.c === id), rnd)) lists[id][q.d].push(q);
    }
    const order = shuffle(ids, rnd);
    const chosen = [];
    const take = (id, level, n) => {
      for (const l of levelOrder(level)) {
        while (n > 0 && lists[id][l].length) { chosen.push(lists[id][l].pop()); n--; }
      }
      return n;
    };
    let missing = 0;
    order.forEach((id, i) => {
      const quota = Math.floor(total / ids.length) + (i < total % ids.length ? 1 : 0);
      const needs = levelNeeds(difficulty, quota);
      for (const level of [1, 2, 3]) missing += take(id, level, needs[level] || 0);
    });
    // A category ran out of questions: the rest comes from the other chosen categories.
    for (const id of order) {
      if (!missing) break;
      missing = take(id, difficulty || 2, missing);
    }
    return shuffle(chosen, rnd);
  }

  /** Points for one answer: the level weight, plus up to +50 % for a fast answer. 0 for a wrong or missing one. */
  function pointsFor(level, correct, ms) {
    if (!correct) return 0;
    const weight = WEIGHT[level] || 0;
    const left = 1 - Math.min(Math.max(ms, 0), QUESTION_SECONDS * 1000) / (QUESTION_SECONDS * 1000);
    return weight + Math.round(weight * 0.5 * left);
  }

  const maskToCats = (mask) => CATEGORIES.filter((_, i) => mask & (1 << i)).map((c) => c.id);
  const catsToMask = (cats) => CATEGORIES.reduce((m, c, i) => (cats.includes(c.id) ? m | (1 << i) : m), 0);

  return { CATEGORIES, DIFFICULTIES, COUNTS, QUESTION_SECONDS, WEIGHT, pickQuestions, pointsFor, maskToCats, catsToMask, mulberry32 };
});
