const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm, access, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { generateMessage } = require('../dist/test/providers.js');
const { buildPrompt, normalizeMessage } = require('../dist/test/message.js');

const snapshot = { source: 'staged', text: 'diff --git a/a.txt b/a.txt\n-old\n+new secret value\n', condensed: false };

async function fakeCli(t, provider, behavior = 'success') {
  const cwd = await mkdtemp(join(tmpdir(), 'provider-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executable = join(cwd, 'fake-cli');
  const capture = join(cwd, 'capture.json');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, input, cwd: process.cwd() }));
  if (${JSON.stringify(behavior)} === 'stall') { setInterval(() => {}, 1000); return; }
  if (${JSON.stringify(behavior)} === 'fail') { process.exit(5); }
  if (${JSON.stringify(behavior)} === 'json-error') { console.log(JSON.stringify({type:'result',is_error:true,result:'provider failure'})); return; }
  if (${JSON.stringify(behavior)} === 'invalid') { console.log('not JSON'); return; }
  if (${JSON.stringify(behavior)} === 'exit-json-error') {
    console.log(JSON.stringify({type:'result',is_error:true,result:'There is an issue with the selected model.'}));
    process.exit(1);
  }
  if (${JSON.stringify(behavior)} === 'echo-error') {
    process.stderr.write('user\\n' + input + '\\n');
    process.stderr.write('ERROR: ' + JSON.stringify({type:'error',status:400,error:{message:'The requested model is not supported.'}}) + '\\n');
    process.exit(1);
  }
  if (${JSON.stringify(behavior)} === 'echo-fail') { process.stderr.write(input); process.exit(1); }
  const message = 'Update the example value';
  console.log(${JSON.stringify(provider)} === 'codex' ? message : JSON.stringify({type:'result',subtype:'success',is_error:false,result:message}));
});
`, { mode: 0o700 });
  return { cwd, executable, capture };
}

test('prompt describes the supplied diff without treating patch text as instructions', () => {
  const prompt = buildPrompt(snapshot, false);
  assert.match(prompt, /untrusted|data.*not.*instructions/i);
  assert.match(prompt, /staged/);
  assert.ok(prompt.includes(snapshot.text));
  assert.match(buildPrompt(snapshot, true), /Conventional Commits/);
  assert.doesNotMatch(prompt, /condensed/);
  assert.match(buildPrompt({ ...snapshot, condensed: true }, false), /condensed/);
});

test('normalizes a fenced commit draft while preserving its body', () => {
  assert.equal(normalizeMessage('```text\r\nFix the timeout\r\n\r\nCancel pending requests.\r\n```'),
    'Fix the timeout\n\nCancel pending requests.');
});

test('rejects empty, oversized and control-character responses', () => {
  assert.throws(() => normalizeMessage('  '), /empty/i);
  assert.throws(() => normalizeMessage('x'.repeat(5000)), /long|large/i);
  assert.throws(() => normalizeMessage('Fix\u0000thing'), /control|invalid/i);
});

for (const provider of ['codex', 'claude']) {
  test(`${provider} sends only stdin context, applies restrictions and removes its temporary directory`,
    { skip: process.platform === 'win32' }, async t => {
      const { cwd, executable, capture } = await fakeCli(t, provider);
      const result = await generateMessage({ provider, executable, model: 'test-model', conventional: false, timeoutMs: 2000 }, snapshot);
      assert.equal(result, 'Update the example value');
      const request = JSON.parse(await readFile(capture, 'utf8'));
      assert.ok(request.input.includes(snapshot.text));
      assert.ok(!request.args.join(' ').includes(snapshot.text));
      assert.notEqual(request.cwd, cwd);
      await assert.rejects(access(request.cwd));
      assert.equal(request.args[request.args.indexOf('--model') + 1], 'test-model');
      if (provider === 'codex') {
        assert.equal(request.args[0], 'exec');
        assert.ok(request.args.includes('--ignore-user-config'));
        assert.ok(request.args.includes('--ephemeral'));
        assert.equal(request.args[request.args.indexOf('--sandbox') + 1], 'read-only');
        assert.ok(request.args.includes('features.shell_tool=false'));
        assert.ok(request.args.includes('features.apps=false'));
      } else {
        assert.ok(request.args.includes('--safe-mode'));
        assert.ok(request.args.includes('--strict-mcp-config'));
        assert.ok(request.args.includes('--no-session-persistence'));
        assert.equal(request.args[request.args.indexOf('--tools') + 1], '');
        assert.equal(request.args[request.args.indexOf('--disallowedTools') + 1], 'mcp__*');
      }
    });
}

for (const behavior of ['fail', 'json-error', 'invalid', 'stall']) {
  test(`cleans up and rejects Claude ${behavior}`, { skip: process.platform === 'win32' }, async t => {
    const { executable, capture } = await fakeCli(t, 'claude', behavior);
    await assert.rejects(generateMessage({ provider: 'claude', executable, model: '', conventional: false, timeoutMs: 500 }, snapshot));
    const request = JSON.parse(await readFile(capture, 'utf8'));
    await assert.rejects(access(request.cwd));
  });
}

const options = (provider, executable, overrides = {}) =>
  ({ provider, executable, model: '', conventional: false, timeoutMs: 2000, ...overrides });

test('shows the reason from a failing Claude JSON result', { skip: process.platform === 'win32' }, async t => {
  const { executable } = await fakeCli(t, 'claude', 'exit-json-error');
  await assert.rejects(generateMessage(options('claude', executable), snapshot),
    /Claude reported an error: There is an issue with the selected model\./);
});

test('shows only the Codex ERROR line, never the echoed diff', { skip: process.platform === 'win32' }, async t => {
  const { executable } = await fakeCli(t, 'codex', 'echo-error');
  await assert.rejects(generateMessage(options('codex', executable), snapshot), error => {
    assert.equal(error.message, 'Codex reported an error: The requested model is not supported.');
    return true;
  });
});

test('keeps the generic exit error when Codex prints no ERROR line', { skip: process.platform === 'win32' }, async t => {
  const { executable } = await fakeCli(t, 'codex', 'echo-fail');
  await assert.rejects(generateMessage(options('codex', executable), snapshot), error => {
    assert.match(error.message, /Codex failed with exit code 1/);
    assert.doesNotMatch(error.message, /secret value/);
    return true;
  });
});

test('points timeouts and missing executables at the setting that fixes them', { skip: process.platform === 'win32' }, async t => {
  const { executable } = await fakeCli(t, 'codex', 'stall');
  await assert.rejects(generateMessage(options('codex', executable, { timeoutMs: 300 }), snapshot), error => {
    assert.equal(error.setting, 'timeoutSeconds');
    assert.match(error.message, /did not finish within 0\.3 seconds/);
    return true;
  });
  await assert.rejects(generateMessage(options('claude', '/nonexistent/claude-cli'), snapshot), error => {
    assert.equal(error.setting, 'claudePath');
    return true;
  });
});
