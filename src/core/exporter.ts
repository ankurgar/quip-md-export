import { htmlToMarkdown, type HtmlParser } from './convert';
import { digest, digestText } from './digest';
import { frontMatter, frontMatterHasId, relativeLink, usecToIso } from './links';
import { escapeBlockStart, escapeInline } from './markdownUtils';
import { PathAllocator } from './naming';
import { AuthError, QuipHttpError } from './quipClient';
import type { OwnedThread, QuipApi, QuipMessage } from './quipTypes';
import { attachmentExtension, rewriteSentinels, stripExtension } from './rewrite';
import type { Sink } from './sink';
import type { BlobRef, FolderMeta, ThreadMeta, Warning } from './types';

export const TOOL_NAME = 'quip-md-export';
export const TOOL_VERSION = '0.1.0';
/** Bump whenever the converter or note format changes, so existing notes are re-rendered on the next run. */
export const FORMAT_VERSION = 5;
export const STATE_PATH = '.quip-md-export/state.json';
export const REPORT_JSON_PATH = '.quip-md-export/report.json';
export const REPORT_MD_PATH = '_Quip export report.md';
const RAW_DIR = '.quip-raw';
const FALLBACK_SITE = 'https://quip.com';
const QUIP_URL = /https?:\/\/(?:[\w-]+\.)*quip\.com\/([A-Za-z0-9]{11,12})(?:[/?#][^\s<>)]*)?/g;
const MAX_STORED_WARNINGS = 20;

export interface ExportOptions {
  /** Folders to walk recursively, in priority order: a document in several folders is written under the first root that contains it. */
  rootIds: string[];
  /** Individual documents to export even if no walked folder lists them. */
  threadIds: string[];
  /** Also export documents you wrote that sit in no folder anywhere in the account, under `unfiledDir`. Needs `ownerId`. */
  includeUnfiled: boolean;
  /**
   * Every top-level folder of the account that holds documents, selected or not, except Starred (a view of
   * documents that live elsewhere). Only used to tell which documents are truly in no folder.
   */
  allRootIds: string[];
  /** The signed-in user: only unfiled documents authored by this user are exported. */
  ownerId: string | undefined;
  includeComments: boolean;
  /** Keep Quip's original HTML and metadata under `.quip-raw/`. */
  keepRaw: boolean;
  /** Save Quip's XLSX export next to notes that contain spreadsheets (it keeps formulas, which HTML does not). */
  saveXlsx: boolean;
  /** Skip documents whose `updated_usec`, options and link targets match the previous export. */
  skipUnchanged: boolean;
  maxDocs: number | undefined;
  siteUrl: string | undefined;
  /** IANA time zone used to read date-only values in trackers. */
  timeZone: string | undefined;
  attachmentsDir: string;
  unfiledDir: string;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  rootIds: [],
  threadIds: [],
  includeUnfiled: true,
  allRootIds: [],
  ownerId: undefined,
  includeComments: true,
  keepRaw: true,
  saveXlsx: true,
  skipUnchanged: true,
  maxDocs: undefined,
  siteUrl: undefined,
  timeZone: undefined,
  attachmentsDir: '_attachments',
  unfiledDir: '_Unfiled',
};

export type ExportEvent =
  | { type: 'phase'; phase: 'scan' | 'export' | 'finish'; message: string }
  | { type: 'doc'; index: number; total: number; id: string; title: string; path: string; status: 'exported' | 'skipped' | 'failed'; message?: string }
  | { type: 'throttle'; waitMs: number; reason: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export interface ExportDeps {
  client: QuipApi;
  sink: Sink;
  parseHtml: HtmlParser;
  onEvent?: (event: ExportEvent) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface PlannedFolder {
  id: string;
  title: string;
  path: string;
  /** Documents whose canonical location is this folder. */
  docCount: number;
}

export interface PlannedThread {
  meta: ThreadMeta;
  raw: unknown;
  folderPath: string;
  alsoIn: string[];
  path: string;
  pdfPath?: string;
}

export interface Relocation {
  id: string;
  title: string;
  from: string;
  to: string;
}

export interface Plan {
  folders: PlannedFolder[];
  threads: PlannedThread[];
  unreadableFolders: Array<{ id: string; status: number }>;
  unreadableThreads: Array<{ id: string; status: number; folderPath: string }>;
  skippedChats: number;
  /** Documents you wrote that sit in no folder (exported under the unfiled directory). */
  unfiled: number;
  /** Accessible documents written by other people that sit in none of your folders (not exported). */
  othersUnfiled: number;
  /** Folders outside the selection that could not be read. Their documents can show up as unfiled. */
  unreadableUnselected: Array<{ id: string; status: number }>;
  /** Documents whose folder or title changed in Quip since the last export; the old copy is left in place. */
  relocated: Relocation[];
  estimatedRequests: number;
}

export interface Failure {
  id: string;
  title: string;
  stage: string;
  message: string;
}

export interface WarningGroup {
  count: number;
  examples: string[];
}

export type StopReason = 'completed' | 'aborted' | 'auth-error';

export interface ExportSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason: StopReason;
  aborted: boolean;
  docs: { planned: number; exported: number; skipped: number; failed: number; notAttempted: number; slides: number };
  folders: number;
  attachments: { saved: number; reused: number; missing: number };
  comments: number;
  embeds: Record<string, number>;
  warnings: Record<string, WarningGroup>;
  failures: Failure[];
  unresolvedLinks: string[];
  unreadableFolders: Plan['unreadableFolders'];
  /** Folders outside the selection that could not be read; documents inside them can show up as unfiled. */
  unreadableUnselected: Plan['unreadableUnselected'];
  unreadableThreads: Plan['unreadableThreads'];
  skippedChats: number;
  othersUnfiled: number;
  relocated: Relocation[];
  rateLimitPauses: number;
  reportPath: string;
}

interface ThreadState {
  updatedUsec?: number;
  fingerprint: string;
  exportedAt: string;
  path: string;
  /** Documents this note links to and where they were when it was rendered. */
  links?: Record<string, string>;
  /** Links that pointed outside the export when the note was rendered. */
  unresolved?: string[];
  warnings?: Warning[];
  embeds?: Record<string, number>;
  /** The note, or something it links to, still needs work: do not skip this document next time. */
  retry?: boolean;
  /** Attachments and sidecars the note links to; the note is only up to date while all of them still exist. */
  files?: string[];
  /** The raw archive files written for this document; they must still exist for the document to be skipped while the archive is on. */
  rawFiles?: string[];
  /** The time zone dates were read in, kept only for documents whose content depends on it. */
  timeZone?: string;
}

interface ExportState {
  version: 2;
  paths: Record<string, string>;
  /** The names `paths` were allocated for, so a title such as "Report (2)" is not mistaken for a collision suffix. */
  names?: Record<string, string>;
  /** What each note, .xlsx and PDF looked like when this tool wrote it, so one that was edited or replaced since is left alone. */
  digests?: Record<string, string>;
  threads: Record<string, ThreadState>;
}

interface DocResult {
  status: 'exported' | 'skipped';
  slides: boolean;
}

/** Collects what a note links to while it is rendered. */
interface LinkLog {
  links: Record<string, string>;
  unresolved: Set<string>;
}

/** What one document's export learned along the way. */
interface Flags {
  /** Something failed for a reason that may pass: do not skip this document next run. */
  retry: boolean;
  /** Attachments and sidecars the note links to. */
  files: Set<string>;
}

const isAbortError = (err: unknown): boolean => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/**
 * A failure worth asking again about: network trouble, 5xx or 429. A 403 or 404 is reported and not retried on
 * every run (that would re-fetch the same documents forever); unticking "Skip unchanged" tries them again.
 */
const isRetryable = (err: unknown): boolean => !(err instanceof QuipHttpError) || err.status === 0 || err.status >= 500 || err.status === 429;
const hasZipSignature = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
/** A small JSON object with the fields Quip uses for an error report. */
function looksLikeApiError(contentType: string, bytes: Uint8Array): boolean {
  if (!/json/i.test(contentType) || bytes.length >= 4096) return false;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof body === 'object' && body !== null && 'error' in body && ('error_code' in body || 'error_description' in body);
  } catch {
    return false;
  }
}
/** The PDF specification lets "%PDF" sit anywhere in the first 1024 bytes. */
const hasPdfSignature = (b: Uint8Array): boolean => {
  const end = Math.min(b.length, 1024) - 3;
  for (let i = 0; i < end; i += 1) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true;
  return false;
};
/** First line and tool line of the report, which is how a report written by this tool is recognised. */
const isOwnReport = (text: string): boolean => text.startsWith('# Quip export report\n') && text.slice(0, 600).includes(`- Tool: ${TOOL_NAME} `);

export class Exporter {
  private readonly opts: ExportOptions;
  private readonly alloc = new PathAllocator();
  private state: ExportState = { version: 2, paths: {}, threads: {}, digests: {} };
  private stateLoaded = false;
  /** The saved state exactly as it was read, to notice when another run has changed it since. */
  private loadedStateText: string | undefined;
  private plan: Plan | undefined;
  private docIndex = new Map<string, PlannedThread>();
  private readonly users = new Map<string, string>();
  /** Ids already checked and found not to be people. */
  private readonly notUsers = new Set<string>();
  private readonly blobPaths = new Map<string, string | null>();
  /** Why a blob could not be fetched, so every note that uses it reports the same failure. */
  private readonly blobFailures = new Map<string, { detail: string; retry: boolean }>();
  private readonly warningGroups = new Map<string, WarningGroup>();
  private readonly embedTotals: Record<string, number> = {};
  private readonly failures: Failure[] = [];
  private readonly unresolved = new Set<string>();
  private attachments = { saved: 0, reused: 0, missing: 0 };
  private commentCount = 0;
  private pauses = 0;
  private attachmentsRoot = '';
  private unfiledRoot = '';

  constructor(
    private readonly deps: ExportDeps,
    options: Partial<ExportOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Called by the session wiring when the API client waits out a rate limit. */
  recordThrottle(waitMs: number, reason: string): void {
    this.pauses += 1;
    this.emit({ type: 'throttle', waitMs, reason });
  }

  private emit(event: ExportEvent): void {
    this.deps.onEvent?.(event);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', level, message });
  }

  private checkAbort(): void {
    this.deps.signal?.throwIfAborted();
  }

  private get siteUrl(): string {
    return (this.opts.siteUrl ?? FALLBACK_SITE).replace(/\/+$/, '');
  }

  private fingerprint(): string {
    const o = this.opts;
    return `v${FORMAT_VERSION}c${o.includeComments ? 1 : 0}x${o.saveXlsx ? 1 : 0}`;
  }

  // ---- state and naming ------------------------------------------------

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    const text = await this.deps.sink.readText(STATE_PATH);
    this.loadedStateText = text;
    if (text) {
      try {
        const parsed = JSON.parse(text) as Partial<ExportState>;
        if (parsed.version === 2 && parsed.paths && parsed.threads) {
          this.state = { version: 2, paths: parsed.paths, threads: parsed.threads, digests: parsed.digests ?? {} };
          for (const [key, path] of Object.entries(parsed.paths)) this.alloc.restore(key, path, parsed.names?.[key]);
        } else this.log('warn', 'Ignoring export state from another version; every document will be checked again.');
      } catch {
        this.log('warn', 'Ignoring unreadable export state; every document will be exported again.');
      }
    }
    // Names this tool writes itself must never be handed to a Quip folder or document.
    this.alloc.reserve(REPORT_MD_PATH);
    this.attachmentsRoot = this.alloc.allocate('dir:attachments', '', this.opts.attachmentsDir);
    this.unfiledRoot = this.alloc.allocate('dir:unfiled', '', this.opts.unfiledDir);
  }

  private async saveState(): Promise<void> {
    await this.deps.sink.writeFile(STATE_PATH, JSON.stringify({ ...this.state, paths: this.alloc.snapshot(), names: this.alloc.names() }, null, 1));
  }

  /**
   * Whether a note is this document's own, judged by the front matter at the top of the file. Used when planning,
   * where a note the user has edited must stay mapped to its name.
   */
  private ownsNote(id: string): (path: string) => Promise<boolean> {
    return async (path) => {
      const head = await this.deps.sink.readHead(path, 4000);
      return head === undefined || frontMatterHasId(head, id);
    };
  }

  /**
   * Whether this tool may write a note at `path`: nothing is there, or the file is exactly what the tool wrote
   * (an edited one is the user's now), or, with no record of what it wrote, it carries this document's front matter.
   */
  private mayReplaceNote(id: string): (path: string) => Promise<boolean> {
    return async (path) => {
      const recorded = this.state.digests?.[path];
      if (recorded === undefined) return this.ownsNote(id)(path);
      const bytes = await this.deps.sink.readBytes(path);
      return bytes === undefined || digest(bytes) === recorded;
    };
  }

  /** A saved .xlsx or PDF may be replaced only while it is exactly what this tool wrote. */
  private readonly mayReplaceBinary = async (path: string): Promise<boolean> => {
    const bytes = await this.deps.sink.readBytes(path);
    return bytes === undefined || this.state.digests?.[path] === digest(bytes);
  };

  private async writeRecorded(path: string, data: string | Uint8Array): Promise<void> {
    await this.deps.sink.writeFile(path, data);
    (this.state.digests ??= {})[path] = typeof data === 'string' ? digestText(data) : digest(data);
  }

  /** False when another run has changed the saved state since this exporter read it: its scan is out of date. */
  async isStateCurrent(): Promise<boolean> {
    await this.loadState();
    return (await this.deps.sink.readText(STATE_PATH)) === this.loadedStateText;
  }

  private readonly isMissing = async (path: string): Promise<boolean> => !(await this.deps.sink.exists(path));

  // ---- discovery -------------------------------------------------------

  /** Walks a folder subtree level by level (one bulk request per level). */
  private async walk(
    startId: string,
    visited: Set<string>,
    visit: (folder: FolderMeta, parentPath: string) => string,
    unreadable: (id: string, status: number) => void,
  ): Promise<void> {
    let level = [{ id: startId, parentPath: '' }];
    for (let depth = 0; level.length > 0 && depth < 100; depth += 1) {
      const todo: typeof level = [];
      for (const node of level) {
        if (!visited.has(node.id)) {
          visited.add(node.id);
          todo.push(node);
        }
      }
      if (todo.length === 0) break;
      const results = await this.deps.client.getFolders(todo.map((n) => n.id));
      const next: typeof level = [];
      for (const node of todo) {
        this.checkAbort();
        const result = results.get(node.id);
        if (!result || !result.ok) {
          unreadable(node.id, result && !result.ok ? result.status : 0);
          continue;
        }
        visited.add(result.value.id);
        const path = visit(result.value, node.parentPath);
        for (const childId of result.value.childFolderIds) next.push({ id: childId, parentPath: path });
      }
      level = next;
    }
  }

  /** Reads the folder tree and document metadata without downloading any content. */
  async scan(): Promise<Plan> {
    if (this.plan) return this.plan;
    await this.loadState();
    const client = this.deps.client;
    this.emit({ type: 'phase', phase: 'scan', message: 'Reading the folder structure…' });

    const locations = new Map<string, string[]>();
    const order: string[] = [];
    const see = (id: string, folderPath: string): void => {
      const known = locations.get(id);
      if (!known) {
        locations.set(id, [folderPath]);
        order.push(id);
      } else if (!known.includes(folderPath)) known.push(folderPath);
    };

    const folders: PlannedFolder[] = [];
    const unreadableFolders: Plan['unreadableFolders'] = [];
    const visited = new Set<string>();
    // One root at a time, in the order given, so the first root claims a document that several roots contain.
    for (const rootId of this.opts.rootIds) {
      await this.walk(
        rootId,
        visited,
        (folder, parentPath) => {
          const path = this.alloc.allocate(`folder:${folder.id}`, parentPath, folder.title || 'Untitled folder');
          folders.push({ id: folder.id, title: folder.title, path, docCount: 0 });
          for (const threadId of folder.threadIds) see(threadId, path);
          return path;
        },
        (id, status) => unreadableFolders.push({ id, status }),
      );
      this.log('info', `Scanned ${folders.length} folders, ${order.length} documents so far…`);
    }

    for (const id of this.opts.threadIds) if (!locations.has(id)) see(id, '');

    // Documents in no folder anywhere. `/1/users/current/threads` lists every thread the user can
    // access (including other people's), so a document only counts as unfiled if it is in none of the
    // account's folders, selected or not, and the user wrote it.
    const candidates: OwnedThread[] = [];
    const unreadableUnselected: Plan['unreadableUnselected'] = [];
    if (this.opts.includeUnfiled) {
      if (!this.opts.ownerId) {
        this.log('warn', 'Unfiled documents were skipped because the signed-in user is not known.');
      } else {
        this.log('info', 'Looking for documents that are in no folder…');
        const known = new Set(locations.keys());
        for (const rootId of this.opts.allRootIds) {
          if (visited.has(rootId)) continue;
          await this.walk(
            rootId,
            visited,
            (folder) => {
              for (const id of folder.threadIds) known.add(id);
              return '';
            },
            (id, status) => unreadableUnselected.push({ id, status }),
          );
        }
        for (const owned of await client.listOwnedThreads()) {
          if (!owned.isDeleted && owned.type !== 'chat' && !known.has(owned.id)) candidates.push(owned);
        }
      }
    }

    this.checkAbort();
    this.log('info', `Reading metadata for ${order.length + candidates.length} documents…`);
    const metas = await client.getThreads([...order, ...candidates.map((c) => c.id)]);

    const threads: PlannedThread[] = [];
    const unreadableThreads: Plan['unreadableThreads'] = [];
    let unfiled = 0;
    let othersUnfiled = 0;
    for (const candidate of candidates) {
      const result = metas.get(candidate.id);
      if (!result || !result.ok) {
        unreadableThreads.push({ id: candidate.id, status: result && !result.ok ? result.status : 0, folderPath: this.unfiledRoot });
        continue;
      }
      if (result.value.authorId === this.opts.ownerId) {
        see(candidate.id, this.unfiledRoot);
        unfiled += 1;
      } else othersUnfiled += 1;
    }

    let skippedChats = 0;
    for (const id of order) {
      const where = locations.get(id) ?? [''];
      const result = metas.get(id);
      if (!result || !result.ok) {
        unreadableThreads.push({ id, status: result && !result.ok ? result.status : 0, folderPath: where[0] ?? '' });
        continue;
      }
      if (result.value.type === 'chat') {
        skippedChats += 1;
        continue;
      }
      threads.push({ meta: result.value, raw: result.raw, folderPath: where[0] ?? '', alsoIn: where.slice(1), path: '' });
    }
    const limited = this.opts.maxDocs !== undefined ? threads.slice(0, Math.max(0, this.opts.maxDocs)) : threads;

    const folderByPath = new Map(folders.map((f) => [f.path, f]));
    const relocated: Relocation[] = [];
    for (const t of limited) {
      const title = t.meta.title.trim() || 'Untitled';
      t.path = await this.alloc.allocateFree(`thread:${t.meta.id}`, t.folderPath, title, '.md', this.mayReplaceNote(t.meta.id), this.ownsNote(t.meta.id));
      if (t.meta.type === 'slides') t.pdfPath = await this.alloc.allocateFree(`pdf:${t.meta.id}`, t.folderPath, title, '.pdf', this.isMissing, this.mayReplaceBinary);
      const before = this.state.threads[t.meta.id]?.path;
      if (before && before !== t.path) relocated.push({ id: t.meta.id, title, from: before, to: t.path });
      const folder = folderByPath.get(t.folderPath);
      if (folder) folder.docCount += 1;
    }

    const authorIds = [...new Set(limited.map((t) => t.meta.authorId).filter((x): x is string => !!x && !this.users.has(x)))];
    if (authorIds.length > 0) for (const [id, name] of await client.getUsers(authorIds)) this.users.set(id, name);

    this.buildDocIndex(limited);
    const perDoc = 1 + (this.opts.includeComments ? 1 : 0);
    this.plan = {
      folders,
      threads: limited,
      unreadableFolders,
      unreadableThreads,
      skippedChats,
      unfiled,
      othersUnfiled,
      unreadableUnselected,
      relocated,
      estimatedRequests: limited.length * perDoc + Math.ceil(folders.length / 20) + Math.ceil((order.length + candidates.length) / 100) + 5,
    };
    this.emit({ type: 'phase', phase: 'scan', message: `Found ${limited.length} documents in ${folders.length} folders.` });
    return this.plan;
  }

  private buildDocIndex(threads: PlannedThread[]): void {
    const index = new Map<string, PlannedThread>();
    const add = (key: string | undefined, t: PlannedThread): void => {
      if (key && !index.has(key)) index.set(key, t);
    };
    for (const t of threads) {
      add(t.meta.id, t);
      add(t.meta.secretPath, t);
      add(/\/([\w-]{11,12})(?:[/?#]|$)/.exec(t.meta.link ?? '')?.[1], t);
    }
    this.docIndex = index;
  }

  private findDoc(key: string): PlannedThread | undefined {
    return this.docIndex.get(key) ?? (key.length === 12 ? this.docIndex.get(key.slice(0, 11)) : undefined);
  }

  // ---- export ----------------------------------------------------------

  async run(): Promise<ExportSummary> {
    const started = this.deps.now?.() ?? new Date();
    const plan = await this.scan();
    this.emit({ type: 'phase', phase: 'export', message: `Exporting ${plan.threads.length} documents…` });
    for (const folder of plan.folders) await this.deps.sink.ensureDir(folder.path);

    let stopReason: StopReason = 'completed';
    let fatal: unknown;
    const counts = { exported: 0, skipped: 0, failed: 0, slides: 0 };
    for (const [i, thread] of plan.threads.entries()) {
      if (this.deps.signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      const base = { index: i + 1, total: plan.threads.length, id: thread.meta.id, title: thread.meta.title || 'Untitled', path: thread.path };
      try {
        const result = await this.exportThread(thread);
        counts[result.status] += 1;
        if (result.slides) counts.slides += 1;
        this.emit({ type: 'doc', ...base, status: result.status });
      } catch (err) {
        if (isAbortError(err) || this.deps.signal?.aborted) {
          stopReason = 'aborted';
          break;
        }
        if (err instanceof AuthError) {
          fatal = err;
          stopReason = 'auth-error';
          break;
        }
        counts.failed += 1;
        const stage = (err as { stage?: string }).stage ?? 'export';
        this.failures.push({ id: thread.meta.id, title: base.title, stage, message: errMessage(err) });
        this.emit({ type: 'doc', ...base, status: 'failed', message: errMessage(err) });
      }
      if ((i + 1) % 10 === 0) await this.saveState();
    }

    const reportPath = await this.freeReportPath();
    const finished = this.deps.now?.() ?? new Date();
    const summary: ExportSummary = {
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      stopReason,
      aborted: stopReason === 'aborted',
      docs: { planned: plan.threads.length, ...counts, notAttempted: plan.threads.length - counts.exported - counts.skipped - counts.failed },
      folders: plan.folders.length,
      attachments: { ...this.attachments },
      comments: this.commentCount,
      embeds: { ...this.embedTotals },
      warnings: Object.fromEntries(this.warningGroups),
      failures: this.failures,
      unresolvedLinks: [...this.unresolved],
      unreadableFolders: plan.unreadableFolders,
      unreadableUnselected: plan.unreadableUnselected,
      unreadableThreads: plan.unreadableThreads,
      skippedChats: plan.skippedChats,
      othersUnfiled: plan.othersUnfiled,
      relocated: plan.relocated,
      rateLimitPauses: this.pauses,
      reportPath,
    };
    this.emit({ type: 'phase', phase: 'finish', message: stopReason === 'completed' ? 'Writing the report…' : 'Stopped. Progress is saved; run again to continue.' });
    await this.saveState();
    await this.deps.sink.writeFile(REPORT_JSON_PATH, JSON.stringify(summary, null, 1));
    await this.deps.sink.writeFile(reportPath, renderReport(summary, plan));
    if (fatal) throw fatal;
    return summary;
  }

  /** The report keeps its usual name unless a file there is not this tool's own report; then it takes a numbered name. */
  private async freeReportPath(): Promise<string> {
    for (let n = 1; n < 1000; n += 1) {
      const path = n === 1 ? REPORT_MD_PATH : REPORT_MD_PATH.replace(/\.md$/, ` (${n}).md`);
      const head = await this.deps.sink.readHead(path, 600);
      if (head === undefined || isOwnReport(head)) return path;
    }
    throw new Error('Could not find a free name for the export report.');
  }

  private addWarnings(thread: ThreadMeta, warnings: Warning[]): void {
    for (const w of warnings) {
      const group = this.warningGroups.get(w.code) ?? { count: 0, examples: [] };
      group.count += 1;
      if (group.examples.length < 5) group.examples.push(`${thread.title || thread.id}${w.detail ? `: ${w.detail}` : ''}`);
      this.warningGroups.set(w.code, group);
    }
  }

  private countEmbeds(embeds: Record<string, number>): void {
    for (const [type, n] of Object.entries(embeds)) this.embedTotals[type] = (this.embedTotals[type] ?? 0) + n;
  }

  /** True when the note on disk is still correct: same document version, options, location and link targets. */
  private async isUpToDate(t: PlannedThread, prev: ThreadState | undefined): Promise<boolean> {
    if (!this.opts.skipUnchanged || !prev || prev.retry) return false;
    if (t.meta.updatedUsec === undefined || prev.updatedUsec !== t.meta.updatedUsec) return false;
    if (prev.fingerprint !== this.fingerprint() || prev.path !== t.path) return false;
    if (this.opts.keepRaw && !prev.rawFiles) return false;
    if (prev.timeZone !== undefined && prev.timeZone !== this.opts.timeZone) return false;
    for (const [key, target] of Object.entries(prev.links ?? {})) if (this.findDoc(key)?.path !== target) return false;
    for (const key of prev.unresolved ?? []) if (this.findDoc(key)) return false;
    for (const file of prev.files ?? []) if (!(await this.deps.sink.exists(file))) return false;
    if (this.opts.keepRaw) for (const file of prev.rawFiles ?? []) if (!(await this.deps.sink.exists(file))) return false;
    // Still this document's note: the file may have been replaced since the scan.
    const head = await this.deps.sink.readHead(t.path, 4000);
    return head !== undefined && frontMatterHasId(head, t.meta.id);
  }

  private async exportThread(t: PlannedThread): Promise<DocResult> {
    const { meta } = t;
    const { sink, client } = this.deps;
    const prev = this.state.threads[meta.id];
    if (await this.isUpToDate(t, prev)) {
      // Keep the report whole: an unchanged document still counts, along with the problems it had.
      if (prev) {
        this.addWarnings(meta, prev.warnings ?? []);
        this.countEmbeds(prev.embeds ?? {});
        for (const key of prev.unresolved ?? []) this.unresolved.add(key);
      }
      return { status: 'skipped', slides: meta.type === 'slides' };
    }

    // Until this export succeeds the old record must not claim the note is current, whether the export
    // was forced or fails part-way.
    if (prev) this.state.threads[meta.id] = { ...prev, retry: true };

    const warnings: Warning[] = [];
    const embeds: Record<string, number> = {};
    const flags: Flags = { retry: false, files: new Set() };
    const linkLog: LinkLog = { links: {}, unresolved: new Set() };
    const rawFiles: string[] = [];
    const writeRaw = async (name: string, data: string): Promise<void> => {
      const path = `${RAW_DIR}/${meta.id}/${name}`;
      await sink.writeFile(path, data);
      rawFiles.push(path);
    };
    let body: string;
    let xlsxLine = '';

    if (meta.type === 'slides') {
      body = await this.slidesBody(t, warnings, flags);
    } else {
      const rawHtml = await this.stage('fetch', () => client.getThreadHtml(meta.id));
      if (this.opts.keepRaw) await writeRaw('body.html', rawHtml);
      if (rawHtml.trim() === '') warnings.push({ code: 'empty-html', detail: 'Quip returned no content (often a permissions issue)' });
      body = await this.stage('convert', () => this.convert(t, rawHtml, warnings, embeds, flags, linkLog));
      xlsxLine = await this.saveSpreadsheet(t, embeds, warnings, flags);
    }

    let comments = '';
    let messages: QuipMessage[] = [];
    if (this.opts.includeComments && meta.type !== 'slides') {
      const list = await this.stage('comments', () => client.getMessages(meta.id));
      messages = list.messages;
      if (list.incomplete) warnings.push({ code: 'comments-incomplete', detail: 'more comments share one timestamp than Quip lets the tool list' });
      comments = await this.renderComments(t, messages, warnings, flags, linkLog);
    }

    await this.claimNotePath(t);
    await this.writeRecorded(t.path, this.composeNote(t, body, xlsxLine, comments, embeds));
    if (this.opts.keepRaw) {
      await writeRaw('thread.json', JSON.stringify({ meta: t.raw, normalized: meta }, null, 1));
      if (this.opts.includeComments && meta.type !== 'slides') await writeRaw('messages.json', JSON.stringify(messages, null, 1));
    }

    for (const key of linkLog.unresolved) this.unresolved.add(key);
    this.countEmbeds(embeds);
    this.addWarnings(meta, warnings);
    this.state.threads[meta.id] = {
      ...(meta.updatedUsec !== undefined ? { updatedUsec: meta.updatedUsec } : {}),
      fingerprint: this.fingerprint(),
      exportedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      path: t.path,
      links: linkLog.links,
      unresolved: [...linkLog.unresolved],
      warnings: warnings.slice(0, MAX_STORED_WARNINGS),
      embeds,
      files: [...flags.files],
      ...(this.opts.keepRaw ? { rawFiles } : {}),
      ...(embeds.project_tracker && this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}),
      ...(flags.retry ? { retry: true } : {}),
    };
    return { status: 'exported', slides: meta.type === 'slides' };
  }

  /**
   * Just before a note is written, checks once more that the file at its path is still what this tool wrote
   * (the folder may have changed since the scan, the user may have edited the note since the last export, or
   * another run may be writing). If not, the file is left alone and the note moves to a free name.
   */
  private async claimNotePath(t: PlannedThread): Promise<void> {
    const may = this.mayReplaceNote(t.meta.id);
    if (await may(t.path)) return;
    const title = t.meta.title.trim() || 'Untitled';
    const moved = await this.alloc.allocateFree(`thread:${t.meta.id}`, t.folderPath, title, '.md', may, may);
    this.log('warn', `${t.path} was edited or replaced since this tool wrote it, so it was left alone and "${title}" was saved as ${moved}.`);
    this.plan?.relocated.push({ id: t.meta.id, title, from: t.path, to: moved });
    t.path = moved;
  }

  /** Tags an error with the stage it came from so the report can say what failed. */
  private async stage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && !(err as { stage?: string }).stage) (err as { stage?: string }).stage = stage;
      throw err;
    }
  }

  private async convert(t: PlannedThread, html: string, warnings: Warning[], embeds: Record<string, number>, flags: Flags, linkLog: LinkLog): Promise<string> {
    const { meta } = t;
    const options = { threadId: meta.id, spreadsheetThread: meta.type === 'spreadsheet', userNames: this.users, ...(this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}) };
    let result = htmlToMarkdown(html, options, this.deps.parseHtml);
    const unknown = result.unknownUserIds.filter((id) => !this.users.has(id));
    if (unknown.length > 0) {
      for (const [id, name] of await this.deps.client.getUsers(unknown)) this.users.set(id, name);
      result = htmlToMarkdown(html, options, this.deps.parseHtml);
    }
    warnings.push(...result.warnings);
    Object.assign(embeds, result.embeds);

    for (const ref of result.blobs) await this.ensureBlob(ref, warnings, flags);
    await this.identifyPeople(result.docLinks);
    const rewritten = rewriteSentinels(result.markdown, {
      from: t.path,
      blobPath: (key) => this.blobPaths.get(key),
      docPath: (key) => this.findDoc(key)?.path,
      isUser: (id) => this.users.has(id),
      originalUrl: (key) => result.docUrls[key],
      siteUrl: this.siteUrl,
    });
    for (const key of result.docLinks) {
      const target = this.findDoc(key);
      if (target) linkLog.links[key] = target.path;
    }
    for (const key of rewritten.unresolvedDocs) linkLog.unresolved.add(key);
    if (rewritten.unresolvedDocs.length > 0) warnings.push({ code: 'link-outside-export', detail: rewritten.unresolvedDocs.join(', ') });
    return rewritten.markdown.trimEnd();
  }

  /** Person @mentions use document-style URLs, so ids that match no exported document are checked against the users API once. */
  private async identifyPeople(linkIds: string[]): Promise<void> {
    const unknown = linkIds.filter((id) => !this.findDoc(id) && !this.users.has(id) && !this.notUsers.has(id));
    if (unknown.length === 0) return;
    const found = await this.deps.client.getUsers(unknown);
    for (const [id, name] of found) this.users.set(id, name);
    for (const id of unknown) if (!found.has(id)) this.notUsers.add(id);
  }

  private async slidesBody(t: PlannedThread, warnings: Warning[], flags: Flags): Promise<string> {
    const title = t.meta.title.trim() || 'Untitled';
    let pdfLink = '';
    if (t.pdfPath) {
      try {
        const pdf = await this.deps.client.getSlidesPdf(t.meta.id);
        if (!hasPdfSignature(pdf.bytes)) throw new Error('Quip did not return a PDF');
        await this.writeRecorded(t.pdfPath, pdf.bytes);
        flags.files.add(t.pdfPath);
        pdfLink = `[Open the PDF copy](${relativeLink(t.path, t.pdfPath)})`;
      } catch (err) {
        if (err instanceof AuthError || isAbortError(err)) throw err;
        warnings.push({ code: 'slides-pdf-failed', detail: err instanceof QuipHttpError ? `HTTP ${err.status}` : errMessage(err) });
        if (isRetryable(err)) flags.retry = true;
      }
    }
    const note = pdfLink ? 'Quip slide decks cannot be converted to Markdown. A PDF copy is saved next to this note.' : 'Quip slide decks cannot be converted to Markdown, and the PDF copy could not be fetched.';
    return [`# ${escapeInline(title)}`, `> ${note}`, pdfLink].filter(Boolean).join('\n\n');
  }

  /** Spreadsheet HTML holds displayed values, not formulas, so Quip's own XLSX export is kept next to the note. */
  private async saveSpreadsheet(t: PlannedThread, embeds: Record<string, number>, warnings: Warning[], flags: Flags): Promise<string> {
    if (!this.opts.saveXlsx) return '';
    const { meta } = t;
    if (meta.type !== 'spreadsheet' && !meta.hasSpreadsheet && (embeds.spreadsheet ?? 0) === 0) return '';
    const title = meta.title.trim() || 'Untitled';
    try {
      const path = await this.alloc.allocateFree(`xlsx:${meta.id}`, t.folderPath, title, '.xlsx', this.isMissing, this.mayReplaceBinary);
      const file = await this.deps.client.getXlsx(meta.id);
      if (!hasZipSignature(file.bytes)) throw new Error('Quip did not return a workbook');
      await this.writeRecorded(path, file.bytes);
      flags.files.add(path);
      return `> Original spreadsheet with its formulas: [${escapeInline(`${title}.xlsx`)}](${relativeLink(t.path, path)})`;
    } catch (err) {
      if (err instanceof AuthError || isAbortError(err) || this.deps.signal?.aborted) throw err;
      warnings.push({ code: 'xlsx-failed', detail: err instanceof QuipHttpError ? `HTTP ${err.status}` : errMessage(err) });
      if (isRetryable(err)) flags.retry = true;
      return '';
    }
  }

  private composeNote(t: PlannedThread, body: string, xlsxLine: string, comments: string, embeds: Record<string, number>): string {
    const { meta } = t;
    const title = meta.title.trim() || 'Untitled';
    const fm = frontMatter({
      title,
      quip_id: meta.id,
      quip_url: meta.link ?? `${this.siteUrl}/${meta.id}`,
      quip_type: meta.type,
      created: usecToIso(meta.createdUsec),
      updated: usecToIso(meta.updatedUsec),
      author: meta.authorId ? this.users.get(meta.authorId) : undefined,
      folder: t.folderPath || undefined,
      also_in: t.alsoIn,
      embeds: Object.keys(embeds).sort(),
      moved_to: meta.movedTo,
      exported: (this.deps.now?.() ?? new Date()).toISOString(),
      exporter: `${TOOL_NAME} ${TOOL_VERSION}`,
    });
    let content = body.trim();
    if (!/^# /.test(content)) content = `# ${escapeInline(title)}${content ? `\n\n${content}` : ''}`;
    if (meta.movedTo) content = content.replace(/^(# .*\n?)/, `$1\n> [!info] This Quip document was moved to ${meta.movedTo}\n`);
    if (xlsxLine) content = `${content}\n\n${xlsxLine}`;
    return `${fm}\n\n${content.trimEnd()}\n${comments ? `\n${comments}` : ''}`;
  }

  // ---- attachments -----------------------------------------------------

  private async ensureBlob(ref: BlobRef, warnings: Warning[], flags: Flags): Promise<string | null> {
    const key = `${ref.threadId}/${ref.blobId}`;
    const cached = this.blobPaths.get(key);
    if (cached !== undefined) {
      // Another note already tried: this one has the same problem, or the same file, and says so too.
      if (cached === null) this.reportBlobFailure(key, warnings, flags);
      else flags.files.add(cached);
      return cached;
    }
    const allocKey = `blob:${key}`;
    const known = this.alloc.get(allocKey);
    if (known && (await this.deps.sink.exists(known))) {
      this.blobPaths.set(key, known);
      this.attachments.reused += 1;
      flags.files.add(known);
      return known;
    }
    try {
      const res = await this.deps.client.getBlob(ref.threadId, ref.blobId);
      if (res.bytes.length === 0) throw new Error('empty response');
      // Never dropped (it may be a genuine JSON file), but flagged: Quip's error reports have this shape too.
      if (looksLikeApiError(res.contentType, res.bytes)) warnings.push({ code: 'attachment-suspect', detail: `${key}: the file is JSON shaped like a Quip error report` });
      const ext = attachmentExtension(res.contentType, ref.hint, res.bytes);
      const stem = ref.kind === 'file' && ref.hint ? stripExtension(ref.hint) : ref.blobId;
      const path = known ?? (await this.alloc.allocateFree(allocKey, `${this.attachmentsRoot}/${ref.threadId}`, stem, ext, this.isMissing));
      await this.deps.sink.writeFile(path, res.bytes);
      this.blobPaths.set(key, path);
      this.attachments.saved += 1;
      flags.files.add(path);
      return path;
    } catch (err) {
      if (err instanceof AuthError || isAbortError(err) || this.deps.signal?.aborted) throw err;
      this.blobPaths.set(key, null);
      this.blobFailures.set(key, { detail: err instanceof QuipHttpError ? `HTTP ${err.status}` : errMessage(err), retry: isRetryable(err) });
      this.attachments.missing += 1;
      this.reportBlobFailure(key, warnings, flags);
      return null;
    }
  }

  private reportBlobFailure(key: string, warnings: Warning[], flags: Flags): void {
    const failure = this.blobFailures.get(key);
    warnings.push({ code: 'attachment-missing', detail: `${key}: ${failure?.detail ?? 'unavailable'}` });
    if (failure?.retry ?? true) flags.retry = true;
  }

  // ---- comments --------------------------------------------------------

  /** Escapes comment text and turns Quip URLs into @mentions, relative links to exported notes, or autolinks. */
  private linkifyComment(text: string, from: string, linkLog: LinkLog): string {
    let out = '';
    let last = 0;
    for (const match of text.matchAll(QUIP_URL)) {
      const index = match.index ?? 0;
      out += escapeInline(text.slice(last, index));
      last = index + match[0].length;
      const key = match[1] as string;
      const person = this.users.get(key);
      const doc = this.findDoc(key);
      if (person) out += `@${escapeInline(person)}`;
      else if (doc) {
        linkLog.links[key] = doc.path;
        out += `[${escapeInline(doc.meta.title.trim() || 'document')}](${relativeLink(from, doc.path)})`;
      } else {
        linkLog.unresolved.add(key);
        out += /^[^\s<>]+$/.test(match[0]) ? `<${match[0]}>` : escapeInline(match[0]);
      }
    }
    return out + escapeInline(text.slice(last));
  }

  private async renderComments(t: PlannedThread, messages: QuipMessage[], warnings: Warning[], flags: Flags, linkLog: LinkLog): Promise<string> {
    const meta = t.meta;
    const wanted = new Set<string>();
    for (const m of messages) {
      if (m.authorId) wanted.add(m.authorId);
      for (const id of m.mentionUserIds) wanted.add(id);
    }
    const missing = [...wanted].filter((id) => !this.users.has(id));
    if (missing.length > 0) for (const [id, name] of await this.deps.client.getUsers(missing)) this.users.set(id, name);

    const blocks: string[] = [];
    for (const m of messages) {
      if (!m.text.trim() && m.files.length === 0) continue;
      const who = m.authorName ?? (m.authorId ? this.users.get(m.authorId) : undefined) ?? 'Unknown';
      const when = usecToIso(m.createdUsec)?.replace('T', ' ').slice(0, 16);
      const lines = [`**${escapeInline(who)}**${when ? ` · ${when} UTC` : ''}${m.anchored ? ' · *on highlighted text*' : ''}`];
      for (const line of m.text.replace(/\r\n?/g, '\n').split('\n')) lines.push(escapeBlockStart(this.linkifyComment(line, t.path, linkLog)));
      for (const file of m.files) {
        const path = await this.ensureBlob({ threadId: meta.id, blobId: file.hash, kind: 'file', ...(file.name ? { hint: file.name } : {}) }, warnings, flags);
        const label = escapeInline(file.name || 'attachment');
        lines.push(path ? `📎 [${label}](${relativeLink(t.path, path)})` : `📎 ${label} *(attachment unavailable)*`);
      }
      blocks.push(lines.map((l) => (l ? `> ${l}` : '>')).join('\n'));
    }
    this.commentCount += blocks.length;
    return blocks.length > 0 ? `## Comments and conversation\n\n${blocks.join('\n\n')}\n` : '';
  }
}

export function renderReport(summary: ExportSummary, plan: Plan): string {
  const lines: string[] = [];
  const status =
    summary.stopReason === 'auth-error'
      ? `Stopped: Quip rejected the access token (${summary.docs.notAttempted} documents were not exported; create a new token and run again)`
      : summary.stopReason === 'aborted'
        ? 'Stopped early (run again to continue)'
        : summary.docs.failed > 0
          ? 'Finished with problems'
          : 'Finished';
  lines.push('# Quip export report', '', `- Status: ${status}`, `- Finished: ${summary.finishedAt}`, `- Tool: ${TOOL_NAME} ${TOOL_VERSION}`);
  lines.push(
    `- Documents: ${summary.docs.exported} exported, ${summary.docs.skipped} unchanged since the last run, ${summary.docs.failed} failed${summary.docs.notAttempted > 0 ? `, ${summary.docs.notAttempted} not attempted` : ''} (of ${summary.docs.planned})`,
    `- Folders: ${summary.folders}`,
    `- Attachments: ${summary.attachments.saved} saved, ${summary.attachments.reused} reused, ${summary.attachments.missing} unavailable`,
    `- Comments exported: ${summary.comments}`,
  );
  if (summary.rateLimitPauses > 0) lines.push(`- Quip's rate limit paused the export ${summary.rateLimitPauses} times`);

  const embeds = Object.entries(summary.embeds).sort(([a], [b]) => a.localeCompare(b));
  if (embeds.length > 0) {
    lines.push('', '## Embedded content converted', '');
    for (const [type, n] of embeds) lines.push(`- ${type}: ${n}`);
  }

  lines.push('', '## Needs attention', '');
  let attention = false;
  if (summary.failures.length > 0) {
    attention = true;
    lines.push('### Failed documents', '');
    for (const f of summary.failures) lines.push(`- ${escapeInline(f.title)} (\`${f.id}\`), ${f.stage}: ${f.message}`);
    lines.push('');
  }
  const warnings = Object.entries(summary.warnings).filter(([code]) => code !== 'link-outside-export');
  if (warnings.length > 0) {
    attention = true;
    lines.push('### Warnings', '');
    for (const [code, group] of warnings) lines.push(`- \`${code}\` (${group.count}): ${group.examples.map((e) => escapeInline(e)).join('; ')}`);
    lines.push('');
  }
  if (summary.unresolvedLinks.length > 0) {
    attention = true;
    lines.push('### Links to documents outside this export', '', 'These links point back to Quip and will stop working when Quip is retired:', '');
    for (const id of summary.unresolvedLinks) lines.push(`- \`${id}\``);
    lines.push('');
  }
  if (summary.relocated.length > 0) {
    attention = true;
    lines.push('### Written to a new location since the last export', '', 'These documents were moved or renamed in Quip, or the file name they had was taken by something else. The note was written to its new location. The old copy was left in place (nothing is ever deleted); remove it if you no longer need it:', '');
    for (const r of summary.relocated) lines.push(`- \`${r.from}\` is now \`${r.to}\``);
    lines.push('');
  }
  if (plan.unreadableFolders.length + plan.unreadableThreads.length + plan.unreadableUnselected.length > 0) {
    attention = true;
    lines.push('### Not readable with this token', '');
    for (const f of plan.unreadableFolders) lines.push(`- Folder \`${f.id}\` (HTTP ${f.status || 'no response'})`);
    for (const f of plan.unreadableUnselected) lines.push(`- Folder \`${f.id}\`, outside your selection (HTTP ${f.status || 'no response'})`);
    for (const t of plan.unreadableThreads) lines.push(`- Document \`${t.id}\` in ${t.folderPath || 'the root'} (HTTP ${t.status || 'no response'})`);
    if (plan.unreadableFolders.length + plan.unreadableUnselected.length > 0) {
      lines.push('', 'What is inside an unreadable folder is unknown, so a document you wrote there can appear under the unfiled directory instead of in its folder.');
    }
    lines.push('');
  }
  if (summary.othersUnfiled > 0) lines.push(`${summary.othersUnfiled} documents written by other people are shared with you but sit in none of your folders; they were not exported.`, '');
  if (summary.skippedChats > 0) lines.push(`Chats are not exported (${summary.skippedChats} skipped).`, '');
  if (!attention) lines.push('Nothing.', '');
  return `${lines.join('\n').trimEnd()}\n`;
}
