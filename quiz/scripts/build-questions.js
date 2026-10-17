'use strict';

// Builds questions.json from scripts/src/<category>.json and copies the shared files to both parts:
//   web-app/data/questions.json, cloud-function/questions.json
//   web-app/quiz-rules.js → cloud-function/quiz-rules.js
// Source rows: [difficulty 1|2|3, question, right answer, wrong, wrong, wrong].
// Ids are «<category>-<row number>»: only ever APPEND rows, so ids that players already have in their history stay valid.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const rules = require(path.join(root, 'web-app', 'quiz-rules.js'));

const questions = [];
for (const category of rules.CATEGORIES) {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', `${category.id}.json`), 'utf8'));
  rows.forEach((row, index) => {
    const [d, q, ...answers] = row;
    questions.push({ id: `${category.id}-${String(index + 1).padStart(3, '0')}`, c: category.id, d, q, a: answers });
  });
}
// One question per line: readable diffs when rows are appended.
const text = '{"questions":[\n' + questions.map((q) => JSON.stringify(q)).join(',\n') + '\n]}\n';
fs.mkdirSync(path.join(root, 'web-app', 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'web-app', 'data', 'questions.json'), text);
fs.writeFileSync(path.join(root, 'cloud-function', 'questions.json'), text);
fs.copyFileSync(path.join(root, 'web-app', 'quiz-rules.js'), path.join(root, 'cloud-function', 'quiz-rules.js'));
console.log(`questions: ${questions.length}`);
for (const category of rules.CATEGORIES) {
  const own = questions.filter((q) => q.c === category.id);
  console.log(category.id.padEnd(8), [1, 2, 3].map((d) => own.filter((q) => q.d === d).length).join(' / '));
}
