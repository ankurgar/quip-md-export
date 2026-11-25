import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const e2e = process.argv.includes('--e2e');
const outdir = `${root}${e2e ? 'dist-e2e' : 'dist'}`;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: { exporter: `${root}src/ui/exporter.ts`, background: `${root}src/background.ts` },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  platform: 'browser',
  define: { __E2E__: JSON.stringify(e2e) },
  minify: !e2e,
  sourcemap: e2e ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'warning',
});

const manifest = JSON.parse(await readFile(`${root}extension/manifest.json`, 'utf8'));
if (e2e) {
  // Test builds may talk to a local mock server. The shipped build never gets this permission.
  // "localhost" gets a CSP entry but no host permission, to prove the write guard does not depend on one.
  manifest.host_permissions.push('http://127.0.0.1/*');
  manifest.name += ' (E2E build)';
  const csp = manifest.content_security_policy.extension_pages;
  const widened = csp.replace('connect-src https://platform.quip.com', 'connect-src https://platform.quip.com http://127.0.0.1:* http://localhost:*');
  if (widened === csp) throw new Error('could not widen connect-src for the E2E build');
  manifest.content_security_policy.extension_pages = widened;
}
await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ['exporter.html', 'exporter.css']) await copyFile(`${root}extension/${file}`, `${outdir}/${file}`);

console.log(`Built ${e2e ? 'E2E ' : ''}extension into ${outdir}`);
