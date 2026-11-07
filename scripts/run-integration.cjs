const { runTests } = require('@vscode/test-electron');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'commit-extension-test-'));
  try {
    const folders = [];
    for (const name of ['first', 'second']) {
      const path = join(root, name);
      await mkdir(path);
      const git = (...args) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      await writeFile(join(path, 'example.txt'), 'original\n');
      git('add', '.'); git('commit', '-m', 'initial');
      await writeFile(join(path, 'example.txt'), `${name} staged\n`);
      git('add', '.');
      await writeFile(join(path, 'example.txt'), `${name} unstaged\n`);
      folders.push({ path });
    }
    const workspace = join(root, 'test.code-workspace');
    await writeFile(workspace, JSON.stringify({ folders, settings: { 'git.autofetch': false, 'git.confirmSync': false } }));
    const executable = join(root, 'fake-cli');
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const root = path.dirname(process.argv[1]);
  fs.appendFileSync(path.join(root, 'calls'), 'call\\n');
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }));
  fs.writeFileSync(path.join(root, 'started'), '1');
  setTimeout(() => {
    if (fs.existsSync(path.join(root, 'fail'))) { process.exit(6); }
    const message = input.includes('+second staged') ? 'Update the second example' : 'Update the first example';
    console.log(process.argv.includes('--print') ? JSON.stringify({type:'result',subtype:'success',is_error:false,result:message}) : message);
  }, 500);
});
`, { mode: 0o700 });
    await runTests({
      ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : {}),
      extensionDevelopmentPath: resolve(__dirname, '..'),
      extensionTestsPath: resolve(__dirname, '../test/integration.cjs'),
      extensionTestsEnv: { COMMIT_TEST_ROOT: root, COMMIT_TEST_CLI: executable },
      launchArgs: [workspace, '--user-data-dir', join(root, 'user'), '--extensions-dir', join(root, 'extensions'),
        '--enable-proposed-api=local-tools.codex-claude-commit',
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--disable-updates'],
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
