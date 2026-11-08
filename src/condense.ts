const GENERATED_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|packages\.lock\.json|flake\.lock|[^/]+\.min\.(?:js|css)|[^/]+\.map|[^/]+\.snap)$/;
const MIN_EXCERPT_BYTES = 256;
const MARKER_RESERVE = 64;
const FRAME_RESERVE = 512;

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Fits a diff that exceeds `budget` bytes into it: an overview of every changed file first,
 * then per-file patch excerpts that share the remaining space fairly. Lock and generated files
 * appear only in the overview. A missing patch (too large to read) yields the overview alone.
 */
export function condenseDiff(patch: string | undefined, overview: string, budget: number): string {
  const heading = 'File overview (lines added, lines removed, path; "-" marks a binary file):\n';
  const overviewBudget = (patch === undefined ? budget - FRAME_RESERVE : Math.floor(budget / 2)) - byteLength(heading);
  let text = heading + takeLines(overview.trimEnd() + '\n', overviewBudget, count => `[... ${count} more overview lines omitted]\n`);
  if (patch === undefined) {
    return `${text}\n[Patch excerpts omitted: the diff is too large to read.]\n`;
  }

  const sections = patch.split(/^(?=diff --git )/m).filter(section => section.length > 0);
  const excerptable = sections.filter(section => !GENERATED_FILE.test(section.split('\n', 1)[0] ?? ''));
  const sizes = excerptable.map(byteLength);
  const shares = shareFairly(sizes, budget - byteLength(text) - FRAME_RESERVE);
  const excerpts: string[] = [];
  let omitted = sections.length - excerptable.length;
  excerptable.forEach((section, index) => {
    const excerpt = shares[index]! >= sizes[index]! ? section : excerptSection(section, shares[index]!);
    if (excerpt) { excerpts.push(excerpt); } else { omitted++; }
  });
  text += `\nPatch excerpts (long files are shortened):\n${excerpts.join('')}`;
  if (omitted) {
    text += `\n[${omitted} ${omitted === 1 ? 'file appears' : 'files appear'} only in the overview: lock or generated files, or no room for an excerpt.]\n`;
  }
  return text;
}

/** Water-filling: small sections keep their full size; large ones split what is left equally. */
function shareFairly(sizes: readonly number[], total: number): number[] {
  const shares = sizes.map(() => 0);
  const order = sizes.map((_, index) => index).sort((a, b) => sizes[a]! - sizes[b]!);
  let left = Math.max(0, total);
  order.forEach((index, rank) => {
    const share = Math.min(sizes[index]!, Math.floor(left / (order.length - rank)));
    shares[index] = share;
    left -= share;
  });
  return shares;
}

function excerptSection(section: string, maxBytes: number): string {
  if (maxBytes < MIN_EXCERPT_BYTES) { return ''; }
  const hunk = section.indexOf('\n@@');
  const headerEnd = hunk === -1 ? section.length : hunk + 1;
  const end = fittingLinesEnd(section, maxBytes - MARKER_RESERVE);
  if (end < headerEnd) { return ''; }
  return section.slice(0, end) + `[... ${countLines(section, end)} more lines of this file omitted]\n`;
}

function takeLines(text: string, maxBytes: number, marker: (omittedLines: number) => string): string {
  if (byteLength(text) <= maxBytes) { return text; }
  if (maxBytes < MARKER_RESERVE) { return ''; }
  const end = fittingLinesEnd(text, maxBytes - MARKER_RESERVE);
  return text.slice(0, end) + marker(countLines(text, end));
}

/** End offset of the longest run of whole lines from the start that fits in `maxBytes`. */
function fittingLinesEnd(text: string, maxBytes: number): number {
  let end = 0;
  let size = 0;
  while (end < text.length) {
    const newline = text.indexOf('\n', end);
    const next = newline === -1 ? text.length : newline + 1;
    const lineBytes = byteLength(text.slice(end, next));
    if (size + lineBytes > maxBytes) { break; }
    size += lineBytes;
    end = next;
  }
  return end;
}

function countLines(text: string, from: number): number {
  let count = 0;
  for (let index = text.indexOf('\n', from); index !== -1; index = text.indexOf('\n', index + 1)) { count++; }
  return text.length > from && !text.endsWith('\n') ? count + 1 : count;
}
