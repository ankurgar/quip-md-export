// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));
/** Test-only module, loaded only when building with --e2e. It sends a write on purpose to prove the guard blocks it. */
const SHIPPED = files.filter((f) => f.path !== 'ui/e2eHooks.ts');

describe('static read-only checks on shipped source', () => {
  it('has HTTP transport only in the API client', () => {
    const withFetch = SHIPPED.filter((f) => /\bfetch\s*\(|\bfetch\)|=>\s*fetch\b/.test(f.text)).map((f) => f.path);
    expect(withFetch).toEqual(['core/quipClient.ts']);
    for (const f of SHIPPED) {
      expect(f.text, f.path).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|chrome\.webRequest|new FormData|<form/);
    }
  });

  it('declares no request method other than GET anywhere', () => {
    for (const f of SHIPPED) {
      const methods = [...f.text.matchAll(/\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/g)].map((m) => m[2]);
      expect(methods.every((m) => m === 'GET'), `${f.path}: ${methods.join(',')}`).toBe(true);
    }
  });

  it('never sends a request body from the API client', () => {
    const client = SHIPPED.find((f) => f.path === 'core/quipClient.ts');
    expect(client).toBeDefined();
    expect(client?.text).not.toMatch(/[{,]\s*body\s*:/);
  });

  it('never deletes files from the target folder', () => {
    for (const f of SHIPPED) expect(f.text, f.path).not.toMatch(/\.removeEntry\s*\(|\.unlink\s*\(|\brmSync\b|\brm\s*\(/);
  });

  it('keeps the test hooks out of every shipped module', () => {
    for (const f of SHIPPED) expect(f.text, f.path).not.toMatch(/tryMutation|__e2e/);
  });
});
