const { test } = require('node:test');
const assert = require('node:assert/strict');
const { condenseDiff } = require('../dist/test/condense.js');

function section(path, lines, marker = path) {
  const body = Array.from({ length: lines }, (_, index) => `+${marker} line ${index}`).join('\n');
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`;
}

const files = [['small.ts', 3], ['medium.ts', 200], ['huge.ts', 5000], ['yarn.lock', 3000], ['app.min.js', 2000], ['שלום.md', 400]];
const patch = files.map(([path, lines]) => section(path, lines)).join('');
const overview = files.map(([path, lines]) => `${lines}\t0\t${path}`).join('\n') + '\n';

test('never exceeds the budget, from tiny to large budgets', () => {
  for (const budget of [1024, 2048, 8192, 30000, 100000]) {
    for (const input of [patch, undefined]) {
      const text = condenseDiff(input, overview, budget);
      assert.ok(Buffer.byteLength(text) <= budget, `${Buffer.byteLength(text)} > ${budget}`);
    }
  }
});

test('keeps small files whole, shortens large ones and skips lock and minified files', () => {
  const text = condenseDiff(patch, overview, 30000);
  assert.match(text, /\+small\.ts line 2\n/);
  assert.match(text, /\+huge\.ts line 0\n/);
  assert.doesNotMatch(text, /\+huge\.ts line 4999/);
  assert.match(text, /\[\.\.\. \d+ more lines of this file omitted\]/);
  assert.doesNotMatch(text, /yarn\.lock line|app\.min\.js line/);
  assert.match(text, /2 files appear only in the overview/);
  for (const [path] of files) { assert.ok(text.includes(path), `${path} must be listed`); }
});

test('preserves the original file order in the excerpts', () => {
  const text = condenseDiff(patch, overview, 30000);
  const positions = ['small.ts', 'medium.ts', 'huge.ts', 'שלום.md'].map(path => text.indexOf(`diff --git a/${path}`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(positions.every(position => position > 0));
});

test('truncates an oversized overview with a count of what was left out', () => {
  const many = Array.from({ length: 5000 }, (_, index) => `1\t1\tsrc/file-${index}.ts`).join('\n');
  const text = condenseDiff(undefined, many, 8192);
  assert.ok(Buffer.byteLength(text) <= 8192);
  assert.match(text, /src\/file-0\.ts/);
  assert.match(text, /\[\.\.\. \d+ more overview lines omitted\]/);
});
