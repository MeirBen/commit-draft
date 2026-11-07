import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';

const production = process.argv.includes('--production');
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
  external: ['vscode'], platform: 'node', format: 'cjs', target: 'node20', minify: production, sourcemap: !production });

if (process.argv.includes('--test')) {
  const sources = (await readdir('src'))
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts') && name !== 'extension.ts')
    .map(name => `src/${name}`);
  await build({ entryPoints: sources, outdir: 'dist/test', platform: 'node', format: 'cjs', target: 'node20' });
}
