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
  saveXlsx: boolean;
  skipUnchanged: boolean;
  includeUnfiled: boolean;
  maxDocs: string;
  roots: string[] | null;
}

const DEFAULT_SETTINGS: Settings = { remember: false, includeComments: true, keepRaw: true, saveXlsx: true, skipUnchanged: true, includeUnfiled: true, maxDocs: '', roots: null };
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
  xlsx: byId<HTMLInputElement>('opt-xlsx'),
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
/** Bumped whenever the account or target folder changes, so a cached scan can never be reused for the wrong place. */
let epoch = 0;
/** Set by Stop, so a stop that arrives before an export has created its own controller is not lost. */
let stopRequested = false;
/** Only one of connect, scan and export may run at a time. */
let working = false;
let pendingFrom: string | undefined;
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

const TOKEN_REJECTED = 'Quip rejected the access token. Create a new one at quip.com/dev/token and connect again.';

function describeError(err: unknown): string {
  if (err instanceof AuthError) return TOKEN_REJECTED;
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
  ui.stop.disabled = phase !== 'connecting' && phase !== 'scanning' && phase !== 'running';
  for (const el of [ui.comments, ui.raw, ui.xlsx, ui.skip, ui.unfiled, ui.max, ui.scopeAll, ui.scopePage]) el.disabled = busy;
  for (const box of ui.roots.querySelectorAll('input')) box.disabled = busy;
}

// ---- settings and token --------------------------------------------------

async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get('settings')) as { settings?: Partial<Settings> };
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

function currentSettings(roots: string[] | null): Settings {
  return {
    remember: ui.remember.checked,
    includeComments: ui.comments.checked,
    keepRaw: ui.raw.checked,
    saveXlsx: ui.xlsx.checked,
    skipUnchanged: ui.skip.checked,
    includeUnfiled: ui.unfiled.checked,
    maxDocs: ui.max.value.trim(),
    roots,
  };
}

async function saveSettings(): Promise<void> {
  // Before connecting there are no folder checkboxes to read, so the selection saved earlier is kept.
  const roots = conn ? selectedRoots() : (await loadSettings()).roots;
  await chrome.storage.local.set({ settings: currentSettings(roots) });
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
      ? 'This folder already has files. The export adds files and updates only the ones it created earlier; it never deletes anything and never overwrites other files.'
      : "Quip's folder structure is recreated inside it. A new, empty folder or an Obsidian vault works well.";
}

async function useTarget(handle: FileSystemDirectoryHandle): Promise<void> {
  epoch += 1;
  session = undefined;
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
    await useTarget(await (await import('./e2eHooks')).freshTestTarget(params.get('target') ?? undefined, params.get('reuse') === '1'));
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
  // A selection saved for another account would leave nothing ticked, so it only counts if it matches something here.
  const known = new Set((conn?.roots ?? []).map((r) => r.id));
  const usable = saved?.some((id) => known.has(id)) ? saved : null;
  for (const root of conn?.roots ?? []) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = root.id;
    input.checked = usable ? usable.includes(root.id) : root.defaultOn;
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

interface PageLookup {
  target?: PageTarget;
  /** Why the page cannot be offered as the scope; shown to the user instead of silently falling back to all folders. */
  problem?: string;
}

async function lookUpPage(client: QuipClient, url: string): Promise<PageLookup> {
  const link = parseQuipUrl(url);
  if (!link) return { problem: 'The page you came from is not a Quip document or folder address, so choose the folders to export below.' };
  try {
    const folder = await client.getFolder(link.id);
    if (folder.ok) return { target: { kind: 'folder', id: folder.value.id, title: folder.value.title } };
    const thread = await client.getThread(link.id);
    if (thread.ok && thread.value.type !== 'chat') return { target: { kind: 'document', id: thread.value.id, title: thread.value.title } };
    const why = thread.ok ? 'it is a chat, which cannot be exported' : `this token cannot read it (HTTP ${thread.status || 'no response'})`;
    return { problem: `The page you came from cannot be offered: ${why}.` };
  } catch (err) {
    if (err instanceof AuthError || isAbort(err)) throw err;
    return { problem: `The page you came from could not be looked up: ${describeError(err)}` };
  }
}

const connectedText = (): string => {
  const user = conn?.user;
  const site = user?.siteUrl ? ` (${new URL(user.siteUrl).host})` : '';
  return `Connected as ${user?.name || 'your account'}${site}.`;
};

async function connect(): Promise<void> {
  await exclusive(async () => {
    const token = ui.token.value.trim();
    if (!token) {
      setStatus(ui.connectStatus, 'Paste your Quip access token first.', 'warn');
      return;
    }
    controller = new AbortController();
    setPhase('connecting');
    setStatus(ui.connectStatus, 'Connecting…');
    try {
      const client = new QuipClient({ token, baseUrl: BASE_URL, signal: controller.signal });
      const user = await client.currentUser();
      const choices = rootChoices(user);
      const folders = await client.getFolders(choices.map((c) => c.id));
      const roots = choices.map((c) => {
        const found = folders.get(c.id);
        return { ...c, title: (found?.ok && found.value.title) || KIND_LABEL[c.kind] };
      });
      conn = { token, user, roots };
      epoch += 1;
      session = undefined;
      const lookup = fromUrl ? await lookUpPage(client, fromUrl) : {};
      pageTarget = lookup.target;
      await saveToken(token, ui.remember.checked);
      const settings = await loadSettings();
      renderRoots(settings.roots);
      renderPageScope();
      setStatus(ui.connectStatus, lookup.problem ? `${connectedText()} ${lookup.problem}` : connectedText(), lookup.problem ? 'warn' : 'ok');
      setPhase('connected');
    } catch (err) {
      conn = undefined;
      setStatus(ui.connectStatus, isAbort(err) ? 'Connecting was cancelled.' : describeError(err), isAbort(err) ? 'warn' : 'error');
      setPhase('idle');
    }
  });
}

/** Points the "only what I was viewing" scope at a Quip page without reconnecting. Shows as busy, and can be stopped, while it looks the page up. */
async function selectPage(url: string): Promise<void> {
  fromUrl = url;
  if (!conn) return;
  const { token } = conn;
  controller = new AbortController();
  setPhase('connecting');
  setStatus(ui.connectStatus, 'Looking up the Quip page you selected…');
  try {
    const lookup = await lookUpPage(new QuipClient({ token, baseUrl: BASE_URL, signal: controller.signal }), url);
    pageTarget = lookup.target;
    renderPageScope();
    // The scope changed, so a scan shown for the old one no longer applies.
    ui.scanSummary.hidden = true;
    setStatus(ui.connectStatus, lookup.problem ? `${connectedText()} ${lookup.problem}` : connectedText(), lookup.problem ? 'warn' : 'ok');
    setPhase('connected');
  } catch (err) {
    if (err instanceof AuthError) {
      rejectToken();
      setPhase('idle');
      return;
    }
    setStatus(ui.connectStatus, `${connectedText()} ${isAbort(err) ? 'The page lookup was stopped.' : describeError(err)}`, 'warn');
    setPhase('connected');
  }
}

// ---- scan and export -----------------------------------------------------

function buildOptions(): Partial<ExportOptions> {
  const max = Number.parseInt(ui.max.value, 10);
  const options: Partial<ExportOptions> = {
    includeComments: ui.comments.checked,
    keepRaw: ui.raw.checked,
    saveXlsx: ui.xlsx.checked,
    skipUnchanged: ui.skip.checked,
    includeUnfiled: ui.unfiled.checked,
    maxDocs: Number.isFinite(max) && max > 0 ? max : undefined,
    siteUrl: conn?.user.siteUrl,
    ownerId: conn?.user.id,
    allRootIds: conn?.roots.filter((r) => r.kind !== 'starred').map((r) => r.id) ?? [],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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

const scopeKey = (): string => JSON.stringify([buildOptions(), epoch]);

/** A rejected token disconnects, so nothing else is attempted until a working one is entered. */
function rejectToken(): void {
  conn = undefined;
  session = undefined;
  setStatus(ui.connectStatus, TOKEN_REJECTED, 'error');
}

/** Runs one connect, scan, export or page lookup at a time; a Quip page picked meanwhile is applied afterwards. */
async function exclusive(task: () => Promise<void>): Promise<void> {
  if (working) return;
  working = true;
  try {
    await task();
  } finally {
    working = false;
    const url = pendingFrom;
    pendingFrom = undefined;
    if (url) void exclusive(() => selectPage(url));
  }
}

function showPlan(plan: Plan): void {
  const perTop = new Map<string, number>();
  for (const t of plan.threads) {
    const top = t.path.includes('/') ? (t.path.split('/')[0] as string) : '(top level)';
    perTop.set(top, (perTop.get(top) ?? 0) + 1);
  }
  const lines = [`${plan.threads.length} documents in ${plan.folders.length} folders.`, ...[...perTop].map(([name, n]) => `  ${name}: ${n}`)];
  if (plan.unfiled > 0) lines.push(`${plan.unfiled} documents you wrote sit in no folder; they go under "_Unfiled".`);
  if (plan.othersUnfiled > 0) lines.push(`${plan.othersUnfiled} documents written by other people are in none of your folders and are not exported.`);
  if (plan.relocated.length > 0) lines.push(`${plan.relocated.length} documents get a new file name or folder (moved or renamed in Quip, or the old file name is taken); the old copy stays.`);
  const unreadable = plan.unreadableFolders.length + plan.unreadableThreads.length;
  if (unreadable > 0) lines.push(`${unreadable} items could not be read with this token and will be listed in the report.`);
  // What is inside a folder that cannot be read is unknown, so the user decides before anything is written.
  const unknownFolders = plan.unreadableFolders.length + plan.unreadableUnselected.length;
  if (unknownFolders > 0 && ui.unfiled.checked) {
    lines.push(`${unknownFolders} folder${unknownFolders === 1 ? '' : 's'} could not be read, so documents you wrote inside ${unknownFolders === 1 ? 'it' : 'them'} may also be exported under "_Unfiled". Untick "Include documents you wrote that are in no folder" and scan again to leave them out.`);
  }
  lines.push('', `About ${plan.estimatedRequests} Quip API requests, roughly ${duration(estimateMs(plan.estimatedRequests))} at Quip's rate limits (50 a minute, 750 an hour).`);
  ui.scanSummary.textContent = lines.join('\n');
  ui.scanSummary.hidden = false;
}

async function scan(): Promise<void> {
  if (!conn || !target) return;
  await exclusive(async () => {
    try {
      controller = new AbortController();
      session = makeSession(controller.signal);
      sessionKey = scopeKey();
      await saveSettings();
      ui.scanSummary.hidden = true;
      setPhase('scanning');
      setStatus(ui.scanStatus, 'Scanning…');
      showPlan(await session.exporter.scan());
      setStatus(ui.scanStatus, 'Scan complete. Nothing has been written yet.', 'ok');
      setPhase('scanned');
    } catch (err) {
      session = undefined;
      if (err instanceof AuthError) rejectToken();
      setStatus(ui.scanStatus, isAbort(err) ? 'Scan stopped.' : describeError(err), isAbort(err) ? 'warn' : 'error');
      setPhase(isAbort(err) ? 'connected' : err instanceof AuthError ? 'idle' : 'error');
    }
  });
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
  if (s.docs.notAttempted > 0) parts.push(`${s.docs.notAttempted} not attempted`);
  return `${parts.join(', ')} of ${s.docs.planned} documents. The report is ${s.reportPath} in the target folder.`;
}

/** Held by the one exporter tab that is writing, so two tabs can never pick the same file name for different documents. */
const RUN_LOCK = 'quip-md-export-run';

/** Runs one export and says which phase to end in. The caller applies it last, once nothing is left to wait for. */
async function runExport(): Promise<Phase> {
  let release: () => Promise<void> = async () => undefined;
  try {
    // Another tab may have exported since this one scanned: its saved state and plan are then out of date.
    if (session && !(await session.exporter.isStateCurrent())) session = undefined;
    if (!session || !controller || controller.signal.aborted || sessionKey !== scopeKey()) {
      controller = new AbortController();
      session = makeSession(controller.signal);
      sessionKey = scopeKey();
    }
    if (stopRequested) {
      setStatus(ui.runStatus, 'Stopped before anything was written.', 'warn');
      return 'stopped';
    }
    const active = session;
    await saveSettings();
    release = await acquireWakeLock();
    const summary = await active.exporter.run();
    if (summary.aborted) {
      setStatus(ui.runStatus, `Stopped. ${summarize(summary)} Start again to continue where it left off.`, 'warn');
      return 'stopped';
    }
    ui.progress.value = ui.progress.max;
    setStatus(ui.runStatus, `Done. ${summarize(summary)}`, summary.docs.failed > 0 ? 'warn' : 'ok');
    return 'done';
  } catch (err) {
    if (err instanceof AuthError) rejectToken();
    const message = err instanceof AuthError ? `Stopped: ${TOKEN_REJECTED} Progress so far is saved, and the report lists what was not exported.` : describeError(err);
    setStatus(ui.runStatus, isAbort(err) ? 'Stopped. Progress is saved.' : message, isAbort(err) ? 'warn' : 'error');
    log(describeError(err), 'error');
    return isAbort(err) ? 'stopped' : err instanceof AuthError ? 'idle' : 'error';
  } finally {
    session = undefined;
    await release();
  }
}

async function run(): Promise<void> {
  if (!conn || !target) return;
  await exclusive(async () => {
    const before = phase;
    stopRequested = false;
    // At once, so the click is visibly taken and nothing else can start while the lock is being asked for.
    // The log is cleared here, not later, so a message that arrives meanwhile is not wiped out.
    ui.log.replaceChildren();
    ui.progress.value = 0;
    setPhase('running');
    setStatus(ui.runStatus, 'Starting…');
    let final: Phase = before;
    const started = await navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      final = await runExport();
      return true;
    });
    if (!started) setStatus(ui.runStatus, 'Another exporter tab is already exporting. Wait for it to finish or close it, then start again.', 'warn');
    // Last, with nothing asynchronous after it: the page never shows "done" while a click would still be ignored.
    setPhase(final);
  });
}

// ---- start-up ------------------------------------------------------------

function applySettings(s: Settings): void {
  ui.remember.checked = s.remember;
  ui.comments.checked = s.includeComments;
  ui.raw.checked = s.keepRaw;
  ui.xlsx.checked = s.saveXlsx;
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
  if (__E2E__ && E2E) (await import('./e2eHooks')).installTestHooks(() => target, useTarget);

  ui.connect.addEventListener('click', () => void connect());
  ui.token.addEventListener('keydown', (e) => e.key === 'Enter' && void connect());
  ui.pick.addEventListener('click', () => void pickTarget());
  ui.regrant.addEventListener('click', () => void regrantTarget());
  ui.scan.addEventListener('click', () => void scan());
  ui.run.addEventListener('click', () => void run());
  ui.stop.addEventListener('click', () => {
    stopRequested = true;
    controller?.abort();
  });
  for (const el of [ui.scopeAll, ui.scopePage]) el.addEventListener('change', refresh);
  ui.remember.addEventListener('change', () => {
    // Unticking must take effect now, not at the next connect.
    if (!ui.remember.checked) void chrome.storage.local.remove('token');
    else if (conn) void chrome.storage.local.set({ token: conn.token });
    void saveSettings();
  });
  window.addEventListener('beforeunload', (e) => {
    if (phase === 'running') e.preventDefault();
  });
  chrome.runtime.onMessage.addListener((msg: { type?: string; url?: string }) => {
    if (msg.type !== 'quip-source-url' || !msg.url) return;
    const url = msg.url;
    if (working) {
      pendingFrom = url;
      log('Another Quip page was selected. It will be offered when the current task finishes.', 'warn');
      return;
    }
    void exclusive(() => selectPage(url));
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
