import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ANN, BOB, ME, SITE, TOKEN, XLSX_BYTES, buildFixture, F_ARCH, F_DESK, F_PRIV, F_SHARED, F_STAR, F_TRASH, type Fixture, type FixtureThread } from './fixture';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string;
  /** Where the request came from; sub-resources of an extension page carry a `chrome-extension://` origin. */
  referer: string;
}

export interface MockOptions {
  fixture?: Fixture;
  /** Return a response to override the normal handling of a request (failure injection). */
  override?: (req: RecordedRequest) => { status: number; headers?: Record<string, string>; body?: unknown } | undefined;
  /** Every Nth authorised request is answered with a 503 rate-limit response. */
  throttleEvery?: number;
  /** Clock used for rate-limit reset headers (defaults to Date.now). */
  now?: () => number;
  /** Wait this long before answering every request, so an export lasts long enough to interrupt. */
  delayMs?: number;
  /** Append tags that would load sub-resources from `/probe/...` to every document page; any request there is a leak. */
  probe?: boolean;
}

/** Every common way for HTML to make a browser fetch something. `{{MOCK_URL}}` is replaced with the server's address. */
const PROBE_TAGS = `<div class="probe">
<img src="{{MOCK_URL}}/probe/img.png" srcset="{{MOCK_URL}}/probe/srcset.png 2x">
<iframe src="{{MOCK_URL}}/probe/frame.html"></iframe>
<link rel="stylesheet" href="{{MOCK_URL}}/probe/style.css">
<link rel="preload" as="image" href="{{MOCK_URL}}/probe/preload.png">
<script src="{{MOCK_URL}}/probe/script.js"></script>
<video src="{{MOCK_URL}}/probe/video.mp4" poster="{{MOCK_URL}}/probe/poster.png"></video>
<audio src="{{MOCK_URL}}/probe/audio.mp3"></audio>
<object data="{{MOCK_URL}}/probe/object.bin"></object>
<embed src="{{MOCK_URL}}/probe/embed.bin">
<input type="image" src="{{MOCK_URL}}/probe/input.png">
<svg><image href="{{MOCK_URL}}/probe/svg.png"></image></svg>
<p style="background:url({{MOCK_URL}}/probe/bg.png)">styled</p>
<img src="broken" onerror="fetch('{{MOCK_URL}}/probe/onerror')">
<a href="{{MOCK_URL}}/probe/link" ping="{{MOCK_URL}}/probe/ping">link</a>
</div>`;

export const PROBE_PREFIX = '/probe/';
export const probeHtml = (baseUrl: string): string => PROBE_TAGS.replaceAll('{{MOCK_URL}}', baseUrl);

export interface MockQuip {
  url: string;
  fixture: Fixture;
  requests: RecordedRequest[];
  /** Requests of any method other than GET: must always stay empty. */
  mutating(): RecordedRequest[];
  /** Requests for anything under `/probe/`: sub-resources the extension must never load. */
  probeHits(): RecordedRequest[];
  close(): Promise<void>;
}

const userInfo = (u: { id: string; name: string }): Record<string, unknown> => ({ id: u.id, name: u.name, emails: [`${u.name.split(' ')[0]?.toLowerCase()}@example.com`] });

const hasSheet = (t: FixtureThread): boolean => t.type === 'SPREADSHEET' || t.pages.join('').includes("data-section-style='13'");

function threadJson(t: FixtureThread): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    author_id: t.authorId,
    created_usec: t.created,
    updated_usec: t.updated,
    link: `${SITE}/${t.secret ?? t.id}`,
    ...(t.secret ? { secret_path: t.secret } : {}),
    ...(hasSheet(t) ? { spreadsheet_summary: { num_tables: t.type === 'SPREADSHEET' ? 2 : 1 } } : {}),
    ...(t.movedTo ? { mark_as_moved_to_external: { status: 'moved', url: t.movedTo } } : {}),
  };
}

export async function startMockQuip(opts: MockOptions = {}): Promise<MockQuip> {
  const fx = opts.fixture ?? buildFixture();
  const requests: RecordedRequest[] = [];
  const now = opts.now ?? Date.now;
  let authorised = 0;
  let baseUrl = '';
  const servedHtml = (html: string): string => `${html}${opts.probe ? PROBE_TAGS : ''}`.replaceAll('{{MOCK_URL}}', baseUrl);

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const isBuf = body instanceof Uint8Array;
    res.writeHead(status, { 'content-type': isBuf ? (headers['content-type'] ?? 'application/octet-stream') : 'application/json', ...headers });
    res.end(isBuf ? Buffer.from(body) : JSON.stringify(body));
  };
  const error = (res: http.ServerResponse, status: number, message: string): void =>
    send(res, status, { error: 'application_error', error_code: status, error_description: message });

  const folderJson = (id: string): Record<string, unknown> | undefined => {
    const f = fx.folders[id];
    if (!f) return undefined;
    return { folder: { id: f.id, title: f.title, creator_id: ME.id, folder_class: 'standard' }, member_ids: [ME.id], children: f.children };
  };
  const userJson = (id: string): Record<string, unknown> | undefined => [ME, ANN, BOB].find((u) => u.id === id) && userInfo([ME, ANN, BOB].find((u) => u.id === id) as { id: string; name: string });

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const rec: RecordedRequest = { method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? '', referer: String(req.headers.referer ?? '') };
    requests.push(rec);
    if (rec.method !== 'GET') return error(res, 405, 'method not allowed');
    if (rec.path === '/control.html') {
      // A same-origin page for tests that need a live document next to the mock.
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<!doctype html><title>control</title><body></body>');
    }
    if (rec.auth !== `Bearer ${TOKEN}`) return error(res, 401, 'Invalid access_token');

    authorised += 1;
    if (opts.throttleEvery && authorised % opts.throttleEvery === 0) {
      const reset = Math.ceil(now() / 1000) + 2;
      return send(res, 503, { error: 'rate limited' }, { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
    }
    const forced = opts.override?.(rec);
    if (forced) return send(res, forced.status, forced.body ?? { error: 'forced' }, forced.headers);

    const path = rec.path;
    const q = url.searchParams;
    let m: RegExpExecArray | null;

    if (path === '/1/users/current') {
      return send(res, 200, {
        ...userInfo(ME),
        url: SITE,
        desktop_folder_id: F_DESK,
        archive_folder_id: F_ARCH,
        starred_folder_id: F_STAR,
        private_folder_id: F_PRIV,
        trash_folder_id: F_TRASH,
        shared_folder_ids: [F_SHARED],
        group_folder_ids: [],
      });
    }
    if (path === '/1/users/') {
      const out: Record<string, unknown> = {};
      for (const id of (q.get('ids') ?? '').split(',')) {
        const u = userJson(id);
        if (u) out[id] = u;
      }
      return send(res, 200, out);
    }
    if (path === '/1/users/current/threads') {
      const threads = Object.fromEntries(
        fx.owned.flatMap((id) => {
          const t = fx.threads[id];
          return t ? [[id, { updated_usec: t.updated, is_deleted: false, link: `${SITE}/${id}`, type: t.type === 'DOCUMENT' ? 'TEXT_DOCUMENT' : t.type === 'SPREADSHEET' ? 'SPREADSHEET_DOCUMENT' : t.type }]] : [];
        }),
      );
      return send(res, 200, { threads, response_metadata: {} });
    }
    if (path === '/1/folders/') {
      const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
      if (ids.some((id) => fx.restrictedFolders.includes(id))) return error(res, 403, 'forbidden');
      if (ids.some((id) => !fx.folders[id])) return error(res, 404, 'not found');
      return send(res, 200, Object.fromEntries(ids.map((id) => [id, folderJson(id)])));
    }
    if ((m = /^\/1\/folders\/([\w-]+)$/.exec(path))) {
      const id = m[1] as string;
      if (fx.restrictedFolders.includes(id)) return error(res, 403, 'forbidden');
      const f = folderJson(id);
      return f ? send(res, 200, f) : error(res, 404, 'not found');
    }
    if (path === '/2/threads/') {
      const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
      if (ids.some((id) => !fx.threads[id])) return error(res, 404, 'not found');
      return send(res, 200, Object.fromEntries(ids.map((id) => [id, threadJson(fx.threads[id] as FixtureThread)])));
    }
    if ((m = /^\/2\/threads\/([\w-]+)\/html$/.exec(path))) {
      const t = fx.threads[m[1] as string];
      if (!t) return error(res, 404, 'not found');
      const cursor = q.get('cursor');
      const index = cursor ? Number(cursor.replace('page', '')) : 0;
      if (!cursor && t.pages.length === 0) return send(res, 200, { html: '', response_metadata: {} });
      const page = t.pages[index];
      if (page === undefined) return error(res, 400, 'bad cursor');
      const html = servedHtml(page);
      return send(res, 200, { html, response_metadata: index + 1 < t.pages.length ? { next_cursor: `page${index + 1}` } : {} });
    }
    if ((m = /^\/2\/threads\/([\w-]+)$/.exec(path))) {
      const t = fx.threads[m[1] as string] ?? Object.values(fx.threads).find((x) => x.secret === m?.[1]);
      return t ? send(res, 200, { thread: threadJson(t) }) : error(res, 404, 'not found');
    }
    if ((m = /^\/1\/messages\/([\w-]+)$/.exec(path))) {
      const t = fx.threads[m[1] as string];
      if (!t) return error(res, 404, 'not found');
      const count = Number(q.get('count') ?? 25);
      const max = q.get('max_created_usec') ? Number(q.get('max_created_usec')) : Number.POSITIVE_INFINITY;
      const list = (t.messages ?? []).filter((x) => x.created_usec <= max).sort((a, b) => b.created_usec - a.created_usec).slice(0, count);
      return send(res, 200, list.map((x) => ({ ...x, updated_usec: x.created_usec, visible: true })));
    }
    if ((m = /^\/1\/blob\/([\w-]+)\/([\w-]+)$/.exec(path))) {
      const blob = fx.blobs[`${m[1]}/${m[2]}`];
      if (!blob) return error(res, 404, 'not found');
      if ('forbidden' in blob) return error(res, 403, 'forbidden');
      return send(res, 200, blob.bytes, { 'content-type': blob.type });
    }
    if ((m = /^\/1\/threads\/([\w-]+)\/export\/xlsx$/.exec(path))) {
      const t = fx.threads[m[1] as string];
      if (!t) return error(res, 404, 'not found');
      return hasSheet(t) ? send(res, 200, XLSX_BYTES, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) : error(res, 400, 'thread has no spreadsheet');
    }
    if ((m = /^\/1\/threads\/([\w-]+)\/export\/pdf$/.exec(path))) {
      return fx.threads[m[1] as string]?.type === 'SLIDES' ? send(res, 200, new TextEncoder().encode('%PDF-1.4\n%slides\n'), { 'content-type': 'application/pdf' }) : error(res, 400, 'not a slide deck');
    }
    return error(res, 404, `no route for ${path}`);
  };
  const server = http.createServer((req, res) => (opts.delayMs ? void setTimeout(() => handle(req, res), opts.delayMs) : handle(req, res)));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    url: baseUrl,
    fixture: fx,
    requests,
    mutating: () => requests.filter((r) => r.method !== 'GET'),
    probeHits: () => requests.filter((r) => r.path.startsWith(PROBE_PREFIX)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
