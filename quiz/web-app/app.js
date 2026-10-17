(function () {
  'use strict';

  const R = window.QuizRules;
  const STORAGE = 'vvelcom.quiz.v1';
  const ROUND_PARAM = /^r_[0-9a-f]{10}$/;
  const $ = (selector) => document.querySelector(selector);
  const app = $('#app');

  let sdk = null;
  let backendUrl = '';
  let bank = [];
  let bankMap = new Map();
  let prefs = { cats: R.CATEGORIES.map((c) => c.id), difficulty: 0, countIndex: 0, best: 0 };
  let screen = 'home';
  let round = null;      // info of the group round this window was opened for (server answer of action «round»)
  let game = null;
  let timer = null;
  let booted = false;

  // ---- tiny DOM helper: text always goes in as text, so player names can never inject markup ------------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }
  function mount(...nodes) { app.replaceChildren(...nodes.flat()); window.scrollTo(0, 0); }
  function toast(text, isError) {
    const el = $('#toast');
    el.textContent = text;
    el.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.className = 'toast'; }, 3200);
  }
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };
  const catById = new Map(R.CATEGORIES.map((c) => [c.id, c]));
  const diffById = new Map(R.DIFFICULTIES.map((d) => [d.id, d]));
  const medal = (place) => ['🥇', '🥈', '🥉'][place - 1] || `${place}.`;
  function vibrate(kind) {
    try {
      if (kind === 'ok' || kind === 'bad') sdk?.HapticFeedback?.notificationOccurred?.(kind === 'ok' ? 'success' : 'error');
      else sdk?.HapticFeedback?.selectionChanged?.();
    } catch { /* haptics are optional */ }
  }

  // ---- local preferences ---------------------------------------------------------------------------------
  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null');
      if (!saved) return;
      const cats = Array.isArray(saved.cats) ? saved.cats.filter((id) => catById.has(id)) : [];
      if (cats.length) prefs.cats = cats;
      if (diffById.has(saved.difficulty)) prefs.difficulty = saved.difficulty;
      if (R.COUNTS[saved.countIndex]) prefs.countIndex = saved.countIndex;
      if (Number.isFinite(saved.best)) prefs.best = saved.best;
    } catch { /* storage may be blocked */ }
  }
  function savePrefs() { try { localStorage.setItem(STORAGE, JSON.stringify(prefs)); } catch { /* ignore */ } }

  // ---- backend -------------------------------------------------------------------------------------------
  const canTalk = () => Boolean(backendUrl && sdk?.initData);
  async function api(payload, timeout = 10000) {
    if (!canTalk()) return { ok: false, code: 'OFFLINE', message: 'Рейтинг доступен при запуске из VVelcom.' };
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(backendUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, initData: sdk.initData }), signal: controller.signal });
      return await response.json();
    } catch { return { ok: false, code: 'NETWORK', message: 'Нет связи с сервером. Попробуйте позже.' }; }
    finally { clearTimeout(timerId); }
  }
  const startParam = () => {
    const raw = sdk?.initDataUnsafe?.start_param || (sdk?.initData ? new URLSearchParams(sdk.initData).get('start_param') : '') || '';
    return ROUND_PARAM.test(raw) ? raw : '';
  };

  // ---- host integration ----------------------------------------------------------------------------------
  function integrateSdk() {
    try {
      const current = window.VVelcom?.WebApp || window.Telegram?.WebApp;
      if (!current || sdk === current) return;
      sdk = current;
      const embedded = Boolean(sdk.initData || window.ReactNativeWebView || (sdk.platform && !['unknown', 'web'].includes(String(sdk.platform).toLowerCase())));
      document.body.classList.toggle('is-embedded', embedded);
      if (sdk.colorScheme) document.body.classList.toggle('theme-dark', sdk.colorScheme === 'dark');
      sdk.ready?.(); sdk.expand?.();
      sdk.BackButton?.onClick?.(() => { if (screen !== 'home') goHome(); });
      sdk.onEvent?.('themeChanged', () => document.body.classList.toggle('theme-dark', sdk.colorScheme === 'dark'));
      // The SDK can arrive after the first screen: a round link must still open its round.
      if (booted && screen === 'home' && !game && startParam() && !round) openRound();
    } catch (error) { console.warn('VVelcom SDK unavailable:', error); }
  }
  function updateHostBack() {
    try { if (screen !== 'home') sdk?.BackButton?.show?.(); else sdk?.BackButton?.hide?.(); } catch { /* browser mode */ }
  }
  function setScreen(name) { screen = name; updateHostBack(); }

  // ---- home: category, difficulty and count --------------------------------------------------------------
  function goHome() {
    stopTimer(); game = null;
    setScreen('home');
    const total = bank.length;
    const pool = bank.filter((q) => prefs.cats.includes(q.c)).length;
    const count = Math.min(R.COUNTS[prefs.countIndex], pool);
    const allSelected = prefs.cats.length === R.CATEGORIES.length;
    const chip = (c) => {
      const on = prefs.cats.includes(c.id);
      return h('button', { type: 'button', class: 'chip', role: 'checkbox', 'aria-checked': String(on), onclick: () => { toggleCategory(c.id); } },
        h('span', { class: 'box', 'aria-hidden': 'true' }, on ? '✓' : ''), `${c.emoji} ${c.title}`);
    };
    const segment = (title, on, fn) => h('button', { type: 'button', class: 'segment', role: 'radio', 'aria-checked': String(on), onclick: fn }, title);
    mount(
      h('h1', {}, 'Квиз 🧠'),
      h('p', { class: 'lead' }, 'Выберите темы, сложность и число вопросов — и проверьте себя. Можно играть одному или устроить раунд для чата.'),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Категории'),
          h('button', { type: 'button', class: 'link-button', onclick: () => { prefs.cats = allSelected ? [prefs.cats[0]] : R.CATEGORIES.map((c) => c.id); savePrefs(); goHome(); } }, allSelected ? 'Только одна' : 'Выбрать все')),
        h('div', { class: 'chips', role: 'group', 'aria-label': 'Категории' }, R.CATEGORIES.map(chip))),
      h('section', { class: 'card' }, h('h2', {}, 'Сложность'),
        h('div', { class: 'segments', role: 'radiogroup', 'aria-label': 'Сложность' },
          R.DIFFICULTIES.map((d) => segment(`${d.emoji} ${d.title}`, prefs.difficulty === d.id, () => { prefs.difficulty = d.id; savePrefs(); goHome(); })))),
      h('section', { class: 'card' }, h('h2', {}, 'Вопросов'),
        h('div', { class: 'segments', role: 'radiogroup', 'aria-label': 'Число вопросов' },
          R.COUNTS.map((n, i) => segment(String(n), prefs.countIndex === i, () => { prefs.countIndex = i; savePrefs(); goHome(); })))),
      h('p', { class: 'hint' }, `${count} ${plural(count, 'вопрос', 'вопроса', 'вопросов')} из ${pool} в выбранных категориях (всего в игре ${total}). На ответ — ${R.QUESTION_SECONDS} секунд.${prefs.best ? ` Ваш рекорд: ${prefs.best}.` : ''}`),
      h('button', { type: 'button', class: 'button button-primary', onclick: startSolo }, 'Играть →'),
      canTalk() && sdk.initData && new URLSearchParams(sdk.initData).get('query_id')
        ? h('button', { type: 'button', class: 'button', onclick: createChatRound }, '🧠 Раунд для чата') : null,
      h('button', { type: 'button', class: 'button', onclick: showBoard }, '🏆 Рейтинг и моя статистика'));
  }
  function toggleCategory(id) {
    const next = prefs.cats.includes(id) ? prefs.cats.filter((x) => x !== id) : [...prefs.cats, id];
    if (!next.length) { toast('Выберите хотя бы одну категорию', true); return; }
    prefs.cats = R.CATEGORIES.map((c) => c.id).filter((x) => next.includes(x));
    savePrefs(); goHome();
  }

  async function createChatRound() {
    toast('Создаём раунд…');
    const data = await api({ action: 'createRound', cats: prefs.cats, difficulty: prefs.difficulty, count: R.COUNTS[prefs.countIndex] });
    if (!data.ok) { toast(data.message || 'Не удалось создать раунд', true); return; }
    toast(data.message || 'Раунд отправлен в чат');
    try { sdk?.close?.(); } catch { /* the window may stay open */ }
  }

  // ---- game ----------------------------------------------------------------------------------------------
  function toGameQuestion(q) {
    const options = q.a.map((text, orig) => ({ text, orig }));
    for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [options[i], options[j]] = [options[j], options[i]]; }
    return { id: q.id, c: q.c, d: q.d, q: q.q, options, answerText: q.a[0] };
  }
  function startSolo() {
    const seed = Math.floor(Math.random() * 2 ** 32);
    const picked = R.pickQuestions(bank, { cats: prefs.cats, difficulty: prefs.difficulty, count: R.COUNTS[prefs.countIndex], seed });
    if (picked.length < 5) { toast('В выбранных категориях мало вопросов', true); return; }
    beginGame(picked, null);
  }
  function startRound() {
    const picked = round.round.ids.map((id) => bankMap.get(id)).filter(Boolean);
    if (picked.length !== round.round.ids.length) { toast('Обновите приложение: в нём нет вопросов этого раунда', true); return; }
    beginGame(picked, round);
  }
  function beginGame(questions, roundInfo) {
    game = { questions: questions.map(toGameQuestion), index: 0, answers: [], score: 0, round: roundInfo, locked: false, startedAt: 0 };
    nextQuestion();
  }
  function stopTimer() { clearInterval(timer); timer = null; }

  function nextQuestion() {
    setScreen('game');
    const q = game.questions[game.index];
    const total = game.questions.length;
    const cat = catById.get(q.c);
    const diff = diffById.get(q.d);
    game.locked = false;
    game.startedAt = performance.now();
    const letters = ['A', 'B', 'C', 'D'];
    const bar = h('i', {});
    const timerBox = h('div', { class: 'timer', 'aria-hidden': 'true' }, bar);
    const verdict = h('p', { class: 'verdict', role: 'status' }, '');
    const next = h('button', { type: 'button', class: 'button button-primary hidden', onclick: advance }, game.index + 1 === total ? 'Результат →' : 'Дальше →');
    const buttons = q.options.map((option, i) => h('button', { type: 'button', class: 'option', onclick: () => answer(i) }, h('span', { class: 'letter' }, letters[i]), option.text));
    game.ui = { buttons, verdict, next, timerBox, bar };
    mount(
      h('div', { class: 'game-top' }, h('span', {}, 'Вопрос ', h('strong', {}, `${game.index + 1} / ${total}`)), h('span', {}, 'Очки ', h('strong', {}, game.score))),
      h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { style: `width:${(game.index / total) * 100}%` })),
      timerBox,
      h('span', { class: 'tag' }, `${cat.emoji} ${cat.title} · ${diff.emoji} ${diff.title}`),
      h('p', { class: 'question' }, q.q),
      h('div', { class: 'options' }, buttons), verdict, next);
    stopTimer();
    timer = setInterval(tick, 100);
    tick();
  }
  function tick() {
    if (!game || game.locked) return;
    const spent = performance.now() - game.startedAt;
    const left = Math.max(0, 1 - spent / (R.QUESTION_SECONDS * 1000));
    game.ui.bar.style.transform = `scaleX(${left})`;
    game.ui.timerBox.classList.toggle('low', left < 0.25);
    if (left <= 0) answer(-1);
  }
  function answer(chosen) {
    if (!game || game.locked) return;
    game.locked = true;
    stopTimer();
    const q = game.questions[game.index];
    const ms = Math.min(Math.round(performance.now() - game.startedAt), R.QUESTION_SECONDS * 1000);
    const orig = chosen >= 0 ? q.options[chosen].orig : -1;
    const ok = orig === 0;
    game.score += R.pointsFor(q.d, ok, ms);
    game.answers.push({ id: q.id, a: orig, t: ms });
    game.ui.buttons.forEach((button, i) => {
      button.disabled = true;
      if (q.options[i].orig === 0) button.classList.add('right');
      else if (i === chosen) button.classList.add('wrong');
    });
    game.ui.verdict.textContent = ok ? `Верно! +${R.pointsFor(q.d, true, ms)}` : orig === -1 ? 'Время вышло' : 'Неверно';
    game.ui.verdict.className = `verdict ${ok ? 'ok' : 'bad'}`;
    game.ui.next.classList.remove('hidden');
    game.ui.next.focus({ preventScroll: true });
    vibrate(ok ? 'ok' : 'bad');
  }
  function advance() {
    if (!game?.locked) return;
    game.index++;
    if (game.index >= game.questions.length) finishGame(); else nextQuestion();
  }

  // ---- result --------------------------------------------------------------------------------------------
  async function finishGame() {
    setScreen('result');
    const g = game;
    const correct = g.answers.filter((a) => a.a === 0).length;
    const total = g.questions.length;
    if (!g.round && g.score > prefs.best) { prefs.best = g.score; savePrefs(); }
    renderResult(g, correct, total, null, canTalk() ? 'Сохраняем результат…' : '');
    if (!canTalk()) return;
    const data = await api({ action: 'record', answers: g.answers, round: Boolean(g.round) });
    if (game !== g) return;
    if (data.ok && g.round) round.played = true;
    renderResult(g, correct, total, data.ok ? data : null, data.ok ? '' : (data.message || 'Результат не сохранён.'));
  }
  function renderResult(g, correct, total, saved, note) {
    const share = !g.round && saved && sdk?.initData && new URLSearchParams(sdk.initData).get('query_id');
    const perCat = R.CATEGORIES.map((c) => {
      const mine = g.questions.map((q, i) => ({ q, a: g.answers[i] })).filter((x) => x.q.c === c.id);
      return mine.length ? h('div', { class: 'stat-row' }, h('span', {}, `${c.emoji} ${c.title}`), h('strong', {}, `${mine.filter((x) => x.a.a === 0).length} / ${mine.length}`)) : null;
    });
    const mistakes = g.questions.map((q, i) => ({ q, a: g.answers[i] })).filter((x) => x.a.a !== 0);
    const grade = correct / total;
    const board = saved?.round?.board;
    mount(
      h('section', { class: 'card result-hero' },
        h('div', { class: 'emoji' }, grade >= 0.9 ? '🏆' : grade >= 0.6 ? '🎉' : grade >= 0.3 ? '🙂' : '📚'),
        h('div', { class: 'big' }, g.score), h('div', { class: 'lead' }, `очков · верно ${correct} из ${total}`),
        saved?.round ? h('p', {}, `${medal(saved.round.place)} Место в раунде: ${saved.round.place} из ${saved.round.players}`) : null,
        saved?.newBest ? h('p', {}, '⭐ Новая лучшая партия!') : null,
        saved && saved.ranked === false ? h('p', { class: 'hint' }, 'Слишком быстро: партия не попала в рейтинг.') : null,
        note ? h('p', { class: 'hint' }, note) : null),
      board ? h('section', { class: 'card' }, h('h2', {}, 'Таблица раунда'), boardList(board)) : null,
      h('section', { class: 'card' }, h('h2', {}, 'По категориям'), perCat),
      mistakes.length ? h('section', { class: 'card' }, h('h2', {}, 'Работа над ошибками'),
        h('ol', { class: 'review' }, mistakes.map(({ q }) => h('li', {}, q.q, h('small', {}, `Правильно: ${q.answerText}`))))) : null,
      share ? h('button', { type: 'button', class: 'button button-primary', onclick: () => shareResult(g) }, '📣 Поделиться результатом') : null,
      g.round ? h('button', { type: 'button', class: 'button button-primary', onclick: openRound }, 'К таблице раунда') : h('button', { type: 'button', class: 'button button-primary', onclick: startSolo }, 'Сыграть ещё →'),
      h('button', { type: 'button', class: 'button', onclick: goHome }, 'К настройкам'));
  }
  async function shareResult(g) {
    const data = await api({ action: 'share', answers: g.answers });
    if (!data.ok) { toast(data.message || 'Не удалось отправить результат', true); return; }
    toast(data.message || 'Отправлено');
    try { if (data.closesMiniApp) sdk?.close?.(); } catch { /* ignore */ }
  }
  function boardList(rows) {
    if (!rows.length) return h('p', { class: 'empty' }, 'Пока никто не сыграл — будьте первым!');
    return h('ol', { class: 'board' }, rows.map((r) => h('li', { class: r.me ? 'me' : '' },
      h('span', {}, medal(r.place)), h('span', { class: 'name' }, r.name, r.me ? ' (вы)' : ''),
      h('span', { class: 'pts' }, r.score, h('span', { class: 'sub' }, `${r.correct}/${r.total}`)))));
  }

  // ---- group round ---------------------------------------------------------------------------------------
  async function openRound() {
    stopTimer(); game = null;
    setScreen('round');
    mount(h('p', { class: 'loading' }, 'Загружаем раунд…'));
    const data = await api({ action: 'round' });
    if (!data.ok) {
      mount(h('h1', {}, 'Раунд недоступен'), h('p', { class: 'lead' }, data.message || 'Не удалось открыть раунд.'),
        h('button', { type: 'button', class: 'button button-primary', onclick: goHome }, 'Играть одному'));
      return;
    }
    round = data;
    const r = data.round;
    const diff = diffById.get(r.difficulty);
    const until = new Date(r.expiresAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    mount(
      h('h1', {}, r.closed ? 'Раунд завершён 🏁' : 'Квиз-раунд 🧠'),
      h('div', { class: 'meta' },
        h('span', {}, r.cats.map((id) => `${catById.get(id).emoji} ${catById.get(id).title}`).join(' · ')),
        h('span', {}, `${diff.emoji} ${diff.title}`), h('span', {}, `${r.count} ${plural(r.count, 'вопрос', 'вопроса', 'вопросов')}`),
        h('span', {}, r.closed ? 'Приём результатов закончен' : `⏳ До ${until}`)),
      h('section', { class: 'card' }, h('h2', {}, `Результаты · ${data.players} ${plural(data.players, 'игрок', 'игрока', 'игроков')}`), boardList(data.board)),
      data.played ? h('p', { class: 'hint' }, `Вы уже играли: ${data.myResult.score} очков, ${data.myPlace}-е место. У каждого одна попытка.`) : null,
      !data.played && !r.closed ? h('button', { type: 'button', class: 'button button-primary', onclick: startRound }, 'Начать раунд →') : null,
      h('button', { type: 'button', class: 'button', onclick: () => { round = null; goHome(); } }, 'Играть одному'));
  }

  // ---- rating --------------------------------------------------------------------------------------------
  async function showBoard() {
    setScreen('board');
    mount(h('p', { class: 'loading' }, 'Загружаем рейтинг…'));
    const data = await api({ action: 'leaderboard' });
    if (!data.ok) {
      mount(h('h1', {}, 'Рейтинг'), h('p', { class: 'lead' }, data.message || 'Рейтинг сейчас недоступен.'),
        prefs.best ? h('p', {}, `Ваш лучший результат на этом устройстве: ${prefs.best}`) : null,
        h('button', { type: 'button', class: 'button', onclick: goHome }, 'Назад'));
      return;
    }
    const input = h('input', { type: 'text', maxlength: '24', value: data.me.name, 'aria-label': 'Имя в рейтинге' });
    const me = data.me;
    const accuracy = me.answered ? Math.round((me.correct / me.answered) * 100) : 0;
    mount(
      h('h1', {}, 'Рейтинг 🏆'),
      h('p', { class: 'lead' }, 'Рейтинг — сумма десяти лучших партий.'),
      h('section', { class: 'card' }, data.board.top.length
        ? h('ol', { class: 'board' }, data.board.top.map((r) => h('li', { class: data.board.me && data.board.me.place === r.place ? 'me' : '' },
          h('span', {}, medal(r.place)), h('span', { class: 'name' }, r.name), h('span', { class: 'pts' }, r.value))))
        : h('p', { class: 'empty' }, 'Рейтинг пока пуст.')),
      h('section', { class: 'card' }, h('h2', {}, 'Моя статистика'),
        h('div', { class: 'stat-row' }, h('span', {}, 'Партий'), h('strong', {}, me.games)),
        h('div', { class: 'stat-row' }, h('span', {}, 'Верных ответов'), h('strong', {}, `${me.correct} из ${me.answered} (${accuracy} %)`)),
        h('div', { class: 'stat-row' }, h('span', {}, 'Лучшая партия'), h('strong', {}, me.best)),
        h('div', { class: 'stat-row' }, h('span', {}, 'Рейтинг'), h('strong', {}, me.place ? `${me.rating} · ${me.place}-е место из ${me.total}` : me.rating))),
      h('section', { class: 'card' }, h('h2', {}, 'Имя в рейтинге'),
        h('form', { class: 'name-form', onsubmit: async (event) => {
          event.preventDefault();
          const saved = await api({ action: 'rename', name: input.value });
          if (saved.ok) toast('Имя сохранено'); else toast(saved.message || 'Не удалось сохранить имя', true);
        } }, input, h('button', { type: 'submit', class: 'chip-button' }, 'Сохранить'))),
      h('button', { type: 'button', class: 'button', onclick: () => (round && !game ? openRound() : goHome()) }, 'Назад'));
  }

  // ---- start ---------------------------------------------------------------------------------------------
  function onKey(event) {
    if (screen !== 'game' || !game) return;
    const index = ['1', '2', '3', '4'].indexOf(event.key);
    if (index >= 0 && !game.locked) answer(index);
    else if ((event.key === 'Enter' || event.key === ' ') && game.locked) { event.preventDefault(); advance(); }
  }
  async function init() {
    loadPrefs();
    $('#brand').addEventListener('click', () => { if (screen !== 'game') goHome(); });
    $('#top-board').addEventListener('click', () => { if (screen !== 'game') showBoard(); });
    document.addEventListener('keydown', onKey);
    window.addEventListener('vvelcom-sdk-ready', integrateSdk);
    try {
      const response = await fetch('./data/questions.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bank = (await response.json()).questions;
      if (!Array.isArray(bank) || !bank.length || !bank.every((q) => q.id && catById.has(q.c) && q.d >= 1 && q.d <= 3 && Array.isArray(q.a) && q.a.length === 4)) throw new Error('Недопустимый формат questions.json');
      bankMap = new Map(bank.map((q) => [q.id, q]));
    } catch (error) {
      console.error('Unable to load quiz questions', error);
      mount(h('p', { class: 'loading' }, 'Не удалось загрузить вопросы. Проверьте data/questions.json и HTTPS-хостинг.'));
      return;
    }
    // Public config only: this file must NEVER contain a bot token.
    try {
      const conf = await fetch('./config.json', { cache: 'no-store' });
      if (conf.ok) {
        const obj = await conf.json();
        if (typeof obj.backendUrl === 'string' && /^https:\/\/[^\s]+$/.test(obj.backendUrl) && !obj.backendUrl.includes('PASTE_YOUR_FUNCTION_ID_HERE')) backendUrl = obj.backendUrl;
      }
    } catch { /* the game works without the rating service */ }
    integrateSdk();
    booted = true;
    if (startParam()) openRound(); else goHome();
  }
  init();
})();
