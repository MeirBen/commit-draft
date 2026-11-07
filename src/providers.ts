import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffSnapshot } from './diff';
import { buildPrompt, normalizeMessage } from './message';
import { runProcess } from './process';

export interface ProviderOptions {
  provider: 'codex' | 'claude';
  executable: string;
  model: string;
  conventional: boolean;
  timeoutMs: number;
}

export async function generateMessage(options: ProviderOptions, snapshot: DiffSnapshot, signal?: AbortSignal): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'vscode-commit-draft-'));
  try {
    const args = options.provider === 'codex'
      ? ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only',
        '--color', 'never', '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false',
        '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.multi_agent=false',
        '-c', 'features.view_image=false', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0']
      : ['--print', '--output-format', 'json', '--safe-mode', '--tools', '', '--disallowedTools', 'mcp__*',
        '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
        '--disable-slash-commands', '--no-chrome'];
    const model = options.model.trim();
    if (model) { args.push('--model', model); }
    if (options.provider === 'codex') { args.push('-'); }
    const output = await runProcess(options.executable, args, {
      cwd, signal, input: buildPrompt(snapshot, options.conventional),
      timeoutMs: options.timeoutMs, maxBytes: 65536,
    });
    if (options.provider === 'codex') { return normalizeMessage(output); }
    let result: unknown;
    try { result = JSON.parse(output); }
    catch { throw new Error('Claude returned an unexpected response. Update Claude Code and try again.'); }
    if (!result || typeof result !== 'object' || !('result' in result) ||
      !('is_error' in result) || result.is_error !== false || typeof result.result !== 'string') {
      throw new Error('Claude could not generate a message. Check its sign-in and usage limits, then try again.');
    }
    return normalizeMessage(result.result);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
