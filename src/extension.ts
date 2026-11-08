import * as vscode from 'vscode';
import { basename, isAbsolute } from 'node:path';
import { collectDiff, DEFAULT_BUDGET, READ_LIMIT, type DiffSnapshot } from './diff';
import { SettingError } from './errors';
import { generateMessage, PROVIDER_NAMES, type ProviderOptions } from './providers';
import type { GitAPI, GitExtension, GitRepository } from './git-api';

const pending = new Map<AbortController, Promise<void>>();
const activeRepositories = new Set<string>();
let stopping = false;

export function activate(context: vscode.ExtensionContext): void {
  stopping = false;
  context.subscriptions.push(vscode.commands.registerCommand('commitDraft.selectProvider', async () => {
    const config = vscode.workspace.getConfiguration('commitDraft');
    const current = config.get<unknown>('provider');
    const selected = await vscode.window.showQuickPick([
      { label: 'Codex', description: 'Use your installed Codex CLI', value: 'codex' },
      { label: 'Claude', description: 'Use your installed Claude Code CLI', value: 'claude' },
    ].map(item => item.value === current ? { ...item, description: `${item.description} (current)` } : item),
    { title: 'Commit Message Provider', placeHolder: 'Choose the tool you have installed and signed in to' });
    if (selected) {
      await config.update('provider', selected.value, vscode.ConfigurationTarget.Global);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('commitDraft.generate',
    (sourceControl?: unknown, _changes?: unknown, token?: vscode.CancellationToken) =>
      generateCommitMessage(sourceControl, token)));
}

export async function deactivate(): Promise<void> {
  stopping = true;
  for (const controller of pending.keys()) { controller.abort(); }
  await Promise.allSettled(pending.values());
}

async function withProgress(title: string,
  task: (progress: vscode.Progress<{ message?: string }>, signal: AbortSignal) => Promise<void>,
  inputToken?: vscode.CancellationToken): Promise<void> {
  if (stopping) { return; }
  const controller = new AbortController();
  const operation = Promise.resolve(vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title, cancellable: true,
  }, async (progress, token) => {
    const subscription = token.onCancellationRequested(() => controller.abort());
    const inputSubscription = inputToken?.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested || inputToken?.isCancellationRequested) { controller.abort(); }
    try { await task(progress, controller.signal); }
    finally { subscription.dispose(); inputSubscription?.dispose(); }
  }));
  pending.set(controller, operation);
  try { await operation; }
  finally { pending.delete(controller); }
}

async function waitForGit(git: GitAPI, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (git.state === 'initialized') { return; }
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timeout);
      subscription.dispose();
      signal.removeEventListener('abort', cancel);
      if (error) { reject(error); } else { resolve(); }
    };
    const subscription = git.onDidChangeState(state => { if (state === 'initialized') { finish(); } });
    const timeout = setTimeout(() => finish(new Error('Git is still starting. Check the Git output panel and try again.')), 15000);
    const cancel = (): void => finish(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); }
    else if (git.state === 'initialized') { finish(); }
  });
}

async function generateCommitMessage(sourceControl: unknown, inputToken?: vscode.CancellationToken): Promise<void> {
  try {
    if (stopping || inputToken?.isCancellationRequested) { return; }
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before running the commit-message tool.'); }
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) { throw new Error('Enable VS Code’s built-in Git extension first.'); }
    const gitExtension = await extension.activate();
    if (stopping) { return; }
    if (!gitExtension.enabled) { throw new Error('Enable Git in VS Code settings and ensure Git is installed.'); }
    const git = gitExtension.getAPI(1);
    if (git.state !== 'initialized') {
      await withProgress('Waiting for Git repositories', (_progress, signal) => waitForGit(git, signal), inputToken);
    }
    if (stopping) { return; }
    const repository = await chooseRepository(git, sourceControl);
    if (!repository || stopping) { return; }
    if (repository.rootUri.scheme !== 'file') { throw new Error('Open a local Git checkout to generate a commit message.'); }
    const key = repository.rootUri.toString();
    if (activeRepositories.has(key)) {
      void vscode.window.showInformationMessage('A commit message is already being generated for this repository.');
      return;
    }
    activeRepositories.add(key);
    try {
      const { provider, maxDiffBytes } = readOptions(repository.rootUri);
      const initialMessage = repository.inputBox.value;
      if (initialMessage.trim() && await vscode.window.showWarningMessage(
        'Replace the existing commit message with a new draft?', { modal: true }, 'Replace') !== 'Replace') {
        return;
      }
      await withProgress(`Generating commit message with ${PROVIDER_NAMES[provider.provider]}`,
        async (progress, signal) => {
          progress.report({ message: 'Reading changes…' });
          const snapshot = await collectDiff(git.git.path, repository.rootUri.fsPath, signal, maxDiffBytes);
          progress.report({ message: describeSnapshot(snapshot, maxDiffBytes) });
          const message = await generateMessage(provider, snapshot, signal);
          signal.throwIfAborted();
          // A clean, closed or conflicted repository makes the draft stale.
          const current = await collectDiff(git.git.path, repository.rootUri.fsPath, signal, maxDiffBytes).catch(() => undefined);
          signal.throwIfAborted();
          // The Git API creates fresh wrappers on each repositories access; compare URIs, not objects.
          const currentRepository = git.repositories.find(item => item.rootUri.toString() === key);
          if (current?.fingerprint !== snapshot.fingerprint || currentRepository?.inputBox.value !== initialMessage) {
            const document = await vscode.workspace.openTextDocument({ content: message, language: 'git-commit' });
            await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
            void vscode.window.showInformationMessage('The changes or commit message changed during generation. Your draft is open in a separate editor.');
            return;
          }
          currentRepository.inputBox.value = message;
          await vscode.commands.executeCommand('workbench.view.scm');
        }, inputToken);
    } finally {
      activeRepositories.delete(key);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') { return; }
    const message = `Commit message: ${error instanceof Error ? error.message : 'Generation failed. Try again.'}`;
    if (error instanceof SettingError) {
      void vscode.window.showErrorMessage(message, 'Open Settings').then(action =>
        action && vscode.commands.executeCommand('workbench.action.openSettings', `commitDraft.${error.setting}`));
    } else { void vscode.window.showErrorMessage(message); }
  }
}

async function chooseRepository(git: GitAPI, context: unknown): Promise<GitRepository | undefined> {
  const repositories = git.repositories;
  const root = context instanceof vscode.Uri ? context
    : context && typeof context === 'object' && 'rootUri' in context ? context.rootUri : undefined;
  if (root instanceof vscode.Uri) {
    const repository = repositories.find(item => item.rootUri.toString() === root.toString());
    if (!repository) { throw new Error('The selected Git repository is no longer open.'); }
    return repository;
  }
  if (!repositories.length) { throw new Error('Open a folder containing a Git repository first.'); }
  if (repositories.length === 1) { return repositories[0]; }
  const selected = await vscode.window.showQuickPick(repositories.map(repository => ({
    label: basename(repository.rootUri.fsPath), description: repository.rootUri.fsPath, repository,
  })), { title: 'Generate Commit Message', placeHolder: 'Choose a Git repository' });
  return selected?.repository;
}

function describeSnapshot(snapshot: DiffSnapshot, budget: number): string {
  const files = `${snapshot.files} ${snapshot.files === 1 ? 'file' : 'files'}`;
  const size = snapshot.bytes === undefined ? `over ${formatBytes(READ_LIMIT)}` : formatBytes(snapshot.bytes);
  const source = snapshot.source === 'staged' ? 'Staged changes' : 'Nothing staged, using tracked changes';
  return `${source}: ${files}, ${size}${snapshot.condensed ? ` (condensed to fit ${formatBytes(budget)})` : ''}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} bytes`; }
  if (bytes < 1048576) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / 1048576).toFixed(1).replace(/\.0$/, '')} MB`;
}

function settingError(setting: string, requirement: string): SettingError {
  return new SettingError(`Set commitDraft.${setting} to ${requirement}.`, setting);
}

function readOptions(uri: vscode.Uri): { provider: ProviderOptions; maxDiffBytes: number } {
  const config = vscode.workspace.getConfiguration('commitDraft', uri);
  const integer = (setting: string, fallback: number, min: number, max: number): number => {
    const value = config.get<unknown>(setting, fallback);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw settingError(setting, `an integer between ${min} and ${max}`);
    }
    return value;
  };
  const provider = config.get<unknown>('provider', 'codex');
  if (provider !== 'codex' && provider !== 'claude') { throw settingError('provider', '"codex" or "claude"'); }
  const path = config.get<unknown>(`${provider}Path`, provider);
  const executable = typeof path === 'string' && !/[\0\r\n]/.test(path) ? path.trim() : '';
  if (!executable || (!isAbsolute(executable) && /[\\/\s]/.test(executable))) {
    throw settingError(`${provider}Path`, 'an executable name or absolute path without command arguments');
  }
  const model = config.get<unknown>(`${provider}Model`, '');
  if (typeof model !== 'string' || /[\0\r\n]/.test(model)) {
    throw settingError(`${provider}Model`, 'a model name string, or leave it empty for the default');
  }
  const conventional = config.get<unknown>('conventionalCommits', false);
  if (typeof conventional !== 'boolean') { throw settingError('conventionalCommits', 'true or false'); }
  return {
    provider: { provider, executable, model, conventional, timeoutMs: integer('timeoutSeconds', 120, 10, 600) * 1000 },
    maxDiffBytes: integer('maxDiffBytes', DEFAULT_BUDGET, 1024, 1048576),
  };
}
