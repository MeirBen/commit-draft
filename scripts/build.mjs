import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';

const production = process.argv.includes('--production');
const sources = (await readdir('src'))
  .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts') && name !== 'extension.ts')
  .map(name => `src/${name}`);

await rm('out', { recursive: true, force: true });
await rm('dist', { recursive: true, force: true });
await build({ entryPoints: sources, outdir: 'out', platform: 'node', format: 'cjs', target: 'node20' });
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
  external: ['vscode'], platform: 'node', format: 'cjs', target: 'node20', minify: production, sourcemap: !production });
