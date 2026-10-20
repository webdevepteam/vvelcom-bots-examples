'use strict';

// node --test tests/backend.test.cjs  (after: node scripts/build-questions.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'vv_test_token';
process.env.VVELCOM_BOT_TOKEN = TOKEN;
process.env.VVELCOM_WEBHOOK_SECRET = 'hook-secret';
process.env.GAME_URL = 'https://example.test/index.html';
process.env.ALLOWED_ORIGINS = 'https://example.test';
process.env.QUIZ_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-'));

const rules = require('../cloud-function/quiz-rules');
const bank = require('../cloud-function/questions.json').questions;
const { handler, verifyInitData, settingsView } = require('../cloud-function/index');

function signedInitData(userId, firstName, extra = {}) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: firstName }), ...extra,
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
const post = (body) => handler({ httpMethod: 'POST', headers: { origin: 'https://example.test' }, body: JSON.stringify(body) }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));
const bankMap = new Map(bank.map((q) => [q.id, q]));
// Answers for the given question ids: the first `right` of them correct, the rest wrong.
const answersFor = (ids, right) => ids.map((id, i) => ({ id, a: i < right ? 0 : 1, t: 5000 }));

// Records every Bot API call and answers like the platform would.
function mockBotApi() {
  const calls = [];
  global.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 'm1', chat_id: 'c1' } }) };
  };
  return calls;
}

test('question bank: valid, unique ids, four distinct answers, every level in every category', () => {
  assert.ok(bank.length >= 200);
  assert.equal(new Set(bank.map((q) => q.id)).size, bank.length);
  for (const q of bank) {
    assert.ok(rules.CATEGORIES.some((c) => c.id === q.c), q.id);
    assert.ok([1, 2, 3].includes(q.d), q.id);
    assert.equal(q.a.length, 4, q.id);
    assert.equal(new Set(q.a).size, 4, `duplicate answers in ${q.id}`);
    assert.ok(q.a.every((t) => typeof t === 'string' && t.trim()), q.id);
  }
  for (const c of rules.CATEGORIES) for (const d of [1, 2, 3]) {
    assert.ok(bank.filter((q) => q.c === c.id && q.d === d).length >= 12, `${c.id} level ${d}`);
  }
});

test('pickQuestions: deterministic, right count, respects categories and difficulty', () => {
  const all = rules.CATEGORIES.map((c) => c.id);
  const a = rules.pickQuestions(bank, { cats: all, difficulty: 0, count: 20, seed: 7 });
  const b = rules.pickQuestions(bank, { cats: all, difficulty: 0, count: 20, seed: 7 });
  assert.deepEqual(a.map((q) => q.id), b.map((q) => q.id));
  assert.equal(a.length, 20);
  assert.equal(new Set(a.map((q) => q.id)).size, 20);
  assert.notDeepEqual(a.map((q) => q.id), rules.pickQuestions(bank, { cats: all, difficulty: 0, count: 20, seed: 8 }).map((q) => q.id));
  const hard = rules.pickQuestions(bank, { cats: ['cars', 'it'], difficulty: 3, count: 15, seed: 1 });
  assert.equal(hard.length, 15);
  assert.ok(hard.every((q) => ['cars', 'it'].includes(q.c)));
  assert.ok(hard.every((q) => q.d === 3), 'enough hard questions: nothing from other levels');
  const mix = rules.pickQuestions(bank, { cats: all, difficulty: 0, count: 30, seed: 3 });
  assert.ok([1, 2, 3].every((d) => mix.some((q) => q.d === d)), 'mixed round has every level');
  // One category at 30 hard questions: it has fewer, so the nearest level tops it up.
  const one = rules.pickQuestions(bank, { cats: ['comics'], difficulty: 3, count: 30, seed: 5 });
  assert.equal(one.length, 30);
  assert.equal(rules.maskToCats(rules.catsToMask(['it', 'movies'])).join(), 'it,movies');
});

test('pointsFor: level weight, speed bonus, nothing for a wrong answer', () => {
  assert.equal(rules.pointsFor(1, false, 100), 0);
  assert.equal(rules.pointsFor(2, true, 20000), 20);
  assert.equal(rules.pointsFor(3, true, 0), 45);
  assert.ok(rules.pointsFor(1, true, 3000) > rules.pointsFor(1, true, 15000));
});

test('verifyInitData: valid signature, tampering, start_param is signed', () => {
  const ok = verifyInitData(signedInitData('u1', 'Анна', { start_param: 'r_0123456789' }), TOKEN);
  assert.equal(ok.userId, 'u1');
  assert.equal(ok.startParam, 'r_0123456789');
  const forged = signedInitData('u1', 'Анна', { start_param: 'r_0123456789' }).replace('r_0123456789', 'r_aaaaaaaaaa');
  assert.equal(verifyInitData(forged, TOKEN), null);
});

test('settings buttons carry the whole state and fit callback_data', () => {
  const view = settingsView(31, 0, 0);
  const data = view.markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.every((d) => Buffer.byteLength(d) <= 64));
  assert.ok(view.markup.inline_keyboard.length <= 20);
  assert.ok(data.includes('qz:go:31:0:0'));
  assert.ok(data.includes('qz:c:15:0:0'), 'toggling the last category clears bit 4');
});

test('group round: create in chat, play, the message with the table is edited', async () => {
  const calls = mockBotApi();
  const hook = (update) => handler({ httpMethod: 'POST', queryStringParameters: { mode: 'webhook' }, headers: { 'x-messenger-webhook-secret': 'hook-secret' }, body: JSON.stringify(update) });
  // /quiz in a group → settings message
  await hook({ message: { chat: { id: 'group1', type: 'group' }, from: { id: 'host', first_name: 'Хост' }, text: '/quiz@quiz_vvbot' } });
  assert.match(calls.at(-1).payload.text, /Новый квиз-раунд/);
  // press «Создать раунд» for hard comics + movies, 15 questions
  const mask = rules.catsToMask(['movies', 'comics']);
  await hook({ callback_query: { id: 'q1', from: { id: 'host', first_name: 'Хост' }, data: `qz:go:${mask}:3:0`, message: { id: 'msg1', chat: { id: 'group1' } } } });
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1).payload;
  assert.equal(edit.chat_id, 'group1');
  assert.match(edit.text, /Пока никто не сыграл/);
  const button = edit.reply_markup.inline_keyboard[0][0];
  assert.match(button.web_app.start_param, /^r_[0-9a-f]{10}$/);
  assert.equal(button.web_app.url, process.env.GAME_URL);

  const startParam = button.web_app.start_param;
  const anna = signedInitData('anna', 'Анна', { start_param: startParam });
  const info = await post({ action: 'round', initData: anna });
  assert.equal(info.ok, true);
  assert.equal(info.round.count, 15);
  assert.equal(info.played, false);
  assert.ok(info.round.ids.every((id) => ['movies', 'comics'].includes(bankMap.get(id).c)));
  const ids = info.round.ids;

  // wrong question set / forged round id are refused
  const wrong = await post({ action: 'record', initData: anna, round: true, answers: answersFor(ids.slice(1), 5) });
  assert.equal(wrong.status, 422);

  const first = await post({ action: 'record', initData: anna, round: true, answers: answersFor(ids, 10) });
  assert.equal(first.ok, true);
  assert.equal(first.round.place, 1);
  let table = calls.filter((c) => c.method === 'editMessageText').at(-1).payload;
  assert.equal(table.message_id, 'msg1');
  assert.match(table.text, /🥇 Анна — \d+ · 10\/15/);

  const again = await post({ action: 'record', initData: anna, round: true, answers: answersFor(ids, 15) });
  assert.equal(again.status, 409, 'one attempt per player');

  const boris = signedInitData('boris', 'Борис', { start_param: startParam });
  const second = await post({ action: 'record', initData: boris, round: true, answers: answersFor(ids, 15) });
  assert.equal(second.round.place, 1, 'a better result takes the first place');
  table = calls.filter((c) => c.method === 'editMessageText').at(-1).payload;
  assert.match(table.text, /🥇 Борис[\s\S]*🥈 Анна/);
  assert.ok(table.reply_markup.inline_keyboard.some((row) => row[0].share_to_feed));

  const view = await post({ action: 'round', initData: anna });
  assert.equal(view.played, true);
  assert.equal(view.myPlace, 2);
  assert.equal(view.board.length, 2);

  // the round link does not turn a solo game into a round result
  const solo = await post({ action: 'record', initData: anna, round: false, answers: answersFor(ids, 7) });
  assert.equal(solo.ok, true);
  assert.equal(solo.round, undefined);

  // «Мои раунды»: the creator and each player see the round, a stranger neither sees it nor can open it by id
  const mine = await post({ action: 'myRounds', initData: anna });
  assert.equal(mine.ok, true);
  const listed = mine.rounds.find((r) => r.id === startParam.slice(2));
  assert.ok(listed, 'a played round is listed');
  assert.equal(listed.played, true);
  assert.equal(listed.myPlace, 2);
  assert.equal(listed.players, 2);
  const byId = await post({ action: 'round', initData: signedInitData('anna', 'Анна'), roundId: startParam.slice(2) });
  assert.equal(byId.ok, true);
  assert.equal(byId.board.length, 2);
  const stranger = signedInitData('eve', 'Ева');
  assert.equal((await post({ action: 'myRounds', initData: stranger })).rounds.length, 0);
  assert.equal((await post({ action: 'round', initData: stranger, roundId: startParam.slice(2) })).status, 403);
});

test('expired round: closed, no more results, final table posted once', async () => {
  const calls = mockBotApi();
  const stats = require('../cloud-function/stats');
  const round = await stats.createRound({ cats: ['it'], difficulty: 1, count: 15, ids: rules.pickQuestions(bank, { cats: ['it'], difficulty: 1, count: 15, seed: 1 }).map((q) => q.id), chatId: 'g2', messageId: 'm2' });
  round.expiresAt = Date.now() - 1000;
  await stats.updateRound(round);
  const init = signedInitData('late', 'Опоздавший', { start_param: `r_${round.id}` });
  const info = await post({ action: 'round', initData: init });
  assert.equal(info.round.closed, true);
  const rec = await post({ action: 'record', initData: init, round: true, answers: answersFor(round.ids, 15) });
  assert.equal(rec.status, 410);
  const edits = calls.filter((c) => c.method === 'editMessageText');
  assert.equal(edits.length, 1);
  assert.match(edits[0].payload.text, /Квиз-раунд завершён/);
  assert.equal(edits[0].payload.reply_markup, undefined);
});

test('solo record: rating, stats, leaderboard, bad payloads', async () => {
  mockBotApi();
  const init = signedInitData('solo1', 'Соло');
  const ids = rules.pickQuestions(bank, { cats: ['cars'], difficulty: 2, count: 15, seed: 11 }).map((q) => q.id);
  assert.equal((await post({ action: 'record', initData: init, answers: answersFor(ids, 12) })).ok, true);
  assert.equal((await post({ action: 'record', initData: init, answers: [{ id: 'nope', a: 0, t: 1 }] })).status, 422);
  assert.equal((await post({ action: 'record', initData: init, answers: answersFor(ids.slice(0, 3), 3) })).status, 422, 'too few questions');
  assert.equal((await post({ action: 'record', initData: 'garbage', answers: answersFor(ids, 1) })).status, 401);
  const dup = [...answersFor(ids.slice(0, 5), 5), { id: ids[0], a: 0, t: 1000 }];
  assert.equal((await post({ action: 'record', initData: init, answers: dup })).status, 422, 'duplicate question');
  const board = await post({ action: 'leaderboard', initData: init });
  assert.equal(board.board.me.name, 'Соло');
  assert.equal(board.me.correct, 12);
  assert.equal((await post({ action: 'rename', initData: init, name: '  Мастер  ' })).name, 'Мастер');
  assert.equal((await post({ action: 'leaderboard', initData: init })).board.me.name, 'Мастер');
});

test('createRound from the web app goes out through answerWebAppQuery and is tracked', async () => {
  const calls = mockBotApi();
  const init = signedInitData('maker', 'Создатель', { query_id: 'AAA' });
  const res = await post({ action: 'createRound', initData: init, cats: ['it', 'cars'], difficulty: 2, count: 20 });
  assert.equal(res.ok, true);
  assert.equal(res.tracked, true);
  const sent = calls.find((c) => c.method === 'answerWebAppQuery').payload;
  assert.equal(sent.web_app_query_id, 'AAA');
  assert.match(sent.result.reply_markup.inline_keyboard[0][0].web_app.start_param, /^r_/);
  assert.equal((await post({ action: 'createRound', initData: init, cats: [], difficulty: 2, count: 20 })).status, 422);
  assert.equal((await post({ action: 'createRound', initData: signedInitData('maker', 'Создатель'), cats: ['it'], difficulty: 2, count: 20 })).status, 409);
});
