import { isObj, normalizeCurrentUser, normalizeFolder, normalizeMessage, normalizeThread, normalizeThreadType } from './normalize';
import type { BinaryResponse, CurrentUser, OwnedThread, QuipApi, QuipMessage, Result } from './quipTypes';
import type { FolderMeta, ThreadMeta } from './types';

export const DEFAULT_BASE_URL = 'https://platform.quip.com';

export class QuipHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`HTTP ${status} for ${path}${detail ? `: ${detail}` : ''}`);
    this.name = 'QuipHttpError';
  }
}

/** The token was rejected. Retrying cannot help, so the whole run stops. */
export class AuthError extends QuipHttpError {
  constructor(path: string, detail: string) {
    super(401, path, detail);
    this.name = 'AuthError';
  }
}

/** Raised before any network I/O when something other than an allow-listed read is attempted. */
export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyViolation';
  }
}

/**
 * Every endpoint this tool may call. They are all reads. Quip documents are never modified:
 * a request for any other path, or with any method but GET, is refused locally.
 */
export const READ_ONLY_ENDPOINTS: readonly RegExp[] = [
  /^\/1\/users\/current$/,
  /^\/1\/users\/current\/threads$/,
  /^\/1\/users\/$/,
  /^\/1\/folders\/$/,
  /^\/1\/folders\/[A-Za-z0-9]{8,32}$/,
  /^\/2\/threads\/$/,
  /^\/2\/threads\/[A-Za-z0-9]{8,32}$/,
  /^\/2\/threads\/[A-Za-z0-9]{8,32}\/html$/,
  /^\/1\/messages\/[A-Za-z0-9]{8,32}$/,
  /^\/1\/blob\/[A-Za-z0-9]{8,32}\/[\w-]{8,64}$/,
  /^\/1\/threads\/[A-Za-z0-9]{8,32}\/export\/pdf$/,
];

export function assertReadOnly(method: string, path: string): void {
  if (method !== 'GET') throw new ReadOnlyViolation(`Refusing ${method} ${path}: this tool only reads from Quip.`);
  if (!READ_ONLY_ENDPOINTS.some((re) => re.test(path))) {
    throw new ReadOnlyViolation(`Refusing GET ${path}: not on the read-only endpoint allow-list.`);
  }
}

export type ClientEvent =
  | { type: 'throttle'; waitMs: number; reason: 'rate-limit' | 'service' | 'network'; path: string }
  | { type: 'request'; path: string; status: number };

export interface ClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Minimum gap between requests. The default stays under Quip's 50 requests/minute limit. */
  minIntervalMs?: number;
  /** Retries for 5xx and network errors. Rate limiting is retried until it clears. */
  maxRetries?: number;
  /** Messages requested per page. */
  messagePageSize?: number;
  signal?: AbortSignal;
  onEvent?: (event: ClientEvent) => void;
}

type Query = Record<string, string | number | boolean | undefined>;

/** Thread, folder, user and secret-path ids are 11-12 base-62 characters; verbs like "new" or "add-members" never match. */
const ENTITY_ID_RE = /^[A-Za-z0-9]{8,32}$/;
const BLOB_ID_RE = /^[\w-]{8,64}$/;
const MAX_WAIT_MS = 3_600_000;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const validEntityId = (id: string): boolean => ENTITY_ID_RE.test(id);

function requireId(id: string): string {
  if (!validEntityId(id)) throw new RangeError(`Invalid Quip identifier: ${JSON.stringify(id.slice(0, 40))}`);
  return id;
}

function requireBlobId(id: string): string {
  if (!BLOB_ID_RE.test(id)) throw new RangeError(`Invalid Quip blob identifier: ${JSON.stringify(id.slice(0, 40))}`);
  return id;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function headerNumber(headers: Headers, names: string[]): number | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  }
  return undefined;
}

export class QuipClient implements QuipApi {
  private readonly token: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly minInterval: number;
  private readonly maxRetries: number;
  private readonly pageSize: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onEvent: ((event: ClientEvent) => void) | undefined;
  private nextSlot = 0;
  private blockedUntil = 0;

  constructor(opts: ClientOptions) {
    if (!opts.token || !opts.token.trim()) throw new Error('A Quip access token is required.');
    this.token = opts.token.trim();
    const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(base);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !local) throw new Error('The Quip API base URL must use https.');
    this.base = base;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.minInterval = opts.minIntervalMs ?? 1300;
    this.maxRetries = opts.maxRetries ?? 5;
    this.pageSize = opts.messagePageSize ?? 100;
    this.signal = opts.signal;
    this.onEvent = opts.onEvent;
  }

  // ---- transport -------------------------------------------------------

  private buildUrl(path: string, query: Query): string {
    assertReadOnly('GET', path);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const qs = params.toString();
    return `${this.base}${path}${qs ? `?${qs}` : ''}`;
  }

  private redact(text: string): string {
    return text.split(this.token).join('***').slice(0, 300);
  }

  private async pace(): Promise<void> {
    const wait = Math.max(this.nextSlot, this.blockedUntil) - this.now();
    if (wait > 0) await this.waitFor(wait, 'rate-limit', '');
    this.nextSlot = Math.max(this.now(), this.nextSlot) + this.minInterval;
  }

  /**
   * One abortable sleep, announced once so the UI can run its own countdown. Short polling steps
   * would be stretched by the browser's background-tab timer throttling.
   */
  private async waitFor(totalMs: number, reason: 'rate-limit' | 'service' | 'network', path: string): Promise<void> {
    const ms = Math.min(totalMs, MAX_WAIT_MS);
    if (ms <= 0) return;
    if (ms >= 1000 || reason !== 'rate-limit') this.onEvent?.({ type: 'throttle', waitMs: ms, reason, path });
    await this.sleepFn(ms, this.signal);
  }

  private async send(path: string, query: Query, accept: string): Promise<Response> {
    const url = this.buildUrl(path, query);
    for (let attempt = 0; ; attempt += 1) {
      this.signal?.throwIfAborted();
      await this.pace();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          ...(this.signal ? { signal: this.signal } : {}),
        });
      } catch (err) {
        if (this.signal?.aborted) throw err;
        if (attempt >= this.maxRetries) throw new Error(`Network error for ${path}: ${this.redact(String(err))}`);
        await this.waitFor(Math.min(30_000, 1000 * 2 ** attempt), 'network', path);
        continue;
      }

      this.onEvent?.({ type: 'request', path, status: res.status });
      this.observe(res.headers);
      if (res.ok) return res;

      if (res.status === 429 || res.status === 503) {
        const wait = this.throttleDelay(res.headers);
        if (wait !== undefined) {
          this.blockedUntil = this.now() + wait;
          await this.waitFor(wait, 'rate-limit', path);
          continue;
        }
      }
      if (res.status >= 500 && attempt < this.maxRetries) {
        await this.waitFor(Math.min(30_000, 1000 * 2 ** attempt), 'service', path);
        continue;
      }
      const detail = this.redact(await res.text().catch(() => ''));
      if (res.status === 401) throw new AuthError(path, detail);
      throw new QuipHttpError(res.status, path, detail);
    }
  }

  /** When the quota is spent, wait until it resets instead of failing. */
  private observe(headers: Headers): void {
    const remaining = headerNumber(headers, ['x-ratelimit-remaining', 'x-company-ratelimit-remaining']);
    if (remaining !== undefined && remaining <= 0) {
      const delay = this.throttleDelay(headers);
      if (delay !== undefined) this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
    }
  }

  /** Milliseconds to wait, or undefined when the response gives no sign that the quota is the problem. */
  private throttleDelay(headers: Headers): number | undefined {
    const retryAfter = headerNumber(headers, ['retry-after', 'x-company-retry-after', 'x-documentbulkexport-retry-after']);
    const resetAt = headerNumber(headers, ['x-ratelimit-reset', 'x-company-ratelimit-reset', 'x-documentbulkexport-ratelimit-reset']);
    const remaining = headerNumber(headers, ['x-ratelimit-remaining', 'x-company-ratelimit-remaining']);
    let wait: number | undefined;
    if (retryAfter !== undefined) wait = retryAfter * 1000;
    else if (resetAt !== undefined && resetAt * 1000 > this.now()) wait = resetAt * 1000 - this.now();
    else if (remaining === 0) wait = 5000;
    if (wait === undefined) return undefined;
    return Math.min(MAX_WAIT_MS, Math.max(1000, wait + 1000));
  }

  private async getJson(path: string, query: Query = {}): Promise<unknown> {
    const res = await this.send(path, query, 'application/json');
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QuipHttpError(res.status, path, 'response was not valid JSON');
    }
  }

  private async getBytes(path: string, query: Query = {}): Promise<BinaryResponse> {
    const res = await this.send(path, query, '*/*');
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }

  // ---- bulk helper -----------------------------------------------------

  /**
   * Fetches ids in chunks. If a chunk is rejected with a 4xx (one id unreadable), it is split
   * in half until the offender is isolated, so a single bad id never hides the rest.
   */
  private async bulk<T>(
    ids: string[],
    size: number,
    path: string,
    parse: (id: string, raw: unknown) => T,
    extra: Query = {},
  ): Promise<Map<string, Result<T>>> {
    const out = new Map<string, Result<T>>();
    const unique = [...new Set(ids)];
    for (const id of unique) if (!validEntityId(id)) out.set(id, { ok: false, status: 400, message: 'invalid identifier' });
    const queue = chunk(unique.filter(validEntityId), size);
    while (queue.length > 0) {
      const group = queue.shift() ?? [];
      try {
        const body = await this.getJson(path, { ...extra, ids: group.join(',') });
        const map: Record<string, unknown> = Array.isArray(body)
          ? Object.fromEntries(body.filter(isObj).map((x) => [String(x.id), x]))
          : isObj(body)
            ? body
            : {};
        for (const id of group) {
          const raw = map[id];
          out.set(id, raw === undefined || raw === null ? { ok: false, status: 404, message: 'not returned by Quip' } : { ok: true, value: parse(id, raw), raw });
        }
      } catch (err) {
        if (err instanceof QuipHttpError && !(err instanceof AuthError) && err.status >= 400 && err.status < 500 && err.status !== 429) {
          if (group.length === 1) out.set(group[0] as string, { ok: false, status: err.status, message: err.message });
          else {
            const mid = Math.ceil(group.length / 2);
            queue.unshift(group.slice(0, mid), group.slice(mid));
          }
        } else throw err;
      }
    }
    return out;
  }

  private async single<T>(path: string, parse: (raw: unknown) => T): Promise<Result<T>> {
    try {
      const raw = await this.getJson(path);
      return { ok: true, value: parse(raw), raw };
    } catch (err) {
      if (err instanceof QuipHttpError && !(err instanceof AuthError) && err.status >= 400 && err.status < 500) {
        return { ok: false, status: err.status, message: err.message };
      }
      throw err;
    }
  }

  // ---- API -------------------------------------------------------------

  async currentUser(): Promise<CurrentUser> {
    return normalizeCurrentUser(await this.getJson('/1/users/current'));
  }

  async getFolder(idOrSecret: string): Promise<Result<FolderMeta>> {
    return this.single(`/1/folders/${requireId(idOrSecret)}`, (raw) => normalizeFolder(idOrSecret, raw));
  }

  async getThread(idOrSecret: string): Promise<Result<ThreadMeta>> {
    return this.single(`/2/threads/${requireId(idOrSecret)}`, (raw) => normalizeThread(idOrSecret, raw));
  }

  async getFolders(ids: string[]): Promise<Map<string, Result<FolderMeta>>> {
    return this.bulk(ids, 50, '/1/folders/', normalizeFolder);
  }

  async getThreads(ids: string[]): Promise<Map<string, Result<ThreadMeta>>> {
    return this.bulk(ids, 100, '/2/threads/', normalizeThread);
  }

  /** Full document body. Long documents arrive in cursor pages; a rejected cursor restarts once. */
  async getThreadHtml(id: string): Promise<string> {
    const path = `/2/threads/${requireId(id)}/html`;
    for (let restart = 0; ; restart += 1) {
      const parts: string[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 5000; page += 1) {
          const body = await this.getJson(path, cursor ? { cursor } : {});
          const root = isObj(body) ? body : {};
          parts.push(typeof root.html === 'string' ? root.html : '');
          const meta = isObj(root.response_metadata) ? root.response_metadata : {};
          cursor = typeof meta.next_cursor === 'string' && meta.next_cursor !== '' ? meta.next_cursor : undefined;
          if (!cursor) return parts.join('');
        }
        throw new Error(`Runaway pagination for ${path}`);
      } catch (err) {
        const staleCursor = err instanceof QuipHttpError && err.status === 400 && parts.length > 0;
        if (!staleCursor || restart >= 1) throw err;
      }
    }
  }

  /** Comments and conversation for a document, oldest first. */
  async getMessages(id: string): Promise<QuipMessage[]> {
    const path = `/1/messages/${requireId(id)}`;
    const byId = new Map<string, QuipMessage>();
    let maxCreated: number | undefined;
    for (let page = 0; page < 1000; page += 1) {
      const body = await this.getJson(path, { count: this.pageSize, ...(maxCreated !== undefined ? { max_created_usec: maxCreated } : {}) });
      const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.messages) ? body.messages : [];
      let added = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const raw of list) {
        const msg = normalizeMessage(raw);
        if (!msg) continue;
        oldest = Math.min(oldest, msg.createdUsec);
        if (!byId.has(msg.id)) {
          byId.set(msg.id, msg);
          added += 1;
        }
      }
      if (list.length < this.pageSize || added === 0 || !Number.isFinite(oldest)) break;
      maxCreated = oldest - 1;
    }
    return [...byId.values()].sort((a, b) => a.createdUsec - b.createdUsec);
  }

  async getBlob(threadId: string, blobId: string): Promise<BinaryResponse> {
    return this.getBytes(`/1/blob/${requireId(threadId)}/${requireBlobId(blobId)}`);
  }

  async getSlidesPdf(threadId: string): Promise<BinaryResponse> {
    return this.getBytes(`/1/threads/${requireId(threadId)}/export/pdf`);
  }

  async getUsers(ids: string[]): Promise<Map<string, string>> {
    const results = await this.bulk(ids, 200, '/1/users/', (_id, raw) => (isObj(raw) && typeof raw.name === 'string' ? raw.name : ''));
    const names = new Map<string, string>();
    for (const [id, result] of results) if (result.ok && result.value) names.set(id, result.value);
    return names;
  }

  /** Threads the user owns, including ones that sit in no folder. */
  async listOwnedThreads(): Promise<OwnedThread[]> {
    const out: OwnedThread[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page += 1) {
      const body = await this.getJson('/1/users/current/threads', { threads_meta: true, ...(cursor ? { cursor } : {}) });
      const root = isObj(body) ? body : {};
      const threads = isObj(root.threads) ? root.threads : {};
      for (const [id, raw] of Object.entries(threads)) {
        const meta = isObj(raw) ? raw : {};
        const owned: OwnedThread = { id, type: normalizeThreadType(meta.type), isDeleted: meta.is_deleted === true };
        if (typeof meta.updated_usec === 'number') owned.updatedUsec = meta.updated_usec;
        out.push(owned);
      }
      const rm = isObj(root.response_metadata) ? root.response_metadata : {};
      cursor = typeof rm.next_cursor === 'string' && rm.next_cursor !== '' ? rm.next_cursor : undefined;
      if (!cursor) break;
    }
    return out;
  }
}
