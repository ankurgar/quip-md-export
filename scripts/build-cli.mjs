import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// The command line tool is a development and fallback aid, not part of the extension: it lives in dist-cli/
// (git-ignored) and uses jsdom from node_modules instead of the browser's DOMParser.
await build({
  entryPoints: [`${root}src/node/bin.ts`],
  outfile: `${root}dist-cli/cli.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['jsdom'],
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('Built dist-cli/cli.mjs');
