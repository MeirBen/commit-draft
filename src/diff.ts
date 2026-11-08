import { createHash } from 'node:crypto';
import { condenseDiff } from './condense';
import { ProcessError, runProcess } from './process';

export interface DiffSnapshot {
  source: 'staged' | 'unstaged';
  /** Diff text for the prompt: the full patch, or a condensed form when it exceeds the budget. */
  text: string;
  /** Identifies the source, HEAD and full diff, so a change during generation can be detected. */
  fingerprint: string;
  files: number;
  /** Full patch size; undefined when it exceeds READ_LIMIT. */
  bytes: number | undefined;
  condensed: boolean;
}

export const DEFAULT_BUDGET = 262144;
export const READ_LIMIT = 32 * 1024 * 1024;
const OVERVIEW_LIMIT = 8 * 1024 * 1024;
const SCOPE = { staged: ['--cached'], unstaged: [] } as const;
const FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none',
  '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--inter-hunk-context=0'];

export async function collectDiff(gitPath: string, cwd: string, signal?: AbortSignal,
  budget = DEFAULT_BUDGET, readLimit = READ_LIMIT): Promise<DiffSnapshot> {
  // GIT_DIFF_OPTS overrides even an explicit --unified argument.
  const env = { ...process.env };
  delete env.GIT_DIFF_OPTS;
  const git = (args: string[], limit: number): Promise<string> => runProcess(gitPath,
    ['--no-optional-locks', '-c', 'core.quotePath=true', '-c', 'diff.submodule=short', ...args],
    { cwd, signal, env, label: 'Git', timeoutMs: 60000, maxBytes: limit });
  const gitWithinLimit = (args: string[], limit: number): Promise<string | undefined> => git(args, limit).catch((error: unknown) => {
    if (error instanceof ProcessError && error.failure === 'output-limit') { return undefined; }
    throw error;
  });

  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], 256).then(text => text.trim(), (error: unknown) => {
    if (error instanceof ProcessError && error.exitCode === 1) { return ''; } // An unborn branch has no HEAD yet.
    throw error;
  });
  if ((await git(['diff', '--name-only', '--diff-filter=U', '--'], 16384)).trim()) {
    throw new Error('Resolve merge conflicts before generating a commit message.');
  }
  const readPatch = (source: DiffSnapshot['source']): Promise<string | undefined> =>
    gitWithinLimit(['diff', ...SCOPE[source], ...FLAGS, '--'], readLimit);

  let source: DiffSnapshot['source'] = 'staged';
  let patch = await readPatch(source);
  if (patch?.trim() === '') {
    source = 'unstaged';
    patch = await readPatch(source);
    if (patch?.trim() === '') {
      throw new Error('No tracked changes to describe. Save your edits and stage any new files, then try again.');
    }
  }
  const fingerprint = (content: string): string => createHash('sha256').update(`${source}\0${head}\0`).update(content).digest('hex');
  const bytes = patch === undefined ? undefined : Buffer.byteLength(patch, 'utf8');
  if (patch !== undefined && bytes !== undefined && bytes <= budget) {
    return { source, text: patch, fingerprint: fingerprint(patch), files: countMatches(patch, /^diff --git /gm), bytes, condensed: false };
  }

  const overview = await gitWithinLimit(['diff', ...SCOPE[source], ...FLAGS, '--numstat', '--summary', '--'], OVERVIEW_LIMIT);
  if (overview === undefined) {
    throw new Error('Too many files changed to summarize. Stage a smaller set of changes, then try again.');
  }
  return {
    source, text: condenseDiff(patch, overview, budget),
    // Past READ_LIMIT only the overview is available, so edits that keep every file's line counts go unnoticed.
    fingerprint: fingerprint(patch ?? overview),
    files: countMatches(overview, /^(?:\d+|-)\t(?:\d+|-)\t/gm), bytes, condensed: true,
  };
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}
