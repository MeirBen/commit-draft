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
  const extension = vscode.extensions.getExtension('local-tools.codex-claude-commit');
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
  vscode.window.showErrorMessage = showErrorMessage;
};
