import {
  AuthError,
  DEFAULT_BASE_URL,
  QuipClient,
  QuipHttpError,
  createSession,
  parseQuipUrl,
  rootChoices,
  type CurrentUser,
  type ExportEvent,
  type ExportOptions,
  type ExportSummary,
  type Plan,
  type RootChoice,
} from '../core';
import { FsaSink } from './fsaSink';
import { installReadOnlyGuard } from './guard';
import { idbGet, idbSet } from './idb';

declare const __E2E__: boolean;

type Phase = 'loading' | 'idle' | 'connecting' | 'connected' | 'scanning' | 'scanned' | 'running' | 'done' | 'stopped' | 'error';
type Tone = 'info' | 'ok' | 'warn' | 'error';

interface PageTarget {
  kind: 'folder' | 'document';
  id: string;
  title: string;
}

interface Connection {
  token: string;
  user: CurrentUser;
  roots: Array<RootChoice & { title: string }>;
}

interface Settings {
  remember: boolean;
  includeComments: boolean;
  keepRaw: boolean;
  skipUnchanged: boolean;
  includeUnfiled: boolean;
  maxDocs: string;
  roots: string[] | null;
}

const DEFAULT_SETTINGS: Settings = { remember: false, includeComments: true, keepRaw: true, skipUnchanged: true, includeUnfiled: true, maxDocs: '', roots: null };
const KIND_LABEL: Record<RootChoice['kind'], string> = {
  private: 'Private',
  desktop: 'Desktop',
  shared: 'Shared folder',
  group: 'Group folder',
  archive: 'Archive',
  starred: 'Starred',
  trash: 'Trash',
};

const params = new URLSearchParams(location.search);
const E2E = __E2E__ && params.get('e2e') === '1';
const BASE_URL = E2E ? (params.get('base') ?? DEFAULT_BASE_URL) : DEFAULT_BASE_URL;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const ui = {
  token: byId<HTMLInputElement>('token'),
  remember: byId<HTMLInputElement>('remember'),
  connect: byId<HTMLButtonElement>('btn-connect'),
  connectStatus: byId('connect-status'),
  pick: byId<HTMLButtonElement>('btn-pick'),
  regrant: byId<HTMLButtonElement>('btn-regrant'),
  targetName: byId('target-name'),
  targetHint: byId('target-hint'),
  pageScope: byId('page-scope'),
  pageLabel: byId('page-label'),
  scopePage: byId<HTMLInputElement>('scope-page'),
  scopeAll: byId<HTMLInputElement>('scope-all'),
  roots: byId('roots'),
  comments: byId<HTMLInputElement>('opt-comments'),
  raw: byId<HTMLInputElement>('opt-raw'),
  skip: byId<HTMLInputElement>('opt-skip'),
  unfiled: byId<HTMLInputElement>('opt-unfiled'),
  max: byId<HTMLInputElement>('opt-max'),
  scan: byId<HTMLButtonElement>('btn-scan'),
  scanStatus: byId('scan-status'),
  scanSummary: byId('scan-summary'),
  run: byId<HTMLButtonElement>('btn-run'),
  stop: byId<HTMLButtonElement>('btn-stop'),
  progress: byId<HTMLProgressElement>('progress'),
  runStatus: byId('run-status'),
  log: byId('log'),
  guard: byId('guard-status'),
  version: byId('version'),
};

let phase: Phase = 'loading';
let conn: Connection | undefined;
let target: FileSystemDirectoryHandle | undefined;
let pendingHandle: FileSystemDirectoryHandle | undefined;
let pageTarget: PageTarget | undefined;
let fromUrl = params.get('from') ?? undefined;
let controller: AbortController | undefined;
let session: ReturnType<typeof createSession> | undefined;
let sessionKey = '';
let throttleUntil = 0;

// ---- small helpers -------------------------------------------------------

const isAbort = (err: unknown): boolean => (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError';

function setStatus(el: HTMLElement, text: string, tone: Tone = 'info'): void {
  el.textContent = text;
  el.dataset.tone = tone;
}

function log(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
  const li = document.createElement('li');
  li.dataset.tone = tone;
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  ui.log.append(li);
  while (ui.log.childElementCount > 400) ui.log.firstElementChild?.remove();
  li.scrollIntoView({ block: 'nearest' });
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Quip allows 50 requests a minute but only 750 an hour; the first 750 can go at full speed. */
function estimateMs(requests: number): number {
  const fast = Math.min(requests, 750);
  const slow = Math.max(0, requests - 750);
  return (fast / 45) * 60_000 + (slow / 750) * 3_600_000;
}

function describeError(err: unknown): string {
  if (err instanceof AuthError) return 'Quip rejected the access token. Create a new one at quip.com/dev/token and connect again.';
  if (err instanceof QuipHttpError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function setPhase(next: Phase): void {
  phase = next;
  document.body.dataset.state = next;
  refresh();
}

function refresh(): void {
  const busy = phase === 'loading' || phase === 'connecting' || phase === 'scanning' || phase === 'running';
  ui.connect.disabled = busy;
  ui.token.disabled = busy;
  ui.pick.disabled = busy;
  ui.regrant.disabled = busy;
  ui.scan.disabled = busy || !conn || !target;
  ui.run.disabled = busy || !conn || !target || !hasScope();
  ui.stop.disabled = phase !== 'scanning' && phase !== 'running';
  for (const el of [ui.comments, ui.raw, ui.skip, ui.unfiled, ui.max, ui.scopeAll, ui.scopePage]) el.disabled = busy;
  for (const box of ui.roots.querySelectorAll('input')) box.disabled = busy;
}

// ---- settings and token --------------------------------------------------

async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get('settings')) as { settings?: Partial<Settings> };
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

function currentSettings(): Settings {
  return {
    remember: ui.remember.checked,
    includeComments: ui.comments.checked,
    keepRaw: ui.raw.checked,
    skipUnchanged: ui.skip.checked,
    includeUnfiled: ui.unfiled.checked,
    maxDocs: ui.max.value.trim(),
    roots: selectedRoots(),
  };
}

async function saveSettings(): Promise<void> {
  await chrome.storage.local.set({ settings: currentSettings() });
}

async function loadToken(): Promise<string | undefined> {
  const session = (await chrome.storage.session.get('token')) as { token?: string };
  if (session.token) return session.token;
  const local = (await chrome.storage.local.get('token')) as { token?: string };
  return local.token;
}

async function saveToken(token: string, remember: boolean): Promise<void> {
  await chrome.storage.session.set({ token });
  if (remember) await chrome.storage.local.set({ token });
  else await chrome.storage.local.remove('token');
}

// ---- target folder -------------------------------------------------------

async function describeTarget(handle: FileSystemDirectoryHandle): Promise<void> {
  ui.targetName.textContent = handle.name;
  let entries = 0;
  for await (const _ of (handle as unknown as { values(): AsyncIterable<unknown> }).values()) {
    entries += 1;
    if (entries > 0) break;
  }
  ui.targetHint.textContent =
    entries > 0
      ? 'This folder already has files. The export only adds and updates files; it never deletes anything.'
      : "Quip's folder structure is recreated inside it. A new, empty folder or an Obsidian vault works well.";
}

async function useTarget(handle: FileSystemDirectoryHandle): Promise<void> {
  target = handle;
  pendingHandle = undefined;
  ui.regrant.hidden = true;
  await describeTarget(handle);
  refresh();
}

async function pickTarget(): Promise<void> {
  try {
    const handle = await window.showDirectoryPicker({ id: 'quip-md-export', mode: 'readwrite', startIn: 'documents' });
    await idbSet('target', handle);
    await useTarget(handle);
  } catch (err) {
    if (!isAbort(err)) setStatus(ui.connectStatus, `Could not open that folder: ${describeError(err)}`, 'error');
  }
}

async function restoreTarget(): Promise<void> {
  if (__E2E__ && E2E) {
    await useTarget(await (await import('./e2eHooks')).freshTestTarget());
    return;
  }
  const handle = await idbGet<FileSystemDirectoryHandle>('target').catch(() => undefined);
  if (!handle) return;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
    await useTarget(handle);
  } else {
    pendingHandle = handle;
    ui.targetName.textContent = `${handle.name} (permission needed)`;
    ui.regrant.hidden = false;
  }
}

async function regrantTarget(): Promise<void> {
  if (!pendingHandle) return;
  if ((await pendingHandle.requestPermission({ mode: 'readwrite' })) === 'granted') await useTarget(pendingHandle);
}

// ---- connection and scope ------------------------------------------------

function selectedRoots(): string[] {
  return [...ui.roots.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
}

function hasScope(): boolean {
  return ui.scopePage.checked && pageTarget !== undefined ? true : selectedRoots().length > 0;
}

function renderRoots(saved: string[] | null): void {
  ui.roots.replaceChildren();
  const legend = document.createElement('legend');
  legend.textContent = 'Folders';
  ui.roots.append(legend);
  for (const root of conn?.roots ?? []) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = root.id;
    input.checked = saved ? saved.includes(root.id) : root.defaultOn;
    input.addEventListener('change', refresh);
    const name = document.createElement('span');
    name.textContent = root.title;
    const kind = document.createElement('small');
    kind.textContent = KIND_LABEL[root.kind];
    label.append(input, name, kind);
    ui.roots.append(label);
  }
}

function renderPageScope(): void {
  ui.pageScope.hidden = !pageTarget;
  if (pageTarget) {
    ui.pageLabel.textContent = `${pageTarget.kind === 'folder' ? 'Folder' : 'Document'}: ${pageTarget.title || '(untitled)'}`;
    ui.scopePage.checked = true;
  } else {
    ui.scopeAll.checked = true;
  }
}

async function resolvePage(client: QuipClient, url: string): Promise<PageTarget | undefined> {
  const link = parseQuipUrl(url);
  if (!link) return undefined;
  const folder = await client.getFolder(link.id);
  if (folder.ok) return { kind: 'folder', id: folder.value.id, title: folder.value.title };
  const thread = await client.getThread(link.id);
  if (thread.ok && thread.value.type !== 'chat') return { kind: 'document', id: thread.value.id, title: thread.value.title };
  return undefined;
}

async function connect(): Promise<void> {
  const token = ui.token.value.trim();
  if (!token) {
    setStatus(ui.connectStatus, 'Paste your Quip access token first.', 'warn');
    return;
  }
  setPhase('connecting');
  setStatus(ui.connectStatus, 'Connecting…');
  try {
    const client = new QuipClient({ token, baseUrl: BASE_URL });
    const user = await client.currentUser();
    const choices = rootChoices(user);
    const folders = await client.getFolders(choices.map((c) => c.id));
    const roots = choices.map((c) => {
      const found = folders.get(c.id);
      return { ...c, title: (found?.ok && found.value.title) || KIND_LABEL[c.kind] };
    });
    conn = { token, user, roots };
    pageTarget = fromUrl ? await resolvePage(client, fromUrl).catch(() => undefined) : undefined;
    await saveToken(token, ui.remember.checked);
    const settings = await loadSettings();
    renderRoots(settings.roots);
    renderPageScope();
    const site = user.siteUrl ? ` (${new URL(user.siteUrl).host})` : '';
    setStatus(ui.connectStatus, `Connected as ${user.name || 'your account'}${site}.`, 'ok');
    setPhase('connected');
  } catch (err) {
    conn = undefined;
    setStatus(ui.connectStatus, describeError(err), 'error');
    setPhase('idle');
  }
}

// ---- scan and export -----------------------------------------------------

function buildOptions(): Partial<ExportOptions> {
  const max = Number.parseInt(ui.max.value, 10);
  const options: Partial<ExportOptions> = {
    includeComments: ui.comments.checked,
    keepRaw: ui.raw.checked,
    skipUnchanged: ui.skip.checked,
    includeUnfiled: ui.unfiled.checked,
    maxDocs: Number.isFinite(max) && max > 0 ? max : undefined,
    siteUrl: conn?.user.siteUrl,
  };
  if (ui.scopePage.checked && pageTarget) {
    options.includeUnfiled = false;
    if (pageTarget.kind === 'folder') options.rootIds = [pageTarget.id];
    else {
      options.rootIds = [];
      options.threadIds = [pageTarget.id];
    }
  } else {
    options.rootIds = selectedRoots();
  }
  return options;
}

function handleEvent(event: ExportEvent): void {
  switch (event.type) {
    case 'phase':
      setStatus(phase === 'scanning' ? ui.scanStatus : ui.runStatus, event.message);
      log(event.message);
      break;
    case 'doc':
      throttleUntil = 0;
      ui.progress.max = Math.max(1, event.total);
      ui.progress.value = event.index;
      setStatus(ui.runStatus, `${event.index} of ${event.total}: ${event.title}`);
      if (event.status === 'exported') log(`Saved ${event.path}`);
      if (event.status === 'failed') log(`Failed: ${event.title} (${event.message ?? 'unknown error'})`, 'error');
      break;
    case 'throttle':
      throttleUntil = Date.now() + event.waitMs;
      log(`Quip's rate limit was reached; waiting ${duration(event.waitMs)} before continuing.`, 'warn');
      break;
    case 'log':
      log(event.message, event.level);
      break;
  }
}

function makeSession(signal: AbortSignal): ReturnType<typeof createSession> {
  if (!conn || !target) throw new Error('Connect to Quip and choose a target folder first.');
  return createSession({
    token: conn.token,
    baseUrl: BASE_URL,
    sink: new FsaSink(target),
    parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
    options: buildOptions(),
    signal,
    onEvent: handleEvent,
    // Test builds skip the politeness delay because the mock server has no rate limit.
    ...(E2E ? { client: { minIntervalMs: 0 } } : {}),
  });
}

const scopeKey = (): string => JSON.stringify([buildOptions(), target?.name]);

function showPlan(plan: Plan): void {
  const perTop = new Map<string, number>();
  for (const t of plan.threads) {
    const top = t.path.includes('/') ? (t.path.split('/')[0] as string) : '(top level)';
    perTop.set(top, (perTop.get(top) ?? 0) + 1);
  }
  const lines = [`${plan.threads.length} documents in ${plan.folders.length} folders.`, ...[...perTop].map(([name, n]) => `  ${name}: ${n}`)];
  if (plan.unfiled > 0) lines.push(`${plan.unfiled} documents sit in no folder; they go under "_Unfiled".`);
  const unreadable = plan.unreadableFolders.length + plan.unreadableThreads.length;
  if (unreadable > 0) lines.push(`${unreadable} items could not be read with this token and will be listed in the report.`);
  lines.push('', `About ${plan.estimatedRequests} Quip API requests, roughly ${duration(estimateMs(plan.estimatedRequests))} at Quip's rate limits (50 a minute, 750 an hour).`);
  ui.scanSummary.textContent = lines.join('\n');
  ui.scanSummary.hidden = false;
}

async function scan(): Promise<void> {
  if (!conn || !target) return;
  controller = new AbortController();
  session = makeSession(controller.signal);
  sessionKey = scopeKey();
  await saveSettings();
  ui.scanSummary.hidden = true;
  setPhase('scanning');
  setStatus(ui.scanStatus, 'Scanning…');
  try {
    showPlan(await session.exporter.scan());
    setStatus(ui.scanStatus, 'Scan complete. Nothing has been written yet.', 'ok');
    setPhase('scanned');
  } catch (err) {
    session = undefined;
    setStatus(ui.scanStatus, isAbort(err) ? 'Scan stopped.' : describeError(err), isAbort(err) ? 'warn' : 'error');
    setPhase(isAbort(err) ? 'connected' : err instanceof AuthError ? 'idle' : 'error');
  }
}

async function acquireWakeLock(): Promise<() => Promise<void>> {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    return async () => {
      await lock?.release().catch(() => undefined);
    };
  } catch {
    return async () => undefined;
  }
}

function summarize(s: ExportSummary): string {
  const parts = [`${s.docs.exported} saved`, `${s.docs.skipped} unchanged`];
  if (s.docs.failed > 0) parts.push(`${s.docs.failed} failed`);
  return `${parts.join(', ')} of ${s.docs.planned} documents. The report is ${s.reportPath} in the target folder.`;
}

async function run(): Promise<void> {
  if (!conn || !target) return;
  if (!session || !controller || controller.signal.aborted || sessionKey !== scopeKey()) {
    controller = new AbortController();
    session = makeSession(controller.signal);
    sessionKey = scopeKey();
  }
  const active = session;
  await saveSettings();
  ui.log.replaceChildren();
  ui.progress.value = 0;
  setPhase('running');
  setStatus(ui.runStatus, 'Starting…');
  const release = await acquireWakeLock();
  try {
    const summary = await active.exporter.run();
    if (summary.aborted) {
      setStatus(ui.runStatus, `Stopped. ${summarize(summary)} Start again to continue where it left off.`, 'warn');
      setPhase('stopped');
    } else {
      ui.progress.value = ui.progress.max;
      setStatus(ui.runStatus, `Done. ${summarize(summary)}`, summary.docs.failed > 0 ? 'warn' : 'ok');
      setPhase('done');
    }
  } catch (err) {
    setStatus(ui.runStatus, isAbort(err) ? 'Stopped. Progress is saved.' : describeError(err), isAbort(err) ? 'warn' : 'error');
    log(describeError(err), 'error');
    setPhase(isAbort(err) ? 'stopped' : 'error');
  } finally {
    session = undefined;
    await release();
  }
}

// ---- start-up ------------------------------------------------------------

function applySettings(s: Settings): void {
  ui.remember.checked = s.remember;
  ui.comments.checked = s.includeComments;
  ui.raw.checked = s.keepRaw;
  ui.skip.checked = s.skipUnchanged;
  ui.unfiled.checked = s.includeUnfiled;
  ui.max.value = s.maxDocs;
}

async function init(): Promise<void> {
  ui.version.textContent = chrome.runtime.getManifest().version;
  const guard = await installReadOnlyGuard();
  ui.guard.textContent = guard.active ? 'Browser-level read-only guard: on' : `Browser-level read-only guard: unavailable (${guard.detail})`;
  ui.guard.dataset.tone = guard.active ? 'ok' : 'warn';

  applySettings(await loadSettings());
  await restoreTarget();
  if (__E2E__ && E2E) (await import('./e2eHooks')).installTestHooks(() => target);

  ui.connect.addEventListener('click', () => void connect());
  ui.token.addEventListener('keydown', (e) => e.key === 'Enter' && void connect());
  ui.pick.addEventListener('click', () => void pickTarget());
  ui.regrant.addEventListener('click', () => void regrantTarget());
  ui.scan.addEventListener('click', () => void scan());
  ui.run.addEventListener('click', () => void run());
  ui.stop.addEventListener('click', () => controller?.abort());
  for (const el of [ui.scopeAll, ui.scopePage]) el.addEventListener('change', refresh);
  window.addEventListener('beforeunload', (e) => {
    if (phase === 'running') e.preventDefault();
  });
  chrome.runtime.onMessage.addListener((msg: { type?: string; url?: string }) => {
    if (msg.type !== 'quip-source-url' || !msg.url) return;
    fromUrl = msg.url;
    if (conn) void connect();
  });
  window.setInterval(() => {
    const left = throttleUntil - Date.now();
    if (left > 0 && (phase === 'running' || phase === 'scanning')) {
      setStatus(phase === 'running' ? ui.runStatus : ui.scanStatus, `Waiting for Quip's rate limit: ${duration(left)} left.`, 'warn');
    }
  }, 1000);

  const stored = E2E ? (params.get('token') ?? undefined) : await loadToken();
  if (stored) ui.token.value = stored;
  setPhase('idle');
}

void init();
