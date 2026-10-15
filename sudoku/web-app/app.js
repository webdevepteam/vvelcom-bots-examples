/* Sudoku • VVelcom mini-app • No external libraries or credentials. */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const LEVELS = {
    mini: { title: 'Малыш', label: 'Новичок', sub: 'Первые победы', emoji: '🌱', size: 4, prompt: 'Маленькое поле, большое открытие!' },
    junior: { title: 'Искатель', label: 'Легко', sub: 'Учимся замечать', emoji: '🌈', size: 6, prompt: 'Чуть сложнее, ещё интереснее!' },
    classic: { title: 'Знаток', label: 'Средне', sub: 'Ищем закономерности', emoji: '🧠', size: 9, prompt: 'Время включить логику!' },
    challenge: { title: 'Смельчак', label: 'Сложно', sub: 'Приключение для ума', emoji: '🔥', size: 9, prompt: 'Не сдавайся — ответ найдётся!' },
    master: { title: 'Легенда', label: 'Эксперт', sub: 'Для чемпионов', emoji: '🏆', size: 9, prompt: 'Настоящий вызов для мастера!' },
  };
  const PACKS = {
    digits: { name: 'Цифры', subtitle: 'Классика', symbols: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
    fruits: { name: 'Фрукты', subtitle: 'Сочные и яркие', symbols: ['🍎', '🍐', '🍇', '🍓', '🍒', '🍋', '🍉', '🍍', '🍊'] },
    animals: { name: 'Зверята', subtitle: 'Лапки и хвосты', symbols: ['🐱', '🐼', '🦊', '🐸', '🐻', '🐰', '🐨', '🐯', '🐵'] },
    vehicles: { name: 'Машинки', subtitle: 'Поехали!', symbols: ['🚗', '🚕', '🚙', '🚌', '🚒', '🚜', '🚀', '✈️', '🚁'] },
    shapes: { name: 'Фигуры', subtitle: 'Формы и цвета', symbols: ['●', '▲', '■', '◆', '★', '♥', '⬟', '⬢', '✿'] },
    nature: { name: 'Природа', subtitle: 'Цветочки и листья', symbols: ['🌿', '🌻', '🍀', '🌸', '🍁', '🌵', '🌷', '🌼', '🌺'] },
  };
  const SHAPE_COLORS = ['#e65b91', '#ffab37', '#6f59e7', '#3fc4a4', '#e77b5b', '#db5bab', '#4899eb', '#937ae7', '#e2b83a'];
  const STORAGE = 'vvelcom.sudoku.v1';
  let sdk = null;
  let backendUrl = '';
  let sharingInProgress = false;
  let catalog = [];
  let preferences = { size: 4, level: 'mini', skin: 'fruits', theme: 'light' };
  let stats = { wins: 0, bestTime: null, completed: [], bestPerLevel: {} };
  let game = null;
  let page = 'home';
  let toastTimer = null;
  let dialogState = null;
  let dialogPausedGame = false;
  // Long-press dragging uses Pointer Events, so it works on Android, iOS and desktop.
  let dragCandidate = null;
  let dragGhost = null;
  let dragTarget = null;
  let dragScrollFrame = null;
  let suppressKeyClick = null;
  let lastCellTap = { index: -1, at: 0 };
  const DOUBLE_TAP_MS = 500;
  const DRAG_DELAY_MS = 290;
  const DRAG_CANCEL_DISTANCE = 11;

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* Private mode / disabled storage: game still works in memory. */ }
  }
  function storageKey() {
    // Client-side separation only. initDataUnsafe is NOT trusted identity proof.
    const id = sdk?.initDataUnsafe?.user?.id;
    return `${STORAGE}:${typeof id === 'string' && /^[\w-]{1,100}$/.test(id) ? id : 'browser'}`;
  }
  function loadProfile() {
    const profile = readJSON(storageKey(), null);
    if (!profile || profile.version !== 1) return;
    if (profile.preferences && PACKS[profile.preferences.skin]) preferences.skin = profile.preferences.skin;
    if (profile.preferences && ['light', 'dark'].includes(profile.preferences.theme)) preferences.theme = profile.preferences.theme;
    if (profile.preferences && [4, 6, 9].includes(profile.preferences.size)) preferences.size = profile.preferences.size;
    if (profile.preferences && LEVELS[profile.preferences.level] && LEVELS[profile.preferences.level].size === preferences.size) preferences.level = profile.preferences.level;
    else preferences.level = defaultLevel(preferences.size);
    if (profile.stats && typeof profile.stats === 'object') {
      stats.wins = Number.isSafeInteger(profile.stats.wins) && profile.stats.wins >= 0 ? profile.stats.wins : 0;
      stats.bestTime = Number.isSafeInteger(profile.stats.bestTime) && profile.stats.bestTime >= 0 ? profile.stats.bestTime : null;
      stats.completed = Array.isArray(profile.stats.completed) ? profile.stats.completed.filter((id) => typeof id === 'string') : [];
      stats.bestPerLevel = profile.stats.bestPerLevel && typeof profile.stats.bestPerLevel === 'object' ? profile.stats.bestPerLevel : {};
    }
    const saved = profile.game;
    if (validateSave(saved)) game = { ...saved, history: [], paused: true, selected: saved.selected ?? firstEditable(saved) };
  }
  function saveProfile() { writeJSON(storageKey(), { version: 1, preferences, stats, game }); }
  function firstEditable(g) { return g ? g.puzzle.givens.findIndex((v, i) => v === 0 && !g.revealedHints.includes(i)) : -1; }
  function validateSave(g) {
    if (!g || !g.puzzle || !Array.isArray(g.board) || !Array.isArray(g.notes) || !Array.isArray(g.revealedHints)) return false;
    const reference = catalog.find((p) => p.id === g.puzzle.id);
    if (!reference || g.board.length !== reference.size * reference.size || g.notes.length !== g.board.length) return false;
    if (g.board.some((v, i) => !Number.isInteger(v) || v < 0 || v > reference.size || (!!reference.givens[i] && reference.givens[i] !== v))) return false;
    if (g.revealedHints.some((i) => !Number.isInteger(i) || i < 0 || i >= g.board.length || g.board[i] !== reference.solution[i])) return false;
    if (g.notes.some((values) => !Array.isArray(values) || values.some((v) => !Number.isInteger(v) || v < 1 || v > reference.size))) return false;
    if (!Number.isInteger(g.elapsed) || g.elapsed < 0 || !Number.isInteger(g.mistakes) || g.mistakes < 0 || !Number.isInteger(g.hints) || g.hints < 0 || g.hints > 3 || !PACKS[g.skin]) return false;
    g.puzzle = reference;
    return true;
  }
  const defaultLevel = (size) => size === 4 ? 'mini' : size === 6 ? 'junior' : 'classic';
  const formatTime = (seconds) => { const s = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const symbol = (value, skin = preferences.skin) => PACKS[skin]?.symbols[value - 1] || String(value);
  const isEmoji = (skin) => skin !== 'digits' && skin !== 'shapes';

  function tokenNode(value, skin) {
    const span = document.createElement('span');
    span.textContent = symbol(value, skin);
    if (skin === 'shapes') { span.className = 'shape-token'; span.style.color = SHAPE_COLORS[value - 1]; }
    if (isEmoji(skin)) span.className = 'token-emoji';
    return span;
  }
  function vib(kind) {
    try {
      if (kind === 'success' || kind === 'error') sdk?.HapticFeedback?.notificationOccurred?.(kind === 'success' ? 'success' : 'error');
      else sdk?.HapticFeedback?.selectionChanged?.();
    } catch { /* Haptics optional */ }
  }
  function integrateWebApp() {
    try {
      const current = window.VVelcom?.WebApp || window.Telegram?.WebApp;
      if (!current || sdk === current) return;
      sdk = current;
      // Some host WebViews draw their close/toolbar above the HTML viewport.
      // Use host-aware fallback spacing when the OS reports no safe-area insets.
      const embedded = Boolean(sdk.initData || window.TelegramWebviewProxy || window.TelegramWebviewProxyProto || window.ReactNativeWebView || (sdk.platform && !['unknown', 'web'].includes(String(sdk.platform).toLowerCase())) || new URLSearchParams(window.location?.search || '').get('embedded') === '1');
      document.body.classList.toggle('is-embedded', embedded);
      sdk.ready?.();
      sdk.expand?.();
      if (typeof sdk.setHeaderColor === 'function') sdk.setHeaderColor(preferences.theme === 'dark' ? '#171525' : '#f8f7fe');
      sdk.BackButton?.onClick?.(() => {
        if (dialogState) closeDialog();
        else if (page === 'game') showHome();
      });
      updateHostBack();
      // If the platform SDK was slow, load user-specific local progress after it connects.
      if (!game && !stats.wins && sdk?.initDataUnsafe?.user?.id) {
        loadProfile(); renderHome();
      }
    } catch (error) { console.warn('VVelcom SDK unavailable:', error); }
  }
  function updateHostBack() {
    try { if (dialogState || page === 'game') sdk?.BackButton?.show?.(); else sdk?.BackButton?.hide?.(); }
    catch { /* browser mode */ }
  }
  function applyTheme() {
    document.body.classList.toggle('theme-dark', preferences.theme === 'dark');
    document.querySelector('meta[name="theme-color"]').setAttribute('content', preferences.theme === 'dark' ? '#171525' : '#f8f7fe');
    $('#theme-btn').textContent = preferences.theme === 'dark' ? '☀' : '☾';
    try { sdk?.setHeaderColor?.(preferences.theme === 'dark' ? '#171525' : '#f8f7fe'); } catch { /* optional */ }
  }

  function renderHome() {
    $$('.size-card').forEach((b) => { const selected = Number(b.dataset.size) === preferences.size; b.classList.toggle('is-selected', selected); b.setAttribute('aria-pressed', String(selected)); });
    const difficulty = $('#difficulty-options'); difficulty.replaceChildren();
    for (const [id, lvl] of Object.entries(LEVELS)) {
      if (lvl.size !== preferences.size) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'difficulty-card' + (id === preferences.level ? ' is-selected' : ''); b.setAttribute('aria-pressed', String(id === preferences.level));
      b.innerHTML = `<span class="difficulty-emoji">${lvl.emoji}</span><span><strong>${lvl.label}</strong><small>${lvl.sub}</small></span><span class="radio-indicator" aria-hidden="true"></span>`;
      b.addEventListener('click', () => { preferences.level = id; vib(); renderHome(); saveProfile(); }); difficulty.append(b);
    }
    const themeOptions = $('#theme-options'); themeOptions.replaceChildren();
    for (const [id, pack] of Object.entries(PACKS)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'theme-card' + (id === preferences.skin ? ' is-selected' : ''); b.setAttribute('aria-pressed', String(id === preferences.skin));
      const tokens = document.createElement('span'); tokens.className = 'theme-emoji-preview';
      for (let v = 1; v <= 3; v++) tokens.append(tokenNode(v, id));
      const title = document.createElement('strong'); title.textContent = pack.name;
      const sub = document.createElement('small'); sub.textContent = pack.subtitle;
      b.append(tokens, title, sub);
      b.addEventListener('click', () => { preferences.skin = id; vib(); renderHome(); saveProfile(); }); themeOptions.append(b);
    }
    $('#wins-stat').textContent = String(stats.wins);
    $('#best-stat').textContent = stats.bestTime === null ? '—' : formatTime(stats.bestTime);
    const resume = game && !game.finished;
    $('#continue-card').classList.toggle('hidden', !resume);
    if (resume) $('#continue-description').textContent = `${LEVELS[game.puzzle.level].label} · ${game.puzzle.size} × ${game.puzzle.size} · ${formatTime(game.elapsed)}`;
  }

  function selectSize(size) { preferences.size = size; preferences.level = defaultLevel(size); vib(); renderHome(); saveProfile(); }
  function pickPuzzle(level, exclude) {
    const pool = catalog.filter((p) => p.level === level);
    if (!pool.length) return null;
    const remaining = pool.filter((p) => !stats.completed.includes(p.id) && p.id !== exclude);
    const options = remaining.length ? remaining : pool.filter((p) => p.id !== exclude);
    const choices = options.length ? options : pool;
    return choices[Math.floor(Math.random() * choices.length)];
  }
  function createGame(puzzle) {
    return { puzzle, skin: preferences.skin, board: puzzle.givens.slice(), notes: Array.from({ length: puzzle.size * puzzle.size }, () => []), revealedHints: [], hints: 3, mistakes: 0, elapsed: 0, selected: puzzle.givens.findIndex((n) => n === 0), notesMode: false, paused: false, finished: false, history: [] };
  }
  function startNewGame(level = preferences.level) {
    resetCellTap();
    const p = pickPuzzle(level, game?.puzzle.id);
    if (!p) return showToast('Не удалось загрузить головоломки. Проверьте интернет.', true);
    game = createGame(p); closeDialog(); showGame(); vib(); saveProfile();
  }
  function showHome() {
    resetCellTap();
    stopKeyDrag();
    if (game && !game.finished) game.paused = true;
    page = 'home'; $('#home-screen').classList.remove('hidden'); $('#game-screen').classList.add('hidden'); closeDialog(); renderHome(); updateHostBack(); saveProfile(); window.scrollTo(0, 0);
  }
  function showGame() {
    stopKeyDrag();
    if (!game) return;
    game.paused = false; page = 'game'; $('#home-screen').classList.add('hidden'); $('#game-screen').classList.remove('hidden'); updateHostBack(); renderGame(); saveProfile(); window.scrollTo(0, 0);
  }

  function getBox(index) {
    const p = game.puzzle; const row = Math.floor(index / p.size); const col = index % p.size;
    return Math.floor(row / p.boxRows) * (p.size / p.boxCols) + Math.floor(col / p.boxCols);
  }
  function isPeer(a, b) {
    if (a === b) return false;
    const n = game.puzzle.size;
    return Math.floor(a / n) === Math.floor(b / n) || a % n === b % n || getBox(a) === getBox(b);
  }
  function isEditable(i) { return i >= 0 && !game.puzzle.givens[i] && !game.revealedHints.includes(i); }
  // «Сложно» and «Эксперт» play without help: no hints, no red cells, no same-symbol highlight,
  // no «symbol is used up» dimming. Mistakes are still counted for the result.
  const isHardGame = () => Boolean(game) && ['challenge', 'master'].includes(game.puzzle.level);
  function renderGame() {
    if (!game) return;
    const p = game.puzzle; const lvl = LEVELS[p.level];
    $('#game-level-caption').textContent = `УРОВЕНЬ · ${lvl.label.toUpperCase()} · ${p.size} × ${p.size}`;
    $('#game-title').innerHTML = 'Собери судоку <span>✦</span>';
    $('#game-subtitle').textContent = lvl.prompt;
    $('#game-number').textContent = `Головоломка #${p.id.split('-')[1]}`;
    $('.character-sticker').textContent = lvl.emoji;
    $('#pause-btn').innerHTML = game.paused ? '▶ <span>Продолжить</span>' : 'Ⅱ <span>Пауза</span>';
    $('#pause-overlay').classList.toggle('hidden', !game.paused);
    $('#timer-text').textContent = formatTime(game.elapsed);
    $('#mistakes-text').textContent = String(game.mistakes);
    $('#hints-text').textContent = String(game.hints);
    $('#hints-tool-count').textContent = `Осталось ${game.hints}`;
    $('#hint-btn').disabled = !game.hints || game.paused || game.finished;
    $('#hint-btn').classList.toggle('hidden', isHardGame());
    $('#hints-text').closest('div')?.classList.toggle('hidden', isHardGame());
    $('#mistakes-text').closest('div')?.classList.toggle('hidden', isHardGame());
    $('#notes-btn').classList.toggle('active', !!game.notesMode);
    $('#notes-btn').setAttribute('aria-pressed', String(!!game.notesMode));
    $('#notes-status').textContent = game.notesMode ? 'Включены' : 'Выкл.';
    $('#notes-guide').classList.toggle('hidden', !game.notesMode);
    $('#undo-btn').disabled = !game.history.length || game.paused || game.finished;
    $('#erase-btn').disabled = game.paused || game.finished || !isEditable(game.selected);
    $('#notes-btn').disabled = game.paused || game.finished;
    $('#pause-btn').disabled = game.finished;
    $('#share-game-btn').classList.toggle('hidden', !game.finished);
    // In the no-help levels progress counts filled cells, so it can't reveal a wrong one.
    const correctCount = game.board.filter((v, i) => (isHardGame() ? v !== 0 : v === p.solution[i])).length;
    $('#board-progress-text').textContent = `${correctCount} из ${p.size * p.size} клеток`;
    $('#board-progress-fill').style.width = `${correctCount * 100 / p.solution.length}%`;
    renderBoard(); renderKeypad();
  }
  function renderBoard() {
    const p = game.puzzle; const n = p.size; const board = $('#sudoku-board');
    board.className = `sudoku-board size-${n}`;
    board.style.setProperty('--board-size', n);
    board.setAttribute('aria-rowcount', String(n));board.setAttribute('aria-colcount', String(n));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n * n; i++) {
      const v = game.board[i], row = Math.floor(i / n), col = i % n;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cell'; b.dataset.index = String(i); b.setAttribute('role', 'gridcell');
      const fixed = !!p.givens[i], revealed = game.revealedHints.includes(i);
      if (fixed) b.classList.add('is-locked');
      if (revealed) b.classList.add('is-hint');
      if (i === game.selected) b.classList.add('is-selected');
      else if (game.selected >= 0 && isPeer(game.selected, i)) b.classList.add('is-peer');
      if (!isHardGame() && v && game.selected >= 0 && game.board[game.selected] === v && i !== game.selected) b.classList.add('is-match');
      if (!isHardGame() && v && v !== p.solution[i]) b.classList.add('is-wrong');
      if ((col + 1) % p.boxCols === 0 && col !== n - 1) b.classList.add('cell-box-end');
      if ((row + 1) % p.boxRows === 0 && row !== n - 1) b.classList.add('cell-row-end');
      if (col === n - 1) b.classList.add('cell-last-col');
      if (row === n - 1) b.classList.add('cell-last-row');
      b.setAttribute('aria-label', `Строка ${row + 1}, столбец ${col + 1}: ${v ? symbol(v, game.skin) : 'пусто'}${fixed ? ', задано' : ''}${!isHardGame() && v && v !== p.solution[i] ? ', ошибка' : ''}`);
      b.setAttribute('aria-selected', String(i === game.selected));
      if (v) b.append(tokenNode(v, game.skin));
      else if (game.notes[i].length) {
        const note = document.createElement('span'); note.className = 'notes-grid';
        for (let number = 1; number <= n; number++) {
          const s = document.createElement('span'); if (game.notes[i].includes(number)) s.append(tokenNode(number, game.skin)); note.append(s);
        }
        b.append(note);
      }
      b.addEventListener('click', () => tapCell(i));
      b.addEventListener('dblclick', () => { if (game && !game.paused && !game.finished && isEditable(i) && game.board[i] !== 0) { game.selected = i; eraseCell(); } });
      frag.append(b);
    }
    board.replaceChildren(frag);
  }
  function renderKeypad() {
    const n = game.puzzle.size; const pad = $('#number-keypad');
    pad.style.setProperty('--pad-cols', n === 9 ? 9 : n === 6 ? 6 : 4);
    const frag = document.createDocumentFragment();
    for (let v = 1; v <= n; v++) {
      const b = document.createElement('button');b.type = 'button';b.className = 'key-button';b.title = `Поставить ${symbol(v, game.skin)} (клавиша ${v})`;
      b.setAttribute('aria-label', `Поставить ${symbol(v, game.skin)}`);
      b.append(tokenNode(v, game.skin)); b.disabled = game.paused || game.finished;
      if (!isHardGame() && game.board.filter((x, i) => x === v && x === game.puzzle.solution[i]).length === n) b.classList.add('is-complete');
      b.addEventListener('pointerdown', (event) => prepareKeyDrag(event, v, b));
      b.addEventListener('click', () => {
        if (suppressKeyClick && suppressKeyClick.value === v && Date.now() - suppressKeyClick.time < 900) return;
        placeValue(v);
      });
      frag.append(b);
    }
    pad.replaceChildren(frag);
  }
  function prepareKeyDrag(event, value, source) {
    if (!game || game.paused || game.finished || source.disabled ||
        (event.pointerType === 'mouse' && event.button !== 0)) return;
    stopKeyDrag();
    // A new press is a new tap; only the synthetic click of the *old* drag is ignored.
    suppressKeyClick = null;
    const candidate = {
      id: event.pointerId, value, source,
      x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY,
      started: false, timer: null,
    };
    dragCandidate = candidate;
    candidate.timer = window.setTimeout(() => beginKeyDrag(candidate), DRAG_DELAY_MS);
    window.addEventListener('pointermove', moveKeyDrag, { passive: false });
    window.addEventListener('pointerup', endKeyDrag);
    window.addEventListener('pointercancel', cancelKeyDrag);
    window.addEventListener('blur', cancelKeyDrag);
  }
  function beginKeyDrag(candidate) {
    if (dragCandidate !== candidate || !game || game.paused || game.finished) return;
    candidate.started = true;
    candidate.source.classList.add('is-drag-source');
    document.body.classList.add('is-dragging-symbol');
    dragGhost = document.createElement('div');
    dragGhost.className = 'symbol-drag-ghost';
    dragGhost.setAttribute('aria-hidden', 'true');
    dragGhost.append(tokenNode(candidate.value, game.skin));
    document.body.append(dragGhost);
    moveDragGhost(candidate.x, candidate.y);
    updateKeyDropTarget(candidate.x, candidate.y);
    dragScrollFrame = window.requestAnimationFrame(autoScrollWhileDragging);
    vib();
  }
  function autoScrollWhileDragging() {
    if (!dragCandidate?.started) return;
    const { x, y } = dragCandidate;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const topThreshold = Math.min(135, Math.floor(height * .2));
    const bottomThreshold = height - 86;
    let delta = 0;
    if (y < topThreshold) delta = -Math.min(15, Math.max(4, (topThreshold - y) * .16));
    else if (y > bottomThreshold) delta = Math.min(15, Math.max(4, (y - bottomThreshold) * .16));
    if (delta) {
      window.scrollBy(0, delta);
      updateKeyDropTarget(x, y);
    }
    dragScrollFrame = window.requestAnimationFrame(autoScrollWhileDragging);
  }
  function moveDragGhost(x, y) {
    if (!dragGhost) return;
    // Raised slightly above the finger, so the symbol stays visible.
    dragGhost.style.left = `${x}px`;
    dragGhost.style.top = `${y - 38}px`;
  }
  function updateKeyDropTarget(x, y) {
    const hit = document.elementFromPoint?.(x, y)?.closest?.('.cell');
    const next = hit?.closest?.('#sudoku-board') ? hit : null;
    if (next === dragTarget) return;
    if (dragTarget) dragTarget.classList.remove('is-drop-target', 'is-drop-denied');
    dragTarget = next;
    if (next) {
      const index = Number(next.dataset.index);
      next.classList.add(isEditable(index) ? 'is-drop-target' : 'is-drop-denied');
    }
  }
  function moveKeyDrag(event) {
    const candidate = dragCandidate;
    if (!candidate || event.pointerId !== candidate.id) return;
    candidate.x = event.clientX; candidate.y = event.clientY;
    if (!candidate.started) {
      if (Math.hypot(candidate.x - candidate.startX, candidate.y - candidate.startY) > DRAG_CANCEL_DISTANCE) {
        // Scrolling or quick movement before the long press: do not start a drag.
        stopKeyDrag();
      }
      return;
    }
    if (event.cancelable) event.preventDefault();
    moveDragGhost(candidate.x, candidate.y);
    updateKeyDropTarget(candidate.x, candidate.y);
  }
  function endKeyDrag(event) {
    const candidate = dragCandidate;
    if (!candidate || event.pointerId !== candidate.id) return;
    const started = candidate.started;
    const value = candidate.value;
    const index = dragTarget ? Number(dragTarget.dataset.index) : -1;
    if (started) suppressKeyClick = { value, time: Date.now() };
    stopKeyDrag();
    if (!started || index < 0 || !game || game.paused || game.finished) return;
    // Select and write atomically: drag should also work without an earlier tap.
    game.selected = index;
    if (!isEditable(index)) {
      vib('error'); showToast('Эта клетка уже задана — выберите другую', true);
      renderBoard(); saveProfile(); return;
    }
    placeValue(value);
  }
  function cancelKeyDrag() { stopKeyDrag(); }
  function stopKeyDrag() {
    if (dragScrollFrame !== null) window.cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = null;
    if (dragCandidate) {
      clearTimeout(dragCandidate.timer);
      dragCandidate.source?.classList.remove('is-drag-source');
    }
    if (dragTarget) dragTarget.classList.remove('is-drop-target', 'is-drop-denied');
    dragGhost?.remove();
    document.body.classList.remove('is-dragging-symbol');
    dragGhost = null; dragTarget = null; dragCandidate = null;
    window.removeEventListener('pointermove', moveKeyDrag);
    window.removeEventListener('pointerup', endKeyDrag);
    window.removeEventListener('pointercancel', cancelKeyDrag);
    window.removeEventListener('blur', cancelKeyDrag);
  }
  function tapCell(i) {
    if (!game || game.paused || game.finished) return;
    const now = Date.now();
    const secondTap = i === lastCellTap.index && now - lastCellTap.at <= DOUBLE_TAP_MS;
    lastCellTap = secondTap ? { index: -1, at: 0 } : { index: i, at: now };
    // Only user-entered digits (not fixed givens or hinted cells) can be erased.
    if (secondTap && isEditable(i) && game.board[i] !== 0) {
      game.selected = i;
      eraseCell();
      return;
    }
    selectCell(i);
  }
  function resetCellTap() { lastCellTap = { index: -1, at: 0 }; }
  function selectCell(i) {
    if (game.paused || game.finished) return;
    game.selected = i; vib(); renderBoard();
    $('#erase-btn').disabled = !isEditable(game.selected);
    saveProfile();
  }
  function snapshot() {
    game.history.push({ board: game.board.slice(), notes: game.notes.map((n) => n.slice()), hints: game.hints, revealedHints: game.revealedHints.slice(), selected: game.selected });
    if (game.history.length > 50) game.history.shift();
  }
  function placeValue(value) {
    resetCellTap();
    if (!game || game.paused || game.finished) return;
    const i = game.selected;
    if (!isEditable(i)) { showToast(i < 0 ? 'Сначала выберите пустую клетку' : 'Эту клетку менять нельзя'); return; }
    if (game.notesMode) {
      snapshot(); const list = game.notes[i];
      game.notes[i] = list.includes(value) ? list.filter((v) => v !== value) : [...list, value].sort((a, b) => a - b);
      vib(); renderGame(); saveProfile(); return;
    }
    if (game.board[i] === value && !game.notes[i].length) return;
    snapshot(); game.board[i] = value; game.notes[i] = [];
    if (value !== game.puzzle.solution[i]) {
      game.mistakes++;
      if (!isHardGame()) { vib('error'); showToast('Ой! Тут другой символ. Попробуйте ещё 💜', true); }
    } else {
      vib(); for (let k = 0; k < game.board.length; k++) if (isPeer(i, k)) game.notes[k] = game.notes[k].filter((v) => v !== value);
    }
    persistAndUpdate();
  }
  function eraseCell() {
    if (!game || game.paused || game.finished || !isEditable(game.selected)) return;
    const i = game.selected;
    if (!game.board[i] && !game.notes[i].length) return;
    snapshot(); game.board[i] = 0; game.notes[i] = []; vib(); persistAndUpdate();
  }
  function undo() {
    if (!game || game.paused || game.finished || !game.history.length) return;
    const prev = game.history.pop();
    game.board = prev.board; game.notes = prev.notes; game.hints = prev.hints; game.revealedHints = prev.revealedHints; game.selected = prev.selected;
    vib(); renderGame(); saveProfile();
  }
  function toggleNotes() {
    if (!game || game.paused || game.finished) return;
    game.notesMode = !game.notesMode; vib(); renderGame(); saveProfile();
    showToast(game.notesMode ? '✎ Заметки: отмечайте возможные варианты в пустой клетке' : '✎ Заметки выключены');
  }
  function giveHint() {
    resetCellTap();
    if (!game || game.paused || game.finished || game.hints <= 0 || isHardGame()) return;
    let i = game.selected;
    if (!isEditable(i) || game.board[i] === game.puzzle.solution[i]) i = game.board.findIndex((v, k) => isEditable(k) && v !== game.puzzle.solution[k]);
    if (i === -1) return showToast('Все клетки уже на своих местах!');
    snapshot(); game.selected = i; game.board[i] = game.puzzle.solution[i]; game.notes[i] = []; game.revealedHints.push(i); game.hints--;
    for (let k = 0; k < game.board.length; k++) if (isPeer(i, k)) game.notes[k] = game.notes[k].filter((v) => v !== game.board[i]);
    vib('success'); showToast('💡 Смотрите, теперь здесь всё верно!'); persistAndUpdate();
  }
  function persistAndUpdate() {
    if (!game.finished && game.board.every((v, i) => v === game.puzzle.solution[i])) return winGame();
    renderGame(); saveProfile();
  }
  function winGame() {
    game.finished = true; game.paused = false;
    stats.wins++;
    if (stats.bestTime === null || game.elapsed < stats.bestTime) stats.bestTime = game.elapsed;
    if (!stats.completed.includes(game.puzzle.id)) stats.completed.push(game.puzzle.id);
    if (!Number.isInteger(stats.bestPerLevel[game.puzzle.level]) || game.elapsed < stats.bestPerLevel[game.puzzle.level]) stats.bestPerLevel[game.puzzle.level] = game.elapsed;
    vib('success'); renderGame(); saveProfile(); createConfetti(); showWinDialog();
    void recordResult(game);
  }
  function createConfetti() {
    const layer = $('#confetti-layer');layer.replaceChildren();const colors = ['#6c4fe3', '#ffb63b', '#fe6d9a', '#48cfa9', '#78b8ff'];
    for (let i = 0; i < 38; i++) {
      const el = document.createElement('span');el.className = 'confetti';
      el.style.setProperty('--color', colors[i % colors.length]);el.style.setProperty('--left', `${Math.random() * 100}%`);
      el.style.setProperty('--delay', `${Math.random() * 0.8}s`);el.style.setProperty('--duration', `${2.7 + Math.random() * 1.7}s`);
      el.style.setProperty('--sway', `${Math.round(Math.random() * 180 - 90)}px`);el.style.setProperty('--rotate', `${Math.random() * 180}deg`);
      layer.append(el);
    }
    window.setTimeout(() => layer.replaceChildren(), 5500);
  }
  function showWinDialog() {
    const lvl = LEVELS[game.puzzle.level];
    openDialog({ kind: 'win', art: '🏆', title: 'Ура, получилось!', text: `Головоломка «${lvl.label}» решена! Вы отлично справились. Новые приключения ждут!`, metrics: true,
      actions: [{ label: '📣 Поделиться результатом', primary: true, fn: shareResult }, { label: 'Следующая головоломка →', fn: () => startNewGame(game.puzzle.level) }, { label: 'К выбору уровня', fn: showHome }] });
  }
  // Rating: the result goes to the Yandex function, which stores it under the player's VVelcom id.
  async function callApi(payload, timeout = 10000) {
    const initData = sdk?.initData || '';
    if (!backendUrl || !initData) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(backendUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, initData }), signal: controller.signal });
      const data = await response.json();
      return response.ok && data.ok ? data : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  async function recordResult(g) {
    const data = await callApi({ action: 'record', puzzleId: g.puzzle.id, board: g.board.slice(), elapsed: g.elapsed, mistakes: g.mistakes, hintsUsed: 3 - g.hints });
    if (!data || dialogState !== 'win') return;
    const place = data.place ? ` · ${data.place}-е место из ${data.total}` : '';
    $('#dialog-description').textContent = `Головоломка «${LEVELS[g.puzzle.level].label}» решена!\n🏅 Очки: ${data.score}${data.newBest ? ' — новый личный рекорд!' : ''}\nРейтинг: ${data.rating}${place}`;
  }
  const BOARD_LEVELS = ['all', 'mini', 'junior', 'classic', 'challenge', 'master'];
  const medal = (place) => ['🥇', '🥈', '🥉'][place - 1] || `${place}.`;
  async function showLeaderboard(level = 'all') {
    if (!sdk?.initData || !backendUrl) { showToast('Рейтинг доступен при запуске из VVelcom', true); return; }
    showToast('Загружаем рейтинг…');
    const data = await callApi({ action: 'leaderboard', level });
    if (!data) { showToast('Рейтинг сейчас недоступен', true); return; }
    const { board, me } = data;
    const lines = board.top.length ? board.top.map((r) => `${medal(r.place)} ${r.name}${r.me ? ' (вы)' : ''} — ${r.value}`) : ['Пока никто не играл. Станьте первым!'];
    if (board.me && board.me.place > board.top.length) lines.push('…', `${board.me.place}. Вы — ${board.me.value}`);
    if (level === 'all' && me?.games) {
      lines.push('', `Ваша статистика: партий ${me.games}, среднее время ${formatTime(me.avgTime)},`, `ошибок в среднем ${me.avgMistakes}, без ошибок и подсказок: ${me.flawless}`);
    }
    const next = BOARD_LEVELS[(BOARD_LEVELS.indexOf(level) + 1) % BOARD_LEVELS.length];
    const title = level === 'all' ? 'Общий рейтинг' : `Рейтинг · ${LEVELS[level].label}`;
    openDialog({ kind: 'rating', art: '🏅', title, text: lines.join('\n'), keepTimerRunning: true,
      actions: [{ label: next === 'all' ? 'Общий рейтинг' : `Уровень: ${LEVELS[next].label}`, primary: true, fn: () => { closeDialog(); void showLeaderboard(next); } },
        { label: `Имя в рейтинге: ${me?.name || 'изменить'}`, fn: () => { closeDialog(); askName(me?.name || ''); } }] });
    $('#dialog-description').classList.toggle('rating-list', true);
  }
  function askName(current) {
    openDialog({ kind: 'rename', art: '✏️', title: 'Как вас показывать?', text: 'Имя увидят другие игроки в рейтинге (до 24 символов).', keepTimerRunning: true, input: current,
      actions: [{ label: 'Сохранить', primary: true, fn: async () => {
        const name = $('#dialog-input').value.trim();
        if (!name) { showToast('Введите имя', true); return; }
        const data = await callApi({ action: 'rename', name });
        closeDialog();
        if (data) { showToast('Имя сохранено'); void showLeaderboard('all'); } else showToast('Не удалось сохранить имя', true);
      } }, { label: 'Отмена', fn: closeDialog }] });
  }
  function resultText() {
    return `🎉 Головоломка судоку в VVelcom решена! 🧩\nУровень: ${LEVELS[game.puzzle.level].label} (${game.puzzle.size}×${game.puzzle.size})\nВремя: ${formatTime(game.elapsed)} · Ошибки: ${game.mistakes}\nИграй тоже в «Судоку Лэнд»!`;
  }
  async function shareElsewhere() {
    if (!game?.finished) return;
    const text = resultText();
    if (navigator.share) {
      try { await navigator.share({ title: 'Судоку', text }); showToast('Спасибо, что делитесь радостью!'); }
      catch (error) { if (error?.name !== 'AbortError') showToast('Не удалось поделиться. Попробуйте ещё.', true); }
    } else if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); showToast('Результат скопирован!'); }
      catch { showToast('Не удалось скопировать текст', true); }
    } else showToast('Откройте игру в VVelcom или скопируйте текст вручную', true);
  }
  function sharingHelp(message) {
    openDialog({ kind: 'share-help', art: '📨', title: 'Как отправить результат?', text: message,
      actions: [{ label: 'Поделиться другим способом', primary: true, fn: shareElsewhere },
        { label: 'Вернуться к результату', fn: closeDialog }] });
  }
  async function shareResult() {
    if (!game?.finished || sharingInProgress) return;
    const initData = sdk?.initData || '';
    if (!backendUrl || !initData) {
      if (!sdk) return shareElsewhere();
      sharingHelp(!backendUrl ? 'Администратору нужно указать адрес Yandex Cloud Function в config.json. Пока Вы можете поделиться результатом обычным способом.'
        : 'Мини-приложение не получило подтверждённые данные входа от VVelcom. Откройте его из сообщения своего бота или поделитесь обычным способом.');
      return;
    }
    if (!new URLSearchParams(initData).get('query_id')) {
      sharingHelp('VVelcom не передал query_id для отправки сообщения. Откройте игру через кнопку «🎮 Открыть судоку» в сообщении бота. Из некоторых других способов запуска отправка может быть недоступна.');
      return;
    }
    sharingInProgress = true;
    const buttons = [...document.querySelectorAll('#dialog-buttons button'), $('#share-game-btn')];
    buttons.forEach((b) => { if (b) b.disabled = true; });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'share', initData,
          puzzleId: game.puzzle.id,
          board: game.board.slice(),
          elapsed: game.elapsed,
          mistakes: game.mistakes,
          hintsUsed: 3 - game.hints,
        }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || `HTTP ${response.status}`);
      vib('success'); closeDialog(); showToast('🏆 Результат отправлен в чат! Нажмите «В ленту» под сообщением.');
      // The API normally closes the Web App; close explicitly as an extra safeguard.
      try { sdk?.close?.(); } catch { /* Host close is optional. */ }
    } catch (error) {
      vib('error');
      sharingHelp(error.name === 'AbortError' ? 'Сервер не ответил вовремя. Попробуйте ещё раз или поделитесь результатом обычным способом.'
        : (error.message === 'Failed to fetch' ? 'Не удалось связаться с Yandex Cloud Function. Проверьте HTTPS, ALLOWED_ORIGINS и адрес в config.json.' : error.message));
    } finally {
      clearTimeout(timer);
      sharingInProgress = false;
      buttons.forEach((b) => { if (b) b.disabled = false; });
    }
  }
  function showToast(message, error = false) {
    const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.add('visible');
    clearTimeout(toastTimer);toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
  }
  function openDialog({ kind, art, title, text, actions, metrics = false, keepTimerRunning = false, input = null }) {
    dialogState = kind;
    dialogPausedGame = !keepTimerRunning && !!(game && page === 'game' && !game.paused && !game.finished);
    if (dialogPausedGame) { game.paused = true; renderGame(); }
    $('#dialog-illustration').textContent = art;
    $('#dialog-title').textContent = title;
    $('#dialog-description').textContent = text;
    const field = $('#dialog-input'); field.classList.toggle('hidden', input === null); if (input !== null) field.value = input;
    const metric = $('#win-metrics');metric.classList.toggle('hidden', !metrics);
    if (metrics && game) {
      metric.replaceChildren();
      for (const [label, number] of [['Время', formatTime(game.elapsed)], ['Ошибки', game.mistakes], ['Подсказки', 3 - game.hints]]) {
        const s = document.createElement('span');s.textContent = label;const strong = document.createElement('strong');strong.textContent = String(number);s.append(strong);metric.append(s);
      }
    }
    const buttonContainer = $('#dialog-buttons');buttonContainer.replaceChildren();
    actions.forEach(({ label, primary, fn }) => {
      const b = document.createElement('button');b.type = 'button';b.className = `button ${primary ? 'button-primary' : 'button-secondary'}`;b.textContent = label;
      b.addEventListener('click', fn);buttonContainer.append(b);
    });
    $('#modal-backdrop').classList.remove('hidden');updateHostBack();
    $('#dialog-close').focus();
  }
  function closeDialog() {
    if (!dialogState) return;
    dialogState = null;$('#modal-backdrop').classList.add('hidden');
    if (dialogPausedGame && game && !game.finished && page === 'game') { game.paused = false; renderGame(); }
    dialogPausedGame = false;updateHostBack();
  }
  function restartCurrentPuzzle() {
    if (!game || game.finished) return;
    // Only the puzzle state is restored; elapsed time is deliberately preserved.
    const elapsed = game.elapsed;
    const puzzle = game.puzzle;
    const skin = game.skin;
    const resumed = createGame(puzzle);
    resumed.skin = skin;
    resumed.elapsed = elapsed;
    game = resumed;
    resetCellTap();
    closeDialog();
    vib();
    renderGame();
    saveProfile();
    showToast('↻ Поле очищено. Таймер продолжает идти!');
  }
  function askRestartPuzzle() {
    if (!game || game.finished) return;
    openDialog({ kind: 'restart', art: '↻', title: 'Начать эту головоломку сначала?',
      text: 'Все Ваши цифры и заметки удалятся, подсказки восстановятся. Время не обнуляется и продолжает идти.',
      keepTimerRunning: true,
      actions: [
        { label: 'Начать сначала', primary: true, fn: restartCurrentPuzzle },
        { label: 'Продолжить решение', fn: closeDialog },
      ] });
  }
  function askNewGame() {
    if (!game || game.finished) return startNewGame(game?.puzzle.level || preferences.level);
    openDialog({ kind: 'new', art: '🎲', title: 'Другая головоломка?', text: 'Текущий прогресс будет заменён новой игрой. Начнём сначала?', actions: [{ label: 'Да, новую!', primary: true, fn: () => startNewGame(game.puzzle.level) }, { label: 'Остаться здесь', fn: closeDialog }] });
  }
  function showRules() {
    openDialog({ kind: 'rules', art: '🧩', title: 'Как играть?', text: 'Заполните строки, столбцы и блоки разными символами. Нажмите на клетку и выберите символ или удерживайте его и перетащите. Дважды быстро нажмите на свою цифру, чтобы стереть её. «Заметки» — маленькие варианты в пустой клетке: включите режим, отметьте возможные числа, затем выключите его перед окончательным ответом. «Начать сначала» очищает поле, но не сбрасывает время.', actions: [{ label: 'Всё понятно, играем!', primary: true, fn: closeDialog }] });
  }
  function togglePause() {
    stopKeyDrag();
    if (!game || game.finished || dialogState) return;
    game.paused = !game.paused;vib();renderGame();saveProfile();
  }
  function moveSelected(dx, dy) {
    if (!game || game.paused || game.finished) return;
    const n = game.puzzle.size;const idx = Math.max(0, game.selected);
    const row = Math.max(0, Math.min(n - 1, Math.floor(idx / n) + dy));
    const col = Math.max(0, Math.min(n - 1, idx % n + dx));
    game.selected = row * n + col;renderBoard();
    $(`.cell[data-index="${game.selected}"]`)?.focus({ preventScroll: true });
  }
  function handleKeydown(e) {
    if (e.key === 'Escape') { if (dialogState) closeDialog();else if (page === 'game') showHome();return; }
    if (dialogState || page !== 'game' || !game || game.finished || game.paused || e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= game.puzzle.size) { e.preventDefault();placeValue(Number(e.key)); }
    else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { e.preventDefault();eraseCell(); }
    else if (e.key === 'ArrowUp') { e.preventDefault();moveSelected(0, -1); }
    else if (e.key === 'ArrowDown') { e.preventDefault();moveSelected(0, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault();moveSelected(-1, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault();moveSelected(1, 0); }
    else if (e.key.toLowerCase() === 'n') { e.preventDefault();toggleNotes(); }
    else if (e.key.toLowerCase() === 'z') { e.preventDefault();undo(); }
  }
  function bindUI() {
    $('#brand-btn').addEventListener('click', showHome);
    $('#theme-btn').addEventListener('click', () => { preferences.theme = preferences.theme === 'dark' ? 'light' : 'dark';applyTheme();saveProfile(); });
    $('#help-btn').addEventListener('click', showRules);
    $('#rating-btn').addEventListener('click', () => void showLeaderboard('all'));
    $$('.size-card').forEach((b) => b.addEventListener('click', () => selectSize(Number(b.dataset.size))));
    $('#start-btn').addEventListener('click', () => startNewGame());
    $('#continue-btn').addEventListener('click', showGame);
    $('#back-home').addEventListener('click', showHome);
    $('#pause-btn').addEventListener('click', togglePause);
    $('#resume-btn').addEventListener('click', togglePause);
    $('#undo-btn').addEventListener('click', undo);
    $('#erase-btn').addEventListener('click', eraseCell);
    $('#notes-btn').addEventListener('click', toggleNotes);
    $('#hint-btn').addEventListener('click', giveHint);
    $('#new-game-btn').addEventListener('click', askNewGame);
    $('#restart-game-btn').addEventListener('click', askRestartPuzzle);
    $('#share-game-btn').addEventListener('click', shareResult);
    $('#number-keypad').addEventListener('contextmenu', (event) => event.preventDefault());
    $('#dialog-close').addEventListener('click', closeDialog);
    $('#modal-backdrop').addEventListener('click', (event) => { if (event.target === $('#modal-backdrop')) closeDialog(); });
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('visibilitychange', () => { if (document.hidden && game && !game.finished && page === 'game') { game.paused = true; renderGame(); saveProfile(); } });
    window.addEventListener('pagehide', saveProfile);
    window.addEventListener('vvelcom-sdk-ready', integrateWebApp);
    window.setInterval(() => {
      if (game && page === 'game' && !game.finished && !game.paused && (!dialogState || dialogState === 'restart') && !document.hidden) {
        game.elapsed++;$('#timer-text').textContent = formatTime(game.elapsed);if (game.elapsed % 3 === 0) saveProfile();
      }
    }, 1000);
  }
  async function initialize() {
    // Test/backup switch for hosts that do not expose initData or a bridge.
    if (new URLSearchParams(window.location?.search || '').get('embedded') === '1') {
      document.body.classList.add('is-embedded');
    }
    bindUI();
    $('#start-btn').disabled = true;
    $('#start-btn').textContent = 'Загрузка игры…';
    try {
      const response = await fetch('./data/puzzles.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.puzzles) || !data.puzzles.length) throw new Error('Нет игровых данных');
      catalog = data.puzzles;
      // Public config only: this file must NEVER contain a bot token.
      try {
        const conf = await fetch('./config.json', { cache: 'no-store' });
        if (conf.ok) {
          const obj = await conf.json();
          if (typeof obj.backendUrl === 'string' && /^https:\/\/[^\s]+$/.test(obj.backendUrl) && !obj.backendUrl.includes('PASTE_YOUR_FUNCTION_ID_HERE')) backendUrl = obj.backendUrl;
        }
      } catch { /* Gameplay remains usable if the sharing service is not configured. */ }
      if (!catalog.every((p) => LEVELS[p.level] && p.size === LEVELS[p.level].size && p.givens?.length === p.size * p.size && p.solution?.length === p.givens.length)) throw new Error('Недопустимый формат puzzles.json');
      integrateWebApp();
      loadProfile(); applyTheme();renderHome();
      $('#start-btn').disabled = false;
      $('#start-btn').innerHTML = 'Играть <span aria-hidden="true">→</span>';
    } catch (err) {
      console.error('Unable to load Sudoku puzzle data', err);
      $('#start-btn').textContent = 'Не удалось загрузить задания';
      $('#start-btn').disabled = true;
      showToast('Не найдены задания: проверьте data/puzzles.json и HTTPS-хостинг', true);
    }
  }
  initialize();
})();
