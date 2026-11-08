const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectDiff } = require('../dist/test/diff.js');

async function repository(t, initialCommit = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'commit-diff-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const file = join(cwd, 'example.txt');
  await writeFile(file, 'original\n');
  if (initialCommit) { git('add', '.'); git('commit', '-m', 'initial'); }
  return { cwd, git, file };
}

test('uses only staged content for a partially staged file', async t => {
  const { cwd, git, file } = await repository(t);
  await writeFile(file, 'staged\n');
  git('add', '.');
  await writeFile(file, 'unstaged secret\n');
  const diff = await collectDiff('git', cwd);
  assert.equal(diff.source, 'staged');
  assert.match(diff.text, /\+staged/);
  assert.doesNotMatch(diff.text, /unstaged secret/);
  assert.equal(diff.condensed, false);
  assert.equal(diff.files, 1);
});

test('falls back to tracked unstaged changes and excludes untracked contents', async t => {
  const { cwd, file } = await repository(t);
  await writeFile(file, 'changed\n');
  await writeFile(join(cwd, 'untracked.txt'), 'private untracked contents');
  const diff = await collectDiff('git', cwd);
  assert.equal(diff.source, 'unstaged');
  assert.match(diff.text, /\+changed/);
  assert.doesNotMatch(diff.text, /private untracked/);
});

test('handles the first commit in a repository without HEAD', async t => {
  const { cwd, git } = await repository(t, false);
  git('add', '.');
  const diff = await collectDiff('git', cwd);
  assert.equal(diff.source, 'staged');
  assert.match(diff.text, /new file mode/);
});

test('rejects an empty diff with guidance about staging new files', async t => {
  const { cwd } = await repository(t);
  await assert.rejects(collectDiff('git', cwd), /no.*changes.*stage|stage.*new/i);
});

async function stageManyFiles(cwd, git, count) {
  for (let index = 0; index < count; index++) {
    const lines = Array.from({ length: 200 }, (_, line) => `file ${index} line ${line} ${'x'.repeat(30)}`);
    await writeFile(join(cwd, `source-${index}.txt`), lines.join('\n') + '\n');
  }
  await writeFile(join(cwd, 'package-lock.json'), `{"lockfileMarker": "${'y'.repeat(50000)}"}\n`);
  git('add', '.');
}

test('condenses a diff over the budget instead of rejecting it, listing every file', async t => {
  const { cwd, git } = await repository(t);
  await stageManyFiles(cwd, git, 40);
  const budget = 65536;
  const diff = await collectDiff('git', cwd, undefined, budget);
  assert.equal(diff.source, 'staged');
  assert.equal(diff.condensed, true);
  assert.ok(diff.bytes > budget * 4, `expected a large diff, got ${diff.bytes}`);
  assert.equal(diff.files, 41);
  assert.ok(Buffer.byteLength(diff.text) <= budget, `condensed text is ${Buffer.byteLength(diff.text)} bytes`);
  for (let index = 0; index < 40; index++) { assert.ok(diff.text.includes(`source-${index}.txt`), `source-${index}.txt missing`); }
  assert.ok(diff.text.includes('package-lock.json'));
  assert.doesNotMatch(diff.text, /lockfileMarker/, 'Lock file contents must not use the budget.');
  assert.match(diff.text, /\+file 7 line 0 /, 'Every file should keep an excerpt when there is room.');
  assert.match(diff.text, /more lines of this file omitted/);
  assert.match(diff.fingerprint, /^[a-f0-9]{64}$/);
});

test('falls back to the file overview when the patch exceeds the read limit', async t => {
  const { cwd, git } = await repository(t);
  await stageManyFiles(cwd, git, 5);
  const diff = await collectDiff('git', cwd, undefined, 65536, 8192);
  assert.equal(diff.source, 'staged');
  assert.equal(diff.condensed, true);
  assert.equal(diff.bytes, undefined);
  assert.equal(diff.files, 6);
  for (let index = 0; index < 5; index++) { assert.ok(diff.text.includes(`source-${index}.txt`)); }
  assert.match(diff.text, /too large to read/);
});

test('fingerprints the full diff so changes beyond the condensed text are detected', async t => {
  const { cwd, git } = await repository(t);
  await stageManyFiles(cwd, git, 10);
  const before = await collectDiff('git', cwd, undefined, 16384);
  await writeFile(join(cwd, 'source-3.txt'), (await readFile(join(cwd, 'source-3.txt'), 'utf8')).replace('line 199', 'line 199 edited'));
  git('add', '.');
  const after = await collectDiff('git', cwd, undefined, 16384);
  assert.notEqual(after.fingerprint, before.fingerprint);
  git('commit', '--allow-empty', '--only', '-m', 'move HEAD without touching the index');
  const moved = await collectDiff('git', cwd, undefined, 16384);
  assert.equal(moved.text, after.text);
  assert.notEqual(moved.fingerprint, after.fingerprint, 'A new HEAD must change the fingerprint.');
});

test('describes binary changes without sending binary contents', async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  git('add', '.');
  const diff = await collectDiff('git', cwd);
  assert.match(diff.text, /Binary files/);
  assert.ok(!diff.text.includes('\0'));
});

test('rejects unresolved merge conflicts', async t => {
  const { cwd, git, file } = await repository(t);
  git('checkout', '-b', 'other');
  await writeFile(file, 'other\n'); git('commit', '-am', 'other');
  git('checkout', 'main');
  await writeFile(file, 'main\n'); git('commit', '-am', 'main');
  assert.throws(() => git('merge', 'other'));
  await assert.rejects(collectDiff('git', cwd), /conflict/i);
});

test('does not execute repository-configured external diff commands', async t => {
  const { cwd, git, file } = await repository(t);
  git('config', 'diff.external', '/nonexistent/never-run-this');
  await writeFile(file, 'changed\n');
  assert.match((await collectDiff('git', cwd)).text, /\+changed/);
});

test('keeps three context lines despite Git environment and inter-hunk settings', async t => {
  const { cwd, git, file } = await repository(t);
  const lines = Array.from({ length: 80 }, (_, index) => `line ${index}`);
  await writeFile(file, lines.join('\n') + '\n');
  git('commit', '-am', 'long example');
  lines[10] = 'first change';
  lines[60] = 'second change';
  await writeFile(file, lines.join('\n') + '\n');
  const baseline = await collectDiff('git', cwd);
  git('config', 'diff.interHunkContext', '100');
  const previous = process.env.GIT_DIFF_OPTS;
  process.env.GIT_DIFF_OPTS = '--unified=100';
  try {
    assert.equal((await collectDiff('git', cwd)).text, baseline.text);
  } finally {
    if (previous === undefined) { delete process.env.GIT_DIFF_OPTS; }
    else { process.env.GIT_DIFF_OPTS = previous; }
  }
});
