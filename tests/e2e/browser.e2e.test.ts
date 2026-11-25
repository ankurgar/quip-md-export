import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '../../src/core/session';
import { F_ARCH, F_DESK, F_PRIV, F_SHARED, F_TRASH, ME, PNG_1X1, SITE, T_PLAN, T_RENTAL_SECRET, TOKEN, XLSX_BYTES } from '../mock/fixture';
import { probeHtml, startMockQuip, type MockQuip } from '../mock/quipMock';
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

// A failed assertion must not leave an exporter page running: it would keep the export lock and write into the next test's folder.
afterEach(async () => {
  for (const page of context.pages()) if (page.url().startsWith('chrome-extension://')) await page.close().catch(() => undefined);
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
        // Exactly what the page sends with its default settings.
        options: {
          rootIds: [F_PRIV, F_DESK, F_SHARED, F_ARCH],
          allRootIds: [F_PRIV, F_DESK, F_SHARED, F_ARCH, F_TRASH], // Starred is a view, so the page leaves it out
          ownerId: ME.id,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          siteUrl: SITE,
        },
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
    expect(tree['Private/Rental Records.xlsx']).toBe(`<binary ${XLSX_BYTES.length} bytes>`);
    expect(tree['Private/Rental Records.md']).toContain('Original spreadsheet with its formulas: [Rental Records.xlsx]');
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
    // A note whose links could not be resolved on the first run is rendered again now that their targets exist.
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 8 saved, 1 unchanged of 9 documents/);
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
    expect(tree['Project Plan.md']).toContain('[Rental Records](https://acme.quip.com/tRENTALthr1v/Rental-Records#temp:C:abc)');
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

  it('blocks every kind of write, even to an address the extension has no permission for, while reads still work', async () => {
    const page = await openExporter();
    const hook = (name: string, ...args: string[]) =>
      page.evaluate(([n, a]) => (window as unknown as { __e2e: Record<string, (...x: string[]) => Promise<string>> }).__e2e[n as string]!(...(a as string[])), [name, args] as const);

    const before = mock.requests.length;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await hook('tryMutation', `${mock.url}/1/threads/edit-document`, method), method).toMatch(/^blocked:/);
    }
    // The blocked requests never reached the server...
    expect(mock.requests.length).toBe(before);
    // ...while a plain GET to the same host goes through (401: no token supplied by this probe).
    expect(await hook('tryRead', `${mock.url}/1/users/current`)).toBe('reached:401');
    expect(mock.requests.length).toBe(before + 1);

    // The same server under a name the extension has no host permission for. Browser security makes the
    // answers unreadable, so the server's own log is the witness: the read arrives, the write never does.
    const elsewhere = mock.url.replace('127.0.0.1', 'localhost');
    await hook('tryRead', `${elsewhere}/guard/get`);
    await hook('tryMutation', `${elsewhere}/guard/post`);
    const seen = mock.requests.map((r) => `${r.method} ${r.path}`);
    expect(seen).toContain('GET /guard/get');
    expect(seen).not.toContain('POST /guard/post');
    expect(mock.mutating()).toEqual([]);
    await page.close();
  });

  it('never fetches the sub-resources that Quip HTML points at', async () => {
    const probe = await startMockQuip({ probe: true });
    const plain = await context.newPage();
    const page = await openExporter({ base: probe.url });
    try {
      // Parsing is inert in this browser...
      await plain.goto(`${probe.url}/control.html`);
      const markup = probeHtml(probe.url);
      await plain.evaluate((html) => void new DOMParser().parseFromString(html, 'text/html'), markup);
      await plain.waitForTimeout(500);
      expect(probe.probeHits()).toEqual([]);
      // ...whereas the same markup in a live page does make the browser fetch things, so the probe can detect a leak.
      await plain.evaluate((html) => {
        const box = document.createElement('div');
        box.innerHTML = html;
        document.body.append(box);
      }, markup);
      await expect.poll(() => probe.probeHits().length, { timeout: 10_000 }).toBeGreaterThan(0);
      // Let the control page finish loading everything it was asked to, so what comes later is attributable.
      let seen = -1;
      for (let i = 0; i < 20 && seen !== probe.probeHits().length; i += 1) {
        seen = probe.probeHits().length;
        await plain.waitForTimeout(400);
      }
      const control = probe.probeHits().length;

      // A whole export of documents full of such tags fetches none of them.
      await connect(page);
      await page.click('#btn-run');
      await state(page, 'done');
      await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved/);
      await page.waitForTimeout(500);
      expect(probe.probeHits().length).toBe(control);
      expect(probe.probeHits().filter((r) => r.referer.startsWith('chrome-extension://'))).toEqual([]); // nothing was requested on behalf of the extension page
      expect(probe.mutating()).toEqual([]);
      const tree = await readTree(page);
      const raw = Object.entries(tree).filter(([path]) => path.endsWith('/body.html'));
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.every(([, html]) => html.includes(`${probe.url}/probe/img.png`))).toBe(true); // the tags really were in what was fetched
    } finally {
      await Promise.all([plain.close(), page.close()]);
      await probe.close();
    }
  });

  it('keeps the token only while "Remember" is ticked, and forgets it the moment it is unticked', async () => {
    const page = await openExporter();
    const stored = () => page.evaluate(async () => ((await chrome.storage.local.get('token')) as { token?: string }).token ?? null);
    expect(await stored()).toBeNull();
    await page.check('#remember');
    await connect(page);
    expect(await stored()).toBe(TOKEN);
    await page.uncheck('#remember');
    await expect.poll(stored, { timeout: 5_000 }).toBeNull();
    await page.check('#remember');
    await expect.poll(stored, { timeout: 5_000 }).toBe(TOKEN);
    await page.uncheck('#remember');
    await expect.poll(stored, { timeout: 5_000 }).toBeNull();
    await page.close();
  });

  it('writes to the folder chosen last, even when the folder scanned earlier has the same name', async () => {
    const page = await openExporter();
    const hook = (name: string, arg: string) =>
      page.evaluate(([n, a]) => (window as unknown as { __e2e: Record<string, (x: string) => Promise<unknown>> }).__e2e[n as string]!(a as string), [name, arg] as const);
    await connect(page);
    await page.click('#btn-scan');
    await state(page, 'scanned');

    await hook('switchTarget', `elsewhere-${Date.now()}/e2e-target`);
    await page.click('#btn-run');
    await state(page, 'done');
    expect(Object.keys(await readTree(page))).toContain('Private/Rental Records.md');
    expect(await hook('readTreeAt', 'e2e-target')).toEqual({}); // the folder that was scanned stays untouched
    await page.close();
  });

  it('saves a spreadsheet\'s .xlsx only when asked, and re-exports the note when that choice changes', async () => {
    const page = await openExporter({ from: `${SITE}/${T_RENTAL_SECRET}/Rental-Records` });
    await connect(page);
    await page.uncheck('#opt-xlsx');
    await page.click('#btn-run');
    await state(page, 'done');
    let tree = await readTree(page);
    expect(Object.keys(tree).filter((p) => !p.startsWith('.') && !p.startsWith('_'))).toEqual(['Rental Records.md']);
    expect(tree['Rental Records.md']).not.toContain('.xlsx');

    await page.check('#opt-xlsx');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/1 saved, 0 unchanged/);
    tree = await readTree(page);
    expect(tree['Rental Records.xlsx']).toBe(`<binary ${XLSX_BYTES.length} bytes>`);
    expect(tree['Rental Records.md']).toContain('[Rental Records.xlsx](Rental%20Records.xlsx)');
    await page.close();
  });

  it('applies a Quip page picked mid-export only once the export has finished, without reconnecting', async () => {
    const slow = await startMockQuip({ delayMs: 60 });
    const page = await openExporter({ base: slow.url });
    try {
      await connect(page);
      await expect(page.isVisible('#page-scope')).resolves.toBe(false);
      await page.click('#btn-run');
      await state(page, 'running');
      const worker = context.serviceWorkers()[0] as NonNullable<ReturnType<BrowserContext['serviceWorkers']>[number]>;
      await worker.evaluate((url) => chrome.runtime.sendMessage({ type: 'quip-source-url', url }), `${SITE}/${T_PLAN}/Project-Plan`);
      await expect.poll(() => page.textContent('#log'), { timeout: 10_000 }).toContain('Another Quip page was selected');
      expect(await page.getAttribute('body', 'data-state')).toBe('running');

      // The export finishes undisturbed; only then is the selected page looked up (the page is busy meanwhile), and the scope follows it.
      await state(page, 'connected', 120_000);
      await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved/);
      await expect(page.textContent('#page-label')).resolves.toBe('Document: Project Plan');
      await expect(page.isChecked('#scope-page')).resolves.toBe(true);
      await expect(page.textContent('#connect-status')).resolves.toContain('Connected as Jane Doe');
      expect(await page.isDisabled('#btn-run')).toBe(false);
    } finally {
      await page.close();
      await slow.close();
    }
  });

  it('stops and disconnects when Quip rejects the token part-way through an export', async () => {
    let htmlRequests = 0;
    const flaky = await startMockQuip({ override: (req) => (req.path.endsWith('/html') && ++htmlRequests > 2 ? { status: 401 } : undefined) });
    const page = await openExporter({ base: flaky.url });
    try {
      await connect(page);
      await page.click('#btn-run');
      await state(page, 'idle');
      const status = (await page.textContent('#run-status')) ?? '';
      expect(status).toContain('Stopped: Quip rejected the access token');
      expect(status).not.toContain('Done.');
      expect(await page.isDisabled('#btn-run')).toBe(true);
      await expect(page.getAttribute('#connect-status', 'data-tone')).resolves.toBe('error');
      const report = (await readTree(page))['_Quip export report.md'] ?? '';
      expect(report).toContain('Stopped: Quip rejected the access token');
      expect(report).toMatch(/\d+ not attempted/);
    } finally {
      await page.close();
      await flaky.close();
    }
  });

  it('lets only one exporter tab write at a time', async () => {
    const slow = await startMockQuip({ delayMs: 60 });
    const first = await openExporter({ base: slow.url, target: 'e2e-lock-a' });
    const second = await openExporter({ base: slow.url, target: 'e2e-lock-b' });
    try {
      await connect(first);
      await connect(second);
      await first.click('#btn-run');
      await state(first, 'running');

      await second.click('#btn-run');
      await expect.poll(() => second.textContent('#run-status'), { timeout: 10_000 }).toContain('Another exporter tab is already exporting');
      expect(await second.getAttribute('body', 'data-state')).toBe('connected'); // still usable, just not running
      expect(await second.isDisabled('#btn-run')).toBe(false);
      expect(Object.keys(await readTree(second)).filter((p) => p.endsWith('.md'))).toEqual([]);

      await state(first, 'done', 120_000);
      await second.click('#btn-run'); // the lock is free again
      await state(second, 'done', 120_000);
      await expect(second.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved/);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await slow.close();
    }
  });

  it('says why the page you came from cannot be offered, instead of silently showing all folders', async () => {
    const unknown = await openExporter({ from: 'https://acme.quip.com/AbCdEfGhIjKl/Nothing-Here' });
    await connect(unknown);
    await expect(unknown.textContent('#connect-status')).resolves.toContain('The page you came from cannot be offered: this token cannot read it (HTTP 404)');
    expect(await unknown.getAttribute('#connect-status', 'data-tone')).toBe('warn');
    await expect(unknown.isVisible('#page-scope')).resolves.toBe(false);
    await expect(unknown.isChecked('#scope-all')).resolves.toBe(true);
    await unknown.close();

    const notQuip = await openExporter({ from: 'https://example.com/some/page' });
    await connect(notQuip);
    await expect(notQuip.textContent('#connect-status')).resolves.toContain('not a Quip document or folder address');
    await notQuip.close();
  });

  it('can be stopped while connecting', async () => {
    const slow = await startMockQuip({ delayMs: 400 });
    const page = await openExporter({ base: slow.url });
    try {
      await page.click('#btn-connect');
      await state(page, 'connecting');
      await page.click('#btn-stop');
      await state(page, 'idle');
      await expect(page.textContent('#connect-status')).resolves.toContain('Connecting was cancelled');
    } finally {
      await page.close();
      await slow.close();
    }
  });
});
