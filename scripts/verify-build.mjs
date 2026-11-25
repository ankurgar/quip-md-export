import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const failures = [];
const fail = (message) => failures.push(message);

const manifest = JSON.parse(await readFile(`${dist}manifest.json`, 'utf8'));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://platform.quip.com/*'])) {
  fail(`host_permissions must be exactly platform.quip.com, got ${JSON.stringify(manifest.host_permissions)}`);
}
const allowedPermissions = ['storage', 'activeTab', 'declarativeNetRequest'];
for (const p of manifest.permissions ?? []) if (!allowedPermissions.includes(p)) fail(`unexpected permission: ${p}`);
if (manifest.optional_host_permissions) fail('unexpected optional_host_permissions');

// The extension pages run under a strict policy: no inline code, no framing, and the network limited to Quip.
const csp = Object.fromEntries(
  String(manifest.content_security_policy?.extension_pages ?? '')
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .filter((d) => d[0])
    .map(([name, ...sources]) => [name, sources.join(' ')]),
);
const expectedCsp = {
  'default-src': "'self'",
  'script-src': "'self'",
  'object-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self' data:",
  'connect-src': 'https://platform.quip.com',
  'frame-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
};
for (const [name, value] of Object.entries(expectedCsp)) if (csp[name] !== value) fail(`CSP ${name} must be "${value}", got "${csp[name]}"`);
for (const name of Object.keys(csp)) if (!(name in expectedCsp)) fail(`unexpected CSP directive ${name}`);
if (JSON.stringify(csp).includes('unsafe-')) fail('the CSP must not allow unsafe-inline or unsafe-eval');
if (manifest.content_scripts) fail('this extension must not inject content scripts into pages');
if (manifest.externally_connectable || manifest.web_accessible_resources) fail('the extension must not be reachable from web pages');

for (const file of ['exporter.js', 'background.js']) {
  const code = await readFile(`${dist}${file}`, 'utf8');
  for (const token of ['tryMutation', '__e2e', 'e2e-target', 'freshTestTarget']) if (code.includes(token)) fail(`${file} contains test-only token "${token}"`);
  if (/\beval\s*\(|new Function\s*\(/.test(code)) fail(`${file} uses eval or new Function`);
  const hosts = new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const host of hosts) if (!/(^|\.)quip\.com$/.test(host)) fail(`${file} references unexpected host ${host}`);
}

if (failures.length > 0) {
  console.error(`Build verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Build verification passed: minimal permissions, strict CSP, only Quip hosts, no test hooks, no eval.');
