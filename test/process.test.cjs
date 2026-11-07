const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProcess } = require('../dist/test/process.js');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const options = { cwd: __dirname, timeoutMs: 2000, maxBytes: 1024 };
const run = (code, overrides = {}) => runProcess(process.execPath, ['-e', code], { ...options, ...overrides });

test('passes shell syntax and Unicode literally through stdin', async () => {
  const input = 'שלום $(touch should-not-exist) `echo nope` & "quoted"\n';
  assert.equal(await run('process.stdin.pipe(process.stdout)', { input }), input);
});

test('rejects a nonzero exit without exposing provider output', async () => {
  await assert.rejects(run('console.error("sensitive patch"); process.exit(3)'), error =>
    /exit.*3/i.test(error.message) && !error.message.includes('sensitive patch'));
});

test('bounds stdout instead of returning a silently truncated response', async () => {
  await assert.rejects(run('process.stdout.write("x".repeat(2048))'), /too large|limit/i);
});

test('does not hang when the process exits before consuming stdin', async () => {
  await assert.rejects(run('process.exit(4)', { input: 'x'.repeat(1024 * 1024) }), /exit.*4|input|pipe/i);
});

test('times out a stalled child', async () => {
  const start = Date.now();
  await assert.rejects(run('setInterval(() => {}, 1000)', { timeoutMs: 100 }), /timed out/i);
  assert.ok(Date.now() - start < 2000);
});

test('cancels a running child promptly', async () => {
  const controller = new AbortController();
  const pending = run('setInterval(() => {}, 1000)', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('does not launch an already cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run('process.exit(0)', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('gives actionable guidance for a missing executable', async () => {
  await assert.rejects(runProcess('/nonexistent/commit-cli', [], options), /not found|install|executable/i);
});

test('rejects command scripts that require a shell', async () => {
  await assert.rejects(runProcess('codex.cmd', [], options), /native|\.exe|\.cmd/i);
});

test('identifies the failing command without prescribing provider-only recovery', async () => {
  await assert.rejects(run('process.exit(7)', { label: 'Git' }), error => {
    assert.match(error.message, /Git.*exit code 7/);
    assert.doesNotMatch(error.message, /signed in/);
    return true;
  });
});

test('does not suggest a diff setting for the fixed provider output limit', async () => {
  await assert.rejects(run('process.stdout.write("x".repeat(2048))', { label: 'Claude' }), error => {
    assert.match(error.message, /Claude.*too large/);
    assert.doesNotMatch(error.message, /increase the diff limit/);
    return true;
  });
});

test('cancellation stops descendants even when they ignore SIGTERM', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'commit-cancel-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const marker = join(cwd, 'ticks');
  const descendant = `process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'), 30)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setInterval(() => {}, 1000)`;
  const controller = new AbortController();
  const pending = run(parent, { signal: controller.signal, timeoutMs: 5000 });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  const deadline = Date.now() + 2000;
  while (!(await readFile(marker, 'utf8').catch(() => ''))) {
    if (Date.now() > deadline) { controller.abort(); throw new Error('Child did not start.'); }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  controller.abort();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 800));
  const after = await readFile(marker, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await readFile(marker, 'utf8'), after, 'The descendant must stop writing after cancellation.');
});
