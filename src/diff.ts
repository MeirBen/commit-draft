import { ProcessError, runProcess } from './process';

export interface DiffSnapshot {
  source: 'staged' | 'unstaged';
  text: string;
  head: string;
}

export async function collectDiff(gitPath: string, cwd: string, signal?: AbortSignal, maxBytes = 102400): Promise<DiffSnapshot> {
  // GIT_DIFF_OPTS overrides even an explicit --unified argument.
  const env = { ...process.env };
  delete env.GIT_DIFF_OPTS;
  const git = (args: string[], limit = maxBytes): Promise<string> => runProcess(gitPath,
    ['--no-optional-locks', '-c', 'core.quotePath=true', '-c', 'diff.submodule=short', ...args],
    { cwd, signal, env, label: 'Git', timeoutMs: 15000, maxBytes: limit });

  let head: string;
  try { head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], 256)).trim(); }
  catch (error) {
    if (!(error instanceof ProcessError) || error.exitCode !== 1) { throw error; }
    head = ''; // An unborn branch has no HEAD yet.
  }
  if ((await git(['diff', '--name-only', '--diff-filter=U', '--'], 16384)).trim()) {
    throw new Error('Resolve merge conflicts before generating a commit message.');
  }
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none',
    '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--inter-hunk-context=0', '--'];
  const staged = await git(['diff', '--cached', ...flags]);
  if (staged.trim()) { return { source: 'staged', text: staged, head }; }
  const unstaged = await git(['diff', ...flags]);
  if (!unstaged.trim()) {
    throw new Error('No tracked changes to describe. Save your edits and stage any new files, then try again.');
  }
  return { source: 'unstaged', text: unstaged, head };
}

