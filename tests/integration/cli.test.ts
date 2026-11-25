// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, USAGE, type CliIo } from '../../src/node/cli';
import { F_PROJ, SITE, T_RENTAL_SECRET, TOKEN } from '../mock/fixture';
import { startMockQuip, type MockQuip } from '../mock/quipMock';
import { listTree, virtualClock } from '../helpers/env';

let mock: MockQuip;
let dir: string;
let clock: ReturnType<typeof virtualClock>;

beforeEach(async () => {
  clock = virtualClock();
  mock = await startMockQuip({ now: clock.now });
  dir = await mkdtemp(join(tmpdir(), 'quip-cli-test-'));
});

afterEach(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string[];
  err: string[];
  all: string;
}

async function run(args: string[], env: Record<string, string | undefined> = { QUIP_TOKEN: TOKEN }, stdin = ''): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), readStdin: () => Promise.resolve(stdin) };
  const code = await main(args, env, io, { baseUrl: mock.url, client: { minIntervalMs: 0, sleep: clock.sleep, now: clock.now, messagePageSize: 2 } });
  return { code, out, err, all: [...out, ...err].join('\n') };
}

const visible = async (): Promise<string[]> => (await listTree(dir)).filter((p) => !p.startsWith('.'));

describe('exporting an account', () => {
  it('uses the same defaults as the extension page: default folders, unfiled documents, spreadsheets, raw archive', async () => {
    const r = await run(['--out', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Connected as Jane Doe (acme.quip.com).');
    expect(r.all).toMatch(/Done\. 9 saved, 0 unchanged, 0 failed of 9 documents\./);
    const tree = await visible();
    expect(tree).toEqual(expect.arrayContaining(['Private/Rental Records.md', 'Private/Rental Records.xlsx', 'Private/Projects/Project Plan.md', '_Unfiled/Loose note.md', '_Quip export report.md']));
    expect(await readFile(join(dir, 'Private/Projects/Project Plan.md'), 'utf8')).toContain('**Kanban board**');
    expect((await listTree(dir)).some((p) => p.startsWith('.quip-raw/'))).toBe(true);
    expect(mock.mutating()).toEqual([]);
  });

  it('never prints the token', async () => {
    const r = await run(['--out', dir, '--limit', '2']);
    expect(r.all).not.toContain(TOKEN);
  });

  it('skips what is already exported on a second run', async () => {
    await run(['--out', dir]);
    const again = await run(['--out', dir]);
    expect(again.all).toMatch(/Done\. 0 saved, 9 unchanged, 0 failed of 9 documents\./);
    expect((await run(['--out', dir, '--force'])).all).toMatch(/9 saved/);
  });

  it('can leave things out', async () => {
    const r = await run(['--out', dir, '--no-comments', '--no-raw', '--no-xlsx', '--no-unfiled']);
    expect(r.code).toBe(0);
    const tree = await listTree(dir);
    expect(tree.some((p) => p.startsWith('.quip-raw/') || p.endsWith('.xlsx') || p.startsWith('_Unfiled/'))).toBe(false);
    expect(await readFile(join(dir, 'Private/Rental Records.md'), 'utf8')).not.toContain('Comments and conversation');
  });

  it('limits the number of documents for a trial run', async () => {
    const r = await run(['--out', dir, '--limit', '2']);
    expect(r.all).toMatch(/2 saved, 0 unchanged, 0 failed of 2 documents\./);
    expect((await visible()).filter((p) => p.endsWith('.md') && !p.startsWith('_Quip'))).toHaveLength(2);
  });

  it('scans without writing anything or downloading a document', async () => {
    const r = await run(['--out', dir, '--scan-only']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('9 documents in 5 folders would be exported.');
    expect(r.out).toContain('Nothing was written.');
    expect(await listTree(dir)).toEqual([]);
    expect(mock.requests.some((q) => /\/html$/.test(q.path))).toBe(false);
  });
});

describe('exporting one page', () => {
  it('--from a document exports just that document, and not the unfiled ones', async () => {
    const r = await run(['--out', dir, '--from', `${SITE}/${T_RENTAL_SECRET}/Rental-Records`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Exporting the document "Rental Records".');
    expect(r.all).toMatch(/Done\. 1 saved/);
    expect((await visible()).filter((p) => p.endsWith('.md') && !p.startsWith('_Quip'))).toEqual(['Rental Records.md']);
  });

  it('--from a folder exports everything inside it', async () => {
    const r = await run(['--out', dir, '--from', `${SITE}/${F_PROJ}/Projects`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Exporting the folder "Projects" and everything inside it.');
    expect(r.all).toMatch(/Done\. 3 saved/);
    expect((await visible()).filter((p) => p.endsWith('.md') && !p.startsWith('_Quip')).sort()).toEqual(['Projects/Budget.md', 'Projects/Pitch deck.md', 'Projects/Project Plan.md']);
  });

  it('explains a page it cannot use, without exporting anything', async () => {
    const r = await run(['--out', dir, '--from', 'https://example.com/nothing']);
    expect(r.code).toBe(2);
    expect(r.err.join(' ')).toContain('is not a Quip document or folder address');
    const missing = await run(['--out', dir, '--from', `${SITE}/AbCdEfGhIjKl/Nothing-Here`]);
    expect(missing.code).toBe(2);
    expect(missing.err.join(' ')).toContain('cannot be read with this token (HTTP 404)');
    expect(await visible()).toEqual([]);
  });
});

describe('tokens and arguments', () => {
  it('reads the token from standard input', async () => {
    const r = await run(['--out', dir, '--token-stdin', '--limit', '1'], {}, `${TOKEN}\n`);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/1 saved/);
    expect(r.all).not.toContain(TOKEN);
  });

  it('asks for a token instead of calling Quip without one', async () => {
    const r = await run(['--out', dir], {});
    expect(r.code).toBe(2);
    expect(r.err.join(' ')).toContain('No token');
    expect(mock.requests).toHaveLength(0);
  });

  it('reports a rejected token and writes nothing', async () => {
    const r = await run(['--out', dir], { QUIP_TOKEN: 'not-the-token' });
    expect(r.code).toBe(3);
    expect(r.err.join(' ')).toContain('Quip rejected the access token');
    expect(r.all).not.toContain('not-the-token');
    expect(await listTree(dir)).toEqual([]);
  });

  it('rejects bad arguments with the usage text, and never exports into the home folder', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['--out'])).code).toBe(2);
    expect((await run(['--out', dir, '--limit', 'abc'])).code).toBe(2);
    expect((await run(['--out', dir, '--limit', '0'])).code).toBe(2);
    expect((await run(['--out', dir, '--nonsense'])).code).toBe(2);
    expect((await run(['--out', homedir()])).err.join(' ')).toContain('Choose a folder of its own');
    expect((await run(['--out', '/'])).code).toBe(2);
    expect(mock.requests).toHaveLength(0);
  });

  it('prints the usage for --help', async () => {
    const r = await run(['--help'], {});
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toBe(USAGE);
  });
});
