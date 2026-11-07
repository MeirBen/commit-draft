const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectDiff } = require('../out/diff.js');

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
  assert.match(diff.head, /^[a-f0-9]{40,64}$/);
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
  assert.equal(diff.head, '');
  assert.match(diff.text, /new file mode/);
});

test('rejects an empty diff with guidance about staging new files', async t => {
  const { cwd } = await repository(t);
  await assert.rejects(collectDiff('git', cwd), /no.*changes.*stage|stage.*new/i);
});

test('rejects a diff over the byte limit without truncation', async t => {
  const { cwd, file } = await repository(t);
  await writeFile(file, 'x'.repeat(4096));
  await assert.rejects(collectDiff('git', cwd, undefined, 1024), /too large|limit/i);
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
