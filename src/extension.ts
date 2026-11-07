import * as vscode from 'vscode';
import { basename, isAbsolute } from 'node:path';
import { collectDiff, type DiffSnapshot } from './diff';
import { generateMessage, type ProviderOptions } from './providers';
import type { GitAPI, GitExtension, GitRepository } from './git-api';

export function activate(context: vscode.ExtensionContext): void {
  const active = new Map<string, AbortController>();
  context.subscriptions.push({ dispose: () => { for (const controller of active.values()) { controller.abort(); } } });
  context.subscriptions.push(vscode.commands.registerCommand('commitDraft.selectProvider', async () => {
    const selected = await vscode.window.showQuickPick([
      { label: 'Codex', description: 'Use your installed Codex CLI', value: 'codex' },
      { label: 'Claude', description: 'Use your installed Claude Code CLI', value: 'claude' },
    ], { title: 'Commit Message Provider', placeHolder: 'Choose the tool you have installed and signed in to' });
    if (selected) {
      await vscode.workspace.getConfiguration('commitDraft').update('provider', selected.value, vscode.ConfigurationTarget.Global);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('commitDraft.generate',
    (sourceControl?: unknown) => generateCommitMessage(sourceControl, active)));
}

async function generateCommitMessage(sourceControl: unknown, active: Map<string, AbortController>): Promise<void> {
  try {
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before running the commit-message tool.'); }
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) { throw new Error('Enable VS Code’s built-in Git extension first.'); }
    const git = (await extension.activate()).getAPI(1);
    const repository = await chooseRepository(git, sourceControl);
    if (!repository) { return; }
    if (repository.rootUri.scheme !== 'file') { throw new Error('Open a local Git checkout to generate a commit message.'); }
    const key = repository.rootUri.toString();
    if (active.has(key)) {
      void vscode.window.showInformationMessage('A commit message is already being generated for this repository.');
      return;
    }
    const controller = new AbortController();
    active.set(key, controller);
    try {
      const initialMessage = repository.inputBox.value;
      if (initialMessage.trim() && await vscode.window.showWarningMessage(
        'Replace the existing commit message with a new draft?', { modal: true }, 'Replace') !== 'Replace') {
        return;
      }
      const { provider, maxDiffBytes } = readOptions(repository.rootUri);
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Generating commit message with ${provider.provider === 'codex' ? 'Codex' : 'Claude'}`,
        cancellable: true,
      }, async (progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) { controller.abort(); }
        try {
          const snapshot = await collectDiff(git.git.path, repository.rootUri.fsPath, controller.signal, maxDiffBytes);
          progress.report({ message: snapshot.source === 'staged' ? 'Using staged changes' : 'Using tracked unstaged changes' });
          const message = await generateMessage(provider, snapshot, controller.signal);
          controller.signal.throwIfAborted();
          let current: DiffSnapshot | undefined;
          try { current = await collectDiff(git.git.path, repository.rootUri.fsPath, controller.signal, maxDiffBytes); }
          catch { /* A clean, closed or conflicted repository makes the draft stale. */ }
          controller.signal.throwIfAborted();
          // The Git API creates fresh wrappers on each repositories access; compare URIs, not objects.
          const currentRepository = git.repositories.find(item => item.rootUri.toString() === key);
          if (!current || current.source !== snapshot.source || current.text !== snapshot.text || current.head !== snapshot.head ||
            !currentRepository || currentRepository.inputBox.value !== initialMessage) {
            const document = await vscode.workspace.openTextDocument({ content: message, language: 'git-commit' });
            await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
            void vscode.window.showInformationMessage('The changes or commit message changed during generation. Your draft is open in a separate editor.');
            return;
          }
          currentRepository.inputBox.value = message;
          await vscode.commands.executeCommand('workbench.view.scm');
        } finally {
          subscription.dispose();
        }
      });
    } finally {
      active.delete(key);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') { return; }
    void vscode.window.showErrorMessage(`Commit message: ${error instanceof Error ? error.message : 'Generation failed. Try again.'}`);
  }
}

async function chooseRepository(git: GitAPI, context: unknown): Promise<GitRepository | undefined> {
  const root = context instanceof vscode.Uri ? context
    : context && typeof context === 'object' && 'rootUri' in context ? context.rootUri : undefined;
  if (root instanceof vscode.Uri) {
    const repository = git.repositories.find(item => item.rootUri.toString() === root.toString());
    if (!repository) { throw new Error('The selected Git repository is no longer open.'); }
    return repository;
  }
  if (!git.repositories.length) { throw new Error('Open a folder containing a Git repository first.'); }
  if (git.repositories.length === 1) { return git.repositories[0]; }
  const selected = await vscode.window.showQuickPick(git.repositories.map(repository => ({
    label: basename(repository.rootUri.fsPath), description: repository.rootUri.fsPath, repository,
  })), { title: 'Generate Commit Message', placeHolder: 'Choose a Git repository' });
  return selected?.repository;
}

function readOptions(uri: vscode.Uri): { provider: ProviderOptions; maxDiffBytes: number } {
  const config = vscode.workspace.getConfiguration('commitDraft', uri);
  const provider = config.get<string>('provider', 'codex');
  if (provider !== 'codex' && provider !== 'claude') { throw new Error('Choose Codex or Claude in the provider setting.'); }
  const executable = config.get<string>(`${provider}Path`, provider).trim();
  if (!executable || (!isAbsolute(executable) && /[\\/\s]/.test(executable))) {
    throw new Error('Set the CLI path to an executable name or an absolute path, without command arguments.');
  }
  const timeout = config.get<number>('timeoutSeconds', 120);
  const maxDiffBytes = config.get<number>('maxDiffBytes', 102400);
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600 ||
    !Number.isInteger(maxDiffBytes) || maxDiffBytes < 1024 || maxDiffBytes > 1048576) {
    throw new Error('Check the timeout and maximum diff size in extension settings.');
  }
  return {
    provider: { provider, executable, model: config.get<string>(`${provider}Model`, ''),
      conventional: config.get<boolean>('conventionalCommits', false), timeoutMs: timeout * 1000 },
    maxDiffBytes,
  };
}
