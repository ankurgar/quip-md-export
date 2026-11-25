import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '../../src/core/session';
import { F_ARCH, F_DESK, F_PRIV, F_SHARED, PNG_1X1, SITE, T_PLAN, TOKEN } from '../mock/fixture';
import { startMockQuip, type MockQuip } from '../mock/quipMock';
import { NodeFsSink, parseHtml } from '../helpers/env';

const EXTENSION = resolve(__dirname, '../../dist-e2e');

let mock: MockQuip;
let context: BrowserContext;
let profile: string;
let extensionId: string;

beforeAll(async () => {
  mock = await startMockQuip();
  profile = await mkdtemp(join(tmpdir(), 'quip-e2e-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

afterAll(async () => {
  await context?.close();
  await mock?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function openExporter(extra: Record<string, string> = {}): Promise<Page> {
  const page = await context.newPage();
  const query = new URLSearchParams({ e2e: '1', base: mock.url, token: TOKEN, ...extra });
  await page.goto(`chrome-extension://${extensionId}/exporter.html?${query}`);
  await page.waitForSelector('body[data-state="idle"]');
  return page;
}

const state = (page: Page, value: string, timeout = 60_000) => page.waitForSelector(`body[data-state="${value}"]`, { timeout });

async function connect(page: Page): Promise<void> {
  await page.click('#btn-connect');
  await state(page, 'connected');
}

async function readTree(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => (window as unknown as { __e2e: { readTree(): Promise<Record<string, string>> } }).__e2e.readTree());
}

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const TEXT = /\.(md|json|html|txt)$/;

async function nodeTree(dir: string, rel = '', out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out[`${path}/`] = '';
      await nodeTree(dir, path, out);
    } else if (TEXT.test(entry.name)) out[path] = await readFile(join(dir, path), 'utf8');
    else out[path] = `<binary ${(await readFile(join(dir, path))).length} bytes>`;
  }
  return out;
}

const comparable = (tree: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tree)
      .filter(([path]) => !path.startsWith('.quip-md-export/'))
      .map(([path, text]) => [path, text.replace(TS, '<time>')]),
  );

describe('the extension in a real Chromium', () => {
  it('loads with a service worker and the production-safe manifest', async () => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    const page = await openExporter();
    expect(await page.title()).toBe('Quip to Markdown exporter');
    await expect(page.textContent('#guard-status')).resolves.toContain('read-only guard: on');
    await expect(page.textContent('#target-name')).resolves.toBe('e2e-target');
    await page.close();
  });

  it('exports the whole mock account through the UI and matches the Node pipeline byte for byte', async () => {
    const page = await openExporter();
    await connect(page);
    await expect(page.textContent('#connect-status')).resolves.toContain('Connected as Jane Doe (acme.quip.com)');
    const roots = await page.$$eval('#roots label', (labels) => labels.map((l) => ({ text: l.textContent ?? '', checked: (l.querySelector('input') as HTMLInputElement).checked })));
    expect(roots.map((r) => r.text)).toEqual(['PrivatePrivate', 'DesktopDesktop', 'Team SharedShared folder', 'ArchiveArchive', 'StarredStarred', 'TrashTrash']);
    expect(roots.map((r) => r.checked)).toEqual([true, true, true, true, false, false]);

    await page.click('#btn-scan');
    await state(page, 'scanned');
    await expect(page.textContent('#scan-summary')).resolves.toContain('9 documents in 5 folders');

    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved, 0 unchanged of 9 documents/);
    const tree = await readTree(page);

    // Same inputs through the Node + jsdom pipeline must give identical files.
    const dir = await mkdtemp(join(tmpdir(), 'quip-e2e-node-'));
    try {
      const { exporter } = createSession({
        token: TOKEN,
        baseUrl: mock.url,
        sink: new NodeFsSink(dir),
        parseHtml,
        options: { rootIds: [F_PRIV, F_DESK, F_SHARED, F_ARCH], siteUrl: SITE },
        client: { minIntervalMs: 0 },
      });
      await exporter.run();
      expect(comparable(tree)).toEqual(comparable(await nodeTree(dir)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(tree['Private/Projects/Project Plan.md']).toContain('**Calendar** (2021-10)');
    expect(tree['Private/Rental Records.md']).toContain('| Month | Rent | Paid |');
    expect(tree['_attachments/PLANthread1/BLOBok00001.png']).toBe(`<binary ${PNG_1X1.length} bytes>`);
    expect(tree['Desktop/']).toBe('');
    expect(Object.keys(tree)).toContain('.quip-md-export/state.json');
    await page.close();
  });

  it('only ever sent authenticated GET requests during the browser export', () => {
    expect(mock.requests.length).toBeGreaterThan(20);
    expect(mock.mutating()).toEqual([]);
    expect(mock.requests.filter((r) => r.path !== '/1/users/current' || r.auth !== '').every((r) => r.auth === `Bearer ${TOKEN}` || r.auth === '')).toBe(true);
  });

  it('resumes: a second run through the UI skips what is already saved', async () => {
    const page = await openExporter();
    await connect(page);
    await page.fill('#opt-max', '2');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/2 saved, 0 unchanged of 2 documents/);

    await page.fill('#opt-max', '');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 7 saved, 2 unchanged of 9 documents/);
    await page.close();
  });

  it('offers the Quip page the user came from as the export scope', async () => {
    const page = await openExporter({ from: `${SITE}/${T_PLAN}/Project-Plan` });
    await connect(page);
    await expect(page.isVisible('#page-scope')).resolves.toBe(true);
    await expect(page.textContent('#page-label')).resolves.toBe('Document: Project Plan');
    await expect(page.isChecked('#scope-page')).resolves.toBe(true);
    await page.click('#btn-run');
    await state(page, 'done');
    const tree = await readTree(page);
    expect(Object.keys(tree).filter((p) => p.endsWith('.md') && !p.startsWith('_'))).toEqual(['Project Plan.md']);
    expect(tree['Project Plan.md']).toContain('[Rental Records](https://acme.quip.com/tRENTALthr1v)');
    await page.close();
  });

  it('reports a rejected token without exporting anything', async () => {
    const page = await openExporter({ token: 'not-the-token' });
    await page.click('#btn-connect');
    await page.waitForFunction(() => document.getElementById('connect-status')?.getAttribute('data-tone') === 'error');
    await expect(page.textContent('#connect-status')).resolves.toContain('Quip rejected the access token');
    await expect(page.textContent('#btn-run')).resolves.toBe('Start export');
    expect(await page.isDisabled('#btn-run')).toBe(true);
    await page.close();
  });

  it('blocks writes to Quip at the browser level while reads still work', async () => {
    const page = await openExporter();
    const hooks = (url: string, kind: 'tryMutation' | 'tryRead') =>
      page.evaluate(([u, k]) => (window as unknown as { __e2e: Record<string, (x: string) => Promise<string>> }).__e2e[k as string]!(u as string), [url, kind]);

    const before = mock.requests.length;
    expect(await hooks(`${mock.url}/1/threads/edit-document`, 'tryMutation')).toMatch(/^blocked:/);
    expect(await hooks(`${mock.url}/1/folders/new`, 'tryMutation')).toMatch(/^blocked:/);
    // The blocked requests never reached the server...
    expect(mock.requests.length).toBe(before);
    // ...while a plain GET to the same host goes through (401: no token supplied by this probe).
    expect(await hooks(`${mock.url}/1/users/current`, 'tryRead')).toBe('reached:401');
    expect(mock.requests.length).toBe(before + 1);
    expect(mock.mutating()).toEqual([]);
    await page.close();
  });
});
