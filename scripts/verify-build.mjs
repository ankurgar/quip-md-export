import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const failures = [];
const fail = (message) => failures.push(message);

const manifest = JSON.parse(await readFile(`${dist}manifest.json`, 'utf8'));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://platform.quip.com/*'])) {
  fail(`host_permissions must be exactly platform.quip.com, got ${JSON.stringify(manifest.host_permissions)}`);
}
const allowedPermissions = ['storage', 'activeTab', 'declarativeNetRequestWithHostAccess'];
for (const p of manifest.permissions ?? []) if (!allowedPermissions.includes(p)) fail(`unexpected permission: ${p}`);
if (manifest.optional_host_permissions) fail('unexpected optional_host_permissions');
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
console.log('Build verification passed: minimal permissions, only Quip hosts, no test hooks, no eval.');
