const vscode = require('vscode');
const assert = require('node:assert/strict');
const { readFile, writeFile, rm, access } = require('node:fs/promises');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.env.COMMIT_TEST_ROOT;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) { throw new Error('Timed out waiting for the test condition.'); }
    await delay(50);
  }
}
const exists = file => access(file).then(() => true, () => false);

exports.run = async () => {
  const errors = [];
  const showErrorMessage = vscode.window.showErrorMessage;
  vscode.window.showErrorMessage = (...args) => { errors.push(args[0]); return showErrorMessage(...args); };
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  await gitExtension.activate();
  const git = gitExtension.exports.getAPI(1);
  await until(() => git.repositories.length === 2);
  const first = git.repositories.find(repo => repo.rootUri.fsPath === join(root, 'first'));
  const second = git.repositories.find(repo => repo.rootUri.fsPath === join(root, 'second'));
  assert.ok(first && second);
  const config = vscode.workspace.getConfiguration('commitDraft');
  for (const [key, value] of Object.entries({ provider: 'codex', codexPath: process.env.COMMIT_TEST_CLI, claudePath: process.env.COMMIT_TEST_CLI })) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
  const extension = vscode.extensions.getExtension('meirb.codex-claude-commit');
  assert.ok(extension);
  await extension.activate();
  assert.ok((await vscode.commands.getCommands()).includes('commitDraft.generate'), 'The generation command must be registered.');

  const generate = repo => vscode.commands.executeCommand('commitDraft.generate', { rootUri: repo.rootUri });
  await generate(second);
  assert.equal(second.inputBox.value, 'Update the second example', errors.join('\n'));
  assert.equal(first.inputBox.value, '');
  const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
  assert.match(request.input, /\+second staged/);
  assert.doesNotMatch(request.input, /second unstaged/);
  console.log('PASS: real Git API fills the selected repository, using only staged changes');

  await config.update('provider', 'claude', vscode.ConfigurationTarget.Global);
  await generate(first);
  assert.equal(first.inputBox.value, 'Update the first example');
  assert.equal(second.inputBox.value, 'Update the second example');
  console.log('PASS: Claude output fills the actual Git input independently');

  first.inputBox.value = '';
  await rm(join(root, 'started'), { force: true });
  const pending = generate(first);
  await until(() => exists(join(root, 'started')));
  first.inputBox.value = 'My newer hand-written message';
  await pending;
  assert.equal(first.inputBox.value, 'My newer hand-written message');
  assert.ok(vscode.workspace.textDocuments.some(doc => doc.isUntitled && doc.getText() === 'Update the first example'));
  console.log('PASS: concurrent input edits are preserved and the draft opens separately');

  first.inputBox.value = '';
  await rm(join(root, 'started'), { force: true });
  const beforeCalls = (await readFile(join(root, 'calls'), 'utf8')).split('\n').length;
  const busy = generate(first);
  await until(() => exists(join(root, 'started')));
  await generate(first);
  await busy;
  const afterCalls = (await readFile(join(root, 'calls'), 'utf8')).split('\n').length;
  assert.equal(afterCalls, beforeCalls + 1);
  console.log('PASS: repeated clicks do not launch overlapping requests for a repository');

  first.inputBox.value = '';
  await rm(join(root, 'started'), { force: true });
  const stale = generate(first);
  await until(() => exists(join(root, 'started')));
  await writeFile(join(root, 'first', 'example.txt'), 'newly staged changes\n');
  execFileSync('git', ['add', '.'], { cwd: join(root, 'first') });
  await stale;
  assert.equal(first.inputBox.value, '');
  console.log('PASS: a changing staged diff prevents stale insertion');

  await writeFile(join(root, 'fail'), '1');
  await rm(join(root, 'started'), { force: true });
  const failure = generate(first);
  await until(() => exists(join(root, 'started')));
  first.inputBox.value = 'Keep this on failure';
  await failure;
  assert.equal(first.inputBox.value, 'Keep this on failure');
  assert.ok(errors.some(message => message.includes('exit code 6')));
  console.log('PASS: provider errors preserve the current input');

  await rm(join(root, 'fail'), { force: true });
  await rm(join(root, 'started'), { force: true });
  first.inputBox.value = '';
  const cancellation = new vscode.CancellationTokenSource();
  const withProgress = vscode.window.withProgress;
  // Supply user cancellation at the native token boundary; keep the real progress UI and command.
  vscode.window.withProgress = (options, task) => withProgress(options, progress => task(progress, cancellation.token));
  try {
    const cancelled = generate(first);
    await until(() => exists(join(root, 'started')));
    first.inputBox.value = 'Keep this on cancellation';
    cancellation.cancel();
    await cancelled;
    assert.equal(first.inputBox.value, 'Keep this on cancellation');
    assert.equal(errors.length, 1, 'Cancellation must not report an error notification.');
  } finally {
    vscode.window.withProgress = withProgress;
    cancellation.dispose();
  }
  console.log('PASS: native progress cancellation preserves the input and exits quietly');

  const warning = vscode.window.showWarningMessage;
  try {
    const callsBefore = await readFile(join(root, 'calls'), 'utf8');
    first.inputBox.value = 'Existing draft';
    vscode.window.showWarningMessage = async () => undefined;
    await generate(first);
    assert.equal(first.inputBox.value, 'Existing draft');
    assert.equal(await readFile(join(root, 'calls'), 'utf8'), callsBefore);
    console.log('PASS: declining replacement preserves the message without invoking a provider');

    vscode.window.showWarningMessage = async () => 'Replace';
    await generate(first);
    assert.equal(first.inputBox.value, 'Update the first example');
    console.log('PASS: confirming replacement inserts a new draft');
  } finally { vscode.window.showWarningMessage = warning; }

  const quickPick = vscode.window.showQuickPick;
  second.inputBox.value = '';
  try {
    vscode.window.showQuickPick = async items => items.find(item => item.repository?.rootUri.fsPath === second.rootUri.fsPath);
    await vscode.commands.executeCommand('commitDraft.generate');
    assert.equal(second.inputBox.value, 'Update the second example');
    assert.equal(first.inputBox.value, 'Update the first example');
    console.log('PASS: the Command Palette repository choice targets the selected input');
  } finally { vscode.window.showQuickPick = quickPick; }

  first.inputBox.value = '';
  await rm(join(root, 'started'), { force: true });
  const changedHead = generate(first);
  await until(() => exists(join(root, 'started')));
  const gitInFirst = (...args) => execFileSync('git', args, { cwd: first.rootUri.fsPath, encoding: 'utf8' });
  const stagedBefore = gitInFirst('diff', '--cached');
  gitInFirst('commit', '--only', '--allow-empty', '-m', 'Advance HEAD without changing the staged diff');
  assert.equal(gitInFirst('diff', '--cached'), stagedBefore);
  await changedHead;
  assert.equal(first.inputBox.value, '');
  console.log('PASS: a changing HEAD prevents insertion even when the staged diff is unchanged');

  const getConfiguration = vscode.workspace.getConfiguration;
  const invalidSettings = [
    ['provider', 'unknown'], ['codexPath', null], ['codexPath', 123],
    ['codexModel', 123], ['conventionalCommits', 'false'],
    ['timeoutSeconds', '120'], ['maxDiffBytes', null],
  ];
  await config.update('provider', 'codex', vscode.ConfigurationTarget.Global);
  first.inputBox.value = 'Keep my existing draft';
  let replacementPrompts = 0;
  const callsBeforeInvalid = await readFile(join(root, 'calls'), 'utf8');
  vscode.window.showWarningMessage = async () => { replacementPrompts++; return undefined; };
  try {
    for (const [key, value] of invalidSettings) {
      vscode.workspace.getConfiguration = (...args) => {
        const actual = getConfiguration(...args);
        return args[0] !== 'commitDraft' ? actual : {
          ...actual, get: (name, fallback) => name === key ? value : actual.get(name, fallback),
        };
      };
      const errorCount = errors.length;
      await generate(first);
      assert.equal(errors.length, errorCount + 1, `${key} must be rejected before prompting`);
      assert.ok(errors.at(-1).includes(`commitDraft.${key}`), errors.at(-1));
    }
    assert.equal(replacementPrompts, 0);
    assert.equal(first.inputBox.value, 'Keep my existing draft');
    assert.equal(await readFile(join(root, 'calls'), 'utf8'), callsBeforeInvalid);
  } finally {
    vscode.workspace.getConfiguration = getConfiguration;
    vscode.window.showWarningMessage = warning;
  }
  console.log('PASS: malformed settings produce actionable errors before prompting or launching a provider');

  const getExtension = vscode.extensions.getExtension;
  const stateChanged = new vscode.EventEmitter();
  let initialized = false;
  let repositoryReads = 0;
  const startingGit = {
    git: git.git,
    get state() { return initialized ? 'initialized' : 'uninitialized'; },
    onDidChangeState: stateChanged.event,
    get repositories() { repositoryReads++; return initialized ? git.repositories : []; },
  };
  first.inputBox.value = '';
  try {
    vscode.extensions.getExtension = id => id === 'vscode.git'
      ? { activate: async () => ({ enabled: true, getAPI: () => startingGit }) }
      : getExtension(id);
    const errorCount = errors.length;
    const starting = generate(first);
    await delay(100);
    assert.equal(repositoryReads, 0, 'Repository selection must wait for Git initialization.');
    initialized = true;
    stateChanged.fire('initialized');
    await starting;
    assert.equal(errors.length, errorCount);
    assert.equal(first.inputBox.value, 'Update the first example');
    console.log('PASS: Git startup waits for its native initialization event before selecting a repository');

    initialized = false;
    const startupCancellation = new vscode.CancellationTokenSource();
    let waitingForGit = false;
    const callsBeforeCancel = await readFile(join(root, 'calls'), 'utf8');
    const readsBeforeCancel = repositoryReads;
    vscode.window.withProgress = (options, task) => withProgress(options, progress => {
      waitingForGit = true;
      return task(progress, startupCancellation.token);
    });
    try {
      const cancelledStartup = generate(first);
      await until(() => waitingForGit);
      startupCancellation.cancel();
      await cancelledStartup;
      initialized = true;
      stateChanged.fire('initialized');
      assert.equal(repositoryReads, readsBeforeCancel);
      assert.equal(await readFile(join(root, 'calls'), 'utf8'), callsBeforeCancel);
      assert.equal(errors.length, errorCount);
      console.log('PASS: cancelling Git startup exits quietly without selecting a repository or launching a provider');
    } finally {
      vscode.window.withProgress = withProgress;
      startupCancellation.dispose();
    }

    vscode.extensions.getExtension = id => id === 'vscode.git'
      ? { activate: async () => ({ enabled: false, getAPI: () => assert.fail('Disabled Git must not be accessed') }) }
      : getExtension(id);
    await generate(first);
    assert.match(errors.at(-1), /Git.*disabled|[Ee]nable.*Git/);
    console.log('PASS: disabled Git produces actionable guidance without accessing an unavailable API');
  } finally {
    vscode.extensions.getExtension = getExtension;
    stateChanged.dispose();
  }

  first.inputBox.value = '';
  await rm(join(root, 'started'), { force: true });
  const shuttingDown = generate(first);
  await until(() => exists(join(root, 'started')));
  const shutdownRequest = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
  first.inputBox.value = 'Keep this on shutdown';
  const errorCount = errors.length;
  const lifecycle = require('../dist/extension.js');
  assert.equal(typeof lifecycle.deactivate, 'function');
  await lifecycle.deactivate();
  assert.equal(await exists(shutdownRequest.cwd), false, 'Deactivation must await provider directory cleanup.');
  await shuttingDown;
  assert.equal(first.inputBox.value, 'Keep this on shutdown');
  assert.equal(errors.length, errorCount);
  const callsAfterShutdown = await readFile(join(root, 'calls'), 'utf8');
  await generate(first);
  assert.equal(await readFile(join(root, 'calls'), 'utf8'), callsAfterShutdown);
  console.log('PASS: native deactivation awaits process and directory cleanup and prevents new requests');
  vscode.window.showErrorMessage = showErrorMessage;
};
