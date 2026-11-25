// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AuthError, QuipClient, QuipHttpError, ReadOnlyViolation, assertReadOnly, type ClientEvent } from '../../src/core/quipClient';
import { virtualClock } from '../helpers/env';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Array<{ url: URL; init: RequestInit }> } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(handler: Handler, extra: Partial<ConstructorParameters<typeof QuipClient>[0]> = {}) {
  const clock = virtualClock();
  const f = fakeFetch(handler);
  const events: ClientEvent[] = [];
  const c = new QuipClient({
    token: 'secret-token',
    baseUrl: 'https://platform.quip.com',
    fetch: f.fetch,
    minIntervalMs: 0,
    sleep: clock.sleep,
    now: clock.now,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { c, clock, events, ...f };
}

describe('read-only guard', () => {
  const MUTATING = [
    '/1/threads/new-document',
    '/1/threads/edit-document',
    '/1/threads/delete',
    '/1/threads/add-members',
    '/1/threads/remove-members',
    '/1/threads/copy-document',
    '/1/threads/lock-edits',
    '/1/threads/live-paste',
    '/1/threads/new-chat',
    '/1/threads/edit-share-link-settings',
    '/1/messages/new',
    '/1/blob/THREADID0001',
    '/1/folders/new',
    '/1/folders/update',
    '/1/folders/add-members',
    '/1/folders/remove-members',
    '/1/users/update',
    '/1/oauth/access_token',
    '/1/oauth/revoke',
    '/2/threads/THREADID0001/copy',
    '/2/folders/FOLDERID0001/link-sharing-settings',
  ];

  it.each(MUTATING)('refuses %s even as a GET', (path) => {
    expect(() => assertReadOnly('GET', path)).toThrow(ReadOnlyViolation);
  });

  it('refuses every method other than GET on an otherwise allowed path', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(() => assertReadOnly(method, '/2/threads/ABCDEFGHIJK/html')).toThrow(ReadOnlyViolation);
    }
  });

  it('allows the read endpoints the exporter uses', () => {
    for (const path of [
      '/1/users/current',
      '/1/users/current/threads',
      '/1/users/',
      '/1/folders/',
      '/1/folders/ABCDEFGHIJK',
      '/2/threads/',
      '/2/threads/ABCDEFGHIJK',
      '/2/threads/ABCDEFGHIJK/html',
      '/1/messages/ABCDEFGHIJK',
      '/1/blob/ABCDEFGHIJK/BLOBID12345',
      '/1/threads/ABCDEFGHIJK/export/pdf',
    ]) {
      expect(() => assertReadOnly('GET', path)).not.toThrow();
    }
  });

  it('rejects identifiers that could smuggle a different path, before any request is made', async () => {
    const { c, calls } = client(() => json({}));
    await expect(c.getThreadHtml('../../1/threads/delete')).rejects.toThrow(RangeError);
    await expect(c.getThreadHtml('new')).rejects.toThrow(RangeError);
    await expect(c.getThread('add-members')).rejects.toThrow(RangeError);
    await expect(c.getBlob('ABCDEFGHIJK', 'a/b')).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('marks odd identifiers in API data as unreadable instead of aborting the run', async () => {
    const { c, calls } = client((url) => json({ ok123456789: { id: 'ok123456789', title: 'x', type: 'DOCUMENT' } }, 200, { 'x-test': url.search }));
    const res = await c.getThreads(['ok123456789', 'bad id', '../x']);
    expect(res.get('ok123456789')).toMatchObject({ ok: true });
    expect(res.get('bad id')).toMatchObject({ ok: false, status: 400 });
    expect(res.get('../x')).toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get('ids')).toBe('ok123456789');
  });

  it('only ever sends GET without a body, without cookies, and with the bearer token', async () => {
    const { c, calls } = client((url) => (url.pathname === '/1/users/current' ? json({ id: 'u1', name: 'Me' }) : json({ threads: {}, response_metadata: {} })));
    await c.currentUser();
    await c.listOwnedThreads();
    for (const { init } of calls) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.credentials).toBe('omit');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    }
  });

  it('requires https except for loopback test servers', () => {
    expect(() => new QuipClient({ token: 't', baseUrl: 'http://example.com' })).toThrow(/https/);
    expect(() => new QuipClient({ token: 't', baseUrl: 'http://127.0.0.1:8080' })).not.toThrow();
    expect(() => new QuipClient({ token: '   ' })).toThrow(/token/i);
  });
});

describe('rate limiting and errors', () => {
  it('waits for the quota to reset when Quip answers 503 with rate-limit headers, then retries', async () => {
    let n = 0;
    const { c, clock, events } = client(() => {
      n += 1;
      if (n === 1) return json({ error: 'slow down' }, 503, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(clock.now() / 1000) + 10) });
      return json({ id: 'u1', name: 'Me' });
    });
    await expect(c.currentUser()).resolves.toMatchObject({ id: 'u1' });
    expect(n).toBe(2);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
    expect(events.some((e) => e.type === 'throttle' && e.reason === 'rate-limit')).toBe(true);
  });

  it('honours Retry-After with a single abortable sleep and announces it once', async () => {
    let n = 0;
    const { c, clock, events } = client(() => (++n === 1 ? json({}, 429, { 'retry-after': '40' }) : json({ id: 'u1', name: 'Me' })));
    await c.currentUser();
    expect(clock.slept).toEqual([41_000]);
    expect(events.filter((e) => e.type === 'throttle')).toEqual([expect.objectContaining({ waitMs: 41_000, reason: 'rate-limit' })]);
  });

  it('after a response that spends the quota, delays the next request instead of provoking a 503', async () => {
    const { c, clock, calls } = client(() => json({ id: 'u1', name: 'Me' }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(clock.now() / 1000) + 5) }));
    await c.currentUser();
    expect(clock.slept).toHaveLength(0);
    await c.currentUser();
    expect(calls).toHaveLength(2);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5_000);
  });

  it('backs off exponentially on server errors and gives up after maxRetries', async () => {
    const { c, clock, calls } = client(() => json({ error: 'boom' }, 503), { maxRetries: 2 });
    await expect(c.currentUser()).rejects.toBeInstanceOf(QuipHttpError);
    expect(calls).toHaveLength(3);
    expect(clock.slept).toEqual([1000, 2000]);
  });

  it('retries network failures and surfaces a clear error', async () => {
    let n = 0;
    const { c } = client(() => {
      n += 1;
      throw new TypeError(`fetch failed (token secret-token) #${n}`);
    }, { maxRetries: 1 });
    const err = await c.currentUser().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain('secret-token');
    expect(n).toBe(2);
  });

  it('treats 401 as fatal (AuthError) without retrying', async () => {
    const { c, calls } = client(() => json({ error: 'Invalid access_token' }, 401));
    await expect(c.currentUser()).rejects.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(1);
  });

  it('never echoes the token in error messages', async () => {
    const { c } = client(() => new Response('upstream said: token secret-token is bad', { status: 400 }));
    const err = await c.getThreadHtml('ABCDEFGHIJK').catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('secret-token');
    expect(String((err as Error).message)).toContain('***');
  });

  it('stops promptly when aborted during a rate-limit wait', async () => {
    const controller = new AbortController();
    const { c } = client(() => json({}, 503, { 'retry-after': '30' }), {
      signal: controller.signal,
      sleep: () => {
        controller.abort();
        return Promise.reject(controller.signal.reason);
      },
    });
    await expect(c.currentUser()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('pagination and bulk helpers', () => {
  it('joins cursor pages of document HTML', async () => {
    const pages: Record<string, unknown> = {
      '': { html: '<p>one</p>', response_metadata: { next_cursor: 'c2' } },
      c2: { html: '<p>two</p>', response_metadata: { next_cursor: 'c3' } },
      c3: { html: '<p>three</p>', response_metadata: {} },
    };
    const { c, calls } = client((url) => json(pages[url.searchParams.get('cursor') ?? '']));
    await expect(c.getThreadHtml('ABCDEFGHIJK')).resolves.toBe('<p>one</p><p>two</p><p>three</p>');
    expect(calls).toHaveLength(3);
  });

  it('restarts once from the first page when a cursor is rejected mid-chain', async () => {
    let walk = 0;
    const { c, calls } = client((url) => {
      const cursor = url.searchParams.get('cursor');
      if (!cursor) {
        walk += 1;
        return json({ html: `<p>start${walk}</p>`, response_metadata: { next_cursor: `k${walk}` } });
      }
      return cursor === 'k1' ? json({ error: 'expired' }, 400) : json({ html: '<p>end</p>', response_metadata: {} });
    });
    await expect(c.getThreadHtml('ABCDEFGHIJK')).resolves.toBe('<p>start2</p><p>end</p>');
    expect(calls).toHaveLength(4);
  });

  it('pages through messages newest-first and returns them oldest-first without duplicates', async () => {
    const all = [1, 2, 3, 4, 5].map((i) => ({ id: `m${i}`, created_usec: i * 1000, text: `t${i}`, author_id: 'u1' }));
    const { c, calls } = client((url) => {
      const count = Number(url.searchParams.get('count'));
      const max = url.searchParams.get('max_created_usec');
      const list = all.filter((m) => (max ? m.created_usec <= Number(max) : true)).sort((a, b) => b.created_usec - a.created_usec).slice(0, count);
      return json(list);
    }, { messagePageSize: 2 });
    const msgs = await c.getMessages('ABCDEFGHIJK');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(calls).toHaveLength(3);
  });

  it('isolates one unreadable id by splitting a rejected bulk request', async () => {
    const { c, calls } = client((url) => {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      if (ids.includes('BADBADBAD01')) return json({ error: 'forbidden' }, 403);
      return json(Object.fromEntries(ids.map((id) => [id, { id, title: `T ${id}`, type: 'DOCUMENT' }])));
    });
    const res = await c.getThreads(['GOODGOOD001', 'BADBADBAD01', 'GOODGOOD002']);
    expect(res.get('GOODGOOD001')).toMatchObject({ ok: true });
    expect(res.get('GOODGOOD002')).toMatchObject({ ok: true });
    expect(res.get('BADBADBAD01')).toMatchObject({ ok: false, status: 403 });
    expect(calls.length).toBeGreaterThan(1);
  });

  it('reports ids Quip silently omits as not found', async () => {
    const { c } = client(() => json({ GOODGOOD001: { id: 'GOODGOOD001', title: 'x', type: 'DOCUMENT' } }));
    const res = await c.getThreads(['GOODGOOD001', 'MISSING0001']);
    expect(res.get('MISSING0001')).toMatchObject({ ok: false, status: 404 });
  });

  it('requests documents in batches of at most 100 and folders in batches of at most 50', async () => {
    const sizes: number[] = [];
    const { c } = client((url) => {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      sizes.push(ids.length);
      return json(Object.fromEntries(ids.map((id) => [id, {}])));
    });
    const ids = Array.from({ length: 230 }, (_, i) => `ID${String(i).padStart(9, '0')}`);
    await c.getThreads(ids);
    expect(sizes).toEqual([100, 100, 30]);
    sizes.length = 0;
    await c.getFolders(ids.slice(0, 120));
    expect(sizes).toEqual([50, 50, 20]);
  });
});
