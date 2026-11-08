import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffSnapshot } from './diff';
import { SettingError } from './errors';
import { buildPrompt, normalizeMessage } from './message';
import { ProcessError, runProcess } from './process';

export interface ProviderOptions {
  provider: 'codex' | 'claude';
  executable: string;
  model: string;
  conventional: boolean;
  timeoutMs: number;
}

export const PROVIDER_NAMES = { codex: 'Codex', claude: 'Claude' } as const;

const CODEX_ARGS = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only',
  '--color', 'never', '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false',
  '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.multi_agent=false',
  '-c', 'features.view_image=false', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0'];
const CLAUDE_ARGS = ['--print', '--output-format', 'json', '--safe-mode', '--tools', '', '--disallowedTools', 'mcp__*',
  '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
  '--disable-slash-commands', '--no-chrome'];

export async function generateMessage(options: ProviderOptions, snapshot: DiffSnapshot, signal?: AbortSignal): Promise<string> {
  const codex = options.provider === 'codex';
  const model = options.model.trim();
  const args = [...(codex ? CODEX_ARGS : CLAUDE_ARGS), ...(model ? ['--model', model] : []), ...(codex ? ['-'] : [])];
  const cwd = await mkdtemp(join(tmpdir(), 'vscode-commit-draft-'));
  try {
    const output = await runProcess(options.executable, args, {
      cwd, signal, input: buildPrompt(snapshot, options.conventional),
      timeoutMs: options.timeoutMs, maxBytes: 65536, label: PROVIDER_NAMES[options.provider],
    }).catch((error: unknown) => { throw explainFailure(error, options); });
    if (codex) { return normalizeMessage(output); }
    const result = parseClaudeResult(output);
    if (!result) { throw new Error('Claude returned an unexpected response. Update Claude Code and try again.'); }
    if (!result.isError && result.text !== undefined) { return normalizeMessage(result.text); }
    const reason = conciseReason(result.isError ? result.text : undefined);
    throw new Error(reason ? `Claude reported an error: ${reason}`
      : 'Claude could not generate a message. Check its sign-in and usage limits, then try again.');
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function explainFailure(error: unknown, options: ProviderOptions): unknown {
  if (!(error instanceof ProcessError)) { return error; }
  const name = PROVIDER_NAMES[options.provider];
  switch (error.failure) {
    case 'start':
      return new SettingError(error.message, `${options.provider}Path`);
    case 'timeout':
      return new SettingError(`${name} did not finish within ${options.timeoutMs / 1000} seconds. Try again, or increase commitDraft.timeoutSeconds.`, 'timeoutSeconds');
    case 'exit': {
      const claude = options.provider === 'claude' ? parseClaudeResult(error.stdout) : undefined;
      const reason = conciseReason(claude ? (claude.isError ? claude.text : undefined) : codexError(error.stderrTail));
      return reason ? new Error(`${name} reported an error: ${reason}`) : error;
    }
    default:
      return error;
  }
}

/** Claude Code prints one JSON result; only `is_error: false` with a string `result` is a success. */
function parseClaudeResult(output: string): { isError: boolean; text: string | undefined } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') { return { isError: true, text: undefined }; }
  return {
    isError: !('is_error' in parsed) || parsed.is_error !== false,
    text: 'result' in parsed && typeof parsed.result === 'string' ? parsed.result : undefined,
  };
}

/** Codex echoes the prompt (the diff) on stderr, so only its own `ERROR:` lines are read. */
function codexError(stderrTail: string): string | undefined {
  const line = stderrTail.split(/\r?\n/).findLast(item => item.startsWith('ERROR: '))?.slice('ERROR: '.length);
  if (!line) { return undefined; }
  const messageOf = (value: unknown): unknown => value && typeof value === 'object' && 'message' in value ? value.message : undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    const message = messageOf(parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : undefined) ?? messageOf(parsed);
    if (typeof message === 'string') { return message; }
  } catch { /* A plain-text error line. */ }
  return line;
}

function conciseReason(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, ' ').trim();
  if (!line) { return undefined; }
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}
