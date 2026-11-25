// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportEvent, ExportOptions, ExportSummary } from '../../src/core/exporter';
import { AuthError, READ_ONLY_ENDPOINTS } from '../../src/core/quipClient';
import { createSession } from '../../src/core/session';
import {
  ANN,
  B_OK,
  F_ARCH,
  F_DESK,
  F_LOCKED,
  F_PRIV,
  F_PROJ,
  F_SHARED,
  F_STAR,
  F_TRASH,
  ME,
  PNG_1X1,
  SITE,
  T_LOOSE,
  T_PLAN,
  T_RENTAL,
  TOKEN,
  XLSX_BYTES,
} from '../mock/fixture';
import { startMockQuip, type MockOptions, type MockQuip } from '../mock/quipMock';
import { NodeFsSink, listTree, parseHtml, virtualClock } from '../helpers/env';

interface Ctx {
  mock: MockQuip;
  dir: string;
  clock: ReturnType<typeof virtualClock>;
}

let ctx: Ctx;
const open: MockQuip[] = [];
const dirs: string[] = [];

/** Every top-level folder of the mock account that holds documents, as the extension reports them (Starred is a view, so it is left out). */
const ALL_ROOTS = [F_PRIV, F_DESK, F_SHARED, F_ARCH, F_TRASH];

async function setup(mockOptions: MockOptions = {}): Promise<Ctx> {
  const clock = virtualClock();
  const mock = await startMockQuip({ now: clock.now, ...mockOptions });
  const dir = await mkdtemp(join(tmpdir(), 'quip-md-test-'));
  open.push(mock);
  dirs.push(dir);
  return { mock, dir, clock };
}

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((m) => m.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeSession(options: Partial<ExportOptions> = {}, extra: { onEvent?: (e: ExportEvent) => void; signal?: AbortSignal; token?: string } = {}, c: Ctx = ctx) {
  return createSession({
    token: extra.token ?? TOKEN,
    baseUrl: c.mock.url,
    sink: new NodeFsSink(c.dir),
    parseHtml,
    options: { rootIds: [F_PRIV, F_DESK, F_SHARED], allRootIds: ALL_ROOTS, ownerId: ME.id, siteUrl: SITE, timeZone: 'UTC', ...options },
    client: { minIntervalMs: 0, sleep: c.clock.sleep, now: c.clock.now, messagePageSize: 2 },
    ...(extra.onEvent ? { onEvent: extra.onEvent } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
}

const read = (rel: string, c: Ctx = ctx): Promise<string> => readFile(join(c.dir, rel), 'utf8');
const visible = async (c: Ctx = ctx): Promise<string[]> => (await listTree(c.dir)).filter((p) => !p.startsWith('.'));
const notes = async (c: Ctx = ctx): Promise<string[]> => (await visible(c)).filter((p) => p.endsWith('.md') && !p.startsWith('_Quip'));
const requestsTo = (pattern: RegExp, c: Ctx = ctx): number => c.mock.requests.filter((r) => pattern.test(r.path)).length;

async function runAll(options: Partial<ExportOptions> = {}, c: Ctx = ctx): Promise<ExportSummary> {
  return makeSession(options, {}, c).exporter.run();
}

describe('full export', () => {
  it('replicates the Quip folder tree as Markdown files, including empty folders, attachments and spreadsheets', async () => {
    const summary = await runAll();
    expect(await visible()).toEqual([
      'Desktop/',
      'Private/',
      'Private/Notes.md',
      'Private/Projects/',
      'Private/Projects/Budget.md',
      'Private/Projects/Budget.xlsx',
      'Private/Projects/Pitch deck.md',
      'Private/Projects/Pitch deck.pdf',
      'Private/Projects/Project Plan.md',
      'Private/Q3-Q4 - plan - final.md',
      'Private/Rental Records.md',
      'Private/Rental Records.xlsx',
      'Private/notes (2).md',
      'Team Shared/',
      'Team Shared/Shared doc.md',
      '_Quip export report.md',
      '_Unfiled/',
      '_Unfiled/Loose note.md',
      '_attachments/',
      '_attachments/PLANthread1/',
      '_attachments/PLANthread1/BLOBok00001.png',
      '_attachments/PLANthread1/spec.pdf',
      '_attachments/tRENTALthr1/',
      '_attachments/tRENTALthr1/receipt.pdf',
    ]);
    expect(summary).toMatchObject({ stopReason: 'completed', aborted: false, docs: { planned: 9, exported: 9, skipped: 0, failed: 0, notAttempted: 0, slides: 1 }, folders: 4, comments: 6 });
    expect(summary.unreadableFolders).toEqual([{ id: 'fLOCKED0001', status: 403 }]);
  });

  it('writes a document once, under its first folder, and records the other folders in the front matter', async () => {
    await runAll();
    const note = await read('Private/Rental Records.md');
    expect(note.startsWith('---\n')).toBe(true);
    expect(note).toContain('title: "Rental Records"');
    expect(note).toContain('quip_id: "tRENTALthr1"');
    expect(note).toContain('quip_url: "https://acme.quip.com/tRENTALthr1v"');
    expect(note).toContain('quip_type: "document"');
    expect(note).toContain('author: "Jane Doe"');
    expect(note).toContain('folder: "Private"');
    expect(note).toContain('also_in:\n  - "Desktop"');
    expect(note).toContain('embeds:\n  - "spreadsheet"');
    expect(await visible()).not.toContain('Desktop/Rental Records.md');
  });

  it('keeps one title heading, converts the spreadsheet, lists and inline formatting', async () => {
    await runAll();
    const note = await read('Private/Rental Records.md');
    expect(note.match(/^# Rental Records$/gm)).toHaveLength(1);
    expect(note).toContain('Paid by **bank transfer** unless noted.');
    expect(note).toContain('**Rent**\n\n| Month | Rent | Paid |\n| --- | --- | --- |\n| Jan 2021 | 1,200 | Yes |\n| Feb 2021 | 1,200 | No \\| late |');
    expect(note).toContain('### Notes\n\n- Deposit returned in *March*\n- Agreement renewed\n  - Until 2022\n\n1. First step\n2. Second step');
  });

  it("keeps Quip's own XLSX next to notes with spreadsheets, because HTML cannot hold formulas", async () => {
    await runAll();
    expect(new Uint8Array(await readFile(join(ctx.dir, 'Private/Rental Records.xlsx')))).toEqual(XLSX_BYTES);
    expect(await read('Private/Rental Records.md')).toContain('> Original spreadsheet with its formulas: [Rental Records.xlsx](Rental%20Records.xlsx)');
    expect(await read('Private/Projects/Budget.md')).toContain('[Budget.xlsx](Budget.xlsx)');
    expect(requestsTo(/\/export\/xlsx$/)).toBe(2); // only documents that contain spreadsheets
    expect(await read('Private/Projects/Project Plan.md')).not.toContain('.xlsx');
  });

  it('converts calendar, Kanban board and project tracker live apps', async () => {
    await runAll();
    const note = await read('Private/Projects/Project Plan.md');
    expect(note).toContain('**Calendar** (2021-10)\n\n| Date | Event | Color |\n| --- | --- | --- |\n| 2021-10-04 → 2021-10-06 | Kickoff Meeting | green |\n| 2021-10-18 | Project Status | red |');
    expect(note).toContain('**Kanban board**\n\n- **To Do**\n  - First Card\n- **Done**\n  - Third Card');
    expect(note).toContain('**Project tracker**\n\n| Project | Owner | Status | Deadline |\n| --- | --- | --- | --- |\n| Launch | Ann Lee | In Progress | 2020-11-18 |');
    expect(note).toContain('- [x] Kick-off done\n- [ ] Write the report');
    expect(note).toContain('embeds:\n  - "calendar"\n  - "kanban"\n  - "project_tracker"');
  });

  it('renders each sheet of a standalone spreadsheet and gives it a title', async () => {
    await runAll();
    const note = await read('Private/Projects/Budget.md');
    expect(note).toContain('quip_type: "spreadsheet"');
    expect(note).toContain('# Budget\n\n## Budget\n\n| Item | Cost |\n| --- | --- |\n| Desk | 300 |\n\n## Forecast\n\n| Q1 | 10 |');
  });

  it('adds a heading when the document has none, escaping the title', async () => {
    await runAll();
    const note = await read('Private/Q3-Q4 - plan - final.md');
    expect(note).toContain('title: "Q3/Q4: plan? <final>"');
    expect(note).toContain('\n# Q3/Q4: plan? \\<final>\n\nno heading in this one');
  });

  it('keeps colliding names apart even on case-insensitive file systems', async () => {
    await runAll();
    expect(await read('Private/Notes.md')).toContain('first');
    expect(await read('Private/notes (2).md')).toContain('second');
  });

  it('turns slides into a stub that links to a PDF copy', async () => {
    await runAll();
    const note = await read('Private/Projects/Pitch deck.md');
    expect(note).toContain('quip_type: "slides"');
    expect(note).toContain('[Open the PDF copy](Pitch%20deck.pdf)');
    expect((await readFile(join(ctx.dir, 'Private/Projects/Pitch deck.pdf'), 'utf8')).startsWith('%PDF')).toBe(true);
  });

  it('exports comments with authors, anchors, mentions, document links and attachments, across message pages', async () => {
    await runAll();
    const note = await read('Private/Rental Records.md');
    expect(note).toContain('## Comments and conversation');
    expect(note).toContain('> **Ann Lee** · 2021-02-03 11:00 UTC\n> Looks right to me.');
    expect(note).toContain('> cc @Jane Doe');
    expect(note).toContain('· *on highlighted text*\n> Anchored remark\n> second line');
    expect(note).toContain('> 📎 [receipt.pdf](../_attachments/tRENTALthr1/receipt.pdf)');
    expect(note).toContain('> 1\\. not a list');
    expect(requestsTo(/^\/1\/messages\//)).toBeGreaterThan(8); // 6 messages at 2 per page needs several requests for one doc
  });

  it('looks up people mentioned only in a comment and links comment URLs to exported notes', async () => {
    await runAll();
    expect(await read('Private/Rental Records.md')).toContain('> ping @Bob Stone and see [Project Plan](Projects/Project%20Plan.md)');
  });

  it('resolves links between documents, keeps the original URL for links that leave the export, and flags them', async () => {
    const summary = await runAll();
    const plan = await read('Private/Projects/Project Plan.md');
    expect(plan).toContain('[Rental Records](../Rental%20Records.md)');
    expect(plan).toContain('[a doc outside the export](https://acme.quip.com/zZ9yY8xX7wWv/Elsewhere)');
    expect(summary.unresolvedLinks).toEqual(['zZ9yY8xX7wWv']);
    expect(await read('_Quip export report.md')).toContain('`zZ9yY8xX7wWv`');
  });

  it('shows @mentions of people as plain text rather than dead Quip links', async () => {
    await runAll();
    const note = await read('Team Shared/Shared doc.md');
    expect(note).toContain('Hello @Ann.');
    expect(note).not.toContain('uANN0000001');
  });

  it('downloads images and files, and marks the ones Quip refuses', async () => {
    const summary = await runAll();
    const plan = await read('Private/Projects/Project Plan.md');
    expect(plan).toContain('![architecture](../../_attachments/PLANthread1/BLOBok00001.png)');
    expect(plan).toContain('[spec.pdf](../../_attachments/PLANthread1/spec.pdf)');
    expect(plan).toContain('*[missing image: lost chart]*');
    expect(new Uint8Array(await readFile(join(ctx.dir, '_attachments/PLANthread1/BLOBok00001.png')))).toEqual(PNG_1X1);
    expect(summary.attachments).toEqual({ saved: 3, reused: 0, missing: 1 });
    expect(summary.warnings['attachment-missing']?.examples[0]).toContain('HTTP 403');
  });

  it('archives the original HTML, metadata and messages next to the Markdown', async () => {
    await runAll();
    expect(await read('.quip-raw/PLANthread1/body.html')).toContain("data-live-app-id='AbNBjAC13no'");
    expect(JSON.parse(await read('.quip-raw/PLANthread1/thread.json'))).toMatchObject({ meta: { id: 'PLANthread1', title: 'Project Plan' } });
    expect(JSON.parse(await read(`.quip-raw/${T_RENTAL}/messages.json`))).toHaveLength(6);
  });

  it('writes a report that tallies embeds and lists what needs attention', async () => {
    await runAll();
    const report = await read('_Quip export report.md');
    expect(report).toContain('- Status: Finished');
    expect(report).toContain('- Documents: 9 exported, 0 unchanged since the last run, 0 failed (of 9)');
    expect(report).toContain('- calendar: 1');
    expect(report).toContain('- kanban: 1');
    expect(report).toContain('- project_tracker: 1');
    expect(report).toContain('- Folder `fLOCKED0001` (HTTP 403)');
    expect(report).toContain('attachment-missing');
  });

  it('adds a note and front matter for documents Quip has already moved elsewhere', async () => {
    const moved = await setup();
    const loose = moved.mock.fixture.threads[T_LOOSE];
    if (loose) loose.movedTo = 'https://slack.example/canvas/1';
    await runAll({}, moved);
    const note = await read('_Unfiled/Loose note.md', moved);
    expect(note).toContain('moved_to: "https://slack.example/canvas/1"');
    expect(note).toContain('# Loose note\n\n> [!info] This Quip document was moved to https://slack.example/canvas/1');
  });
});

describe('read-only guarantee', () => {
  it('sends only authenticated GET requests, and only to allow-listed endpoints', async () => {
    await runAll();
    expect(ctx.mock.requests.length).toBeGreaterThan(20);
    expect(ctx.mock.mutating()).toEqual([]);
    for (const r of ctx.mock.requests) {
      expect(r.auth).toBe(`Bearer ${TOKEN}`);
      expect(READ_ONLY_ENDPOINTS.some((re) => re.test(r.path))).toBe(true);
    }
  });
});

describe('scope and options', () => {
  it('scans without writing anything or downloading document bodies', async () => {
    const { exporter } = makeSession();
    const plan = await exporter.scan();
    expect(plan.threads.map((t) => t.path)).toContain('Private/Rental Records.md');
    expect(plan.estimatedRequests).toBeGreaterThan(9);
    expect(await listTree(ctx.dir)).toEqual([]);
    expect(requestsTo(/\/html$/)).toBe(0);
  });

  it('can leave out comments, the raw archive, spreadsheets sidecars and unfiled documents', async () => {
    await runAll({ includeComments: false, keepRaw: false, saveXlsx: false, includeUnfiled: false });
    const tree = await listTree(ctx.dir);
    expect(tree.some((p) => p.startsWith('.quip-raw'))).toBe(false);
    expect(tree.some((p) => p.endsWith('.xlsx'))).toBe(false);
    expect(tree).not.toContain('_Unfiled/Loose note.md');
    expect(await read('Private/Rental Records.md')).not.toContain('Comments and conversation');
    expect(requestsTo(/^\/1\/messages\//)).toBe(0);
    expect(requestsTo(/\/export\/xlsx$/)).toBe(0);
  });

  it('limits the number of documents for a trial run', async () => {
    const summary = await runAll({ maxDocs: 2 });
    expect(summary.docs.planned).toBe(2);
    expect((await notes()).filter((p) => !p.startsWith('_'))).toHaveLength(2);
  });

  it('exports a single document by id, with links to everything else pointing back to Quip as written', async () => {
    const summary = await runAll({ rootIds: [], threadIds: [T_PLAN], includeUnfiled: false });
    expect(summary.docs.exported).toBe(1);
    const note = await read('Project Plan.md');
    expect(note).toContain('[Rental Records](https://acme.quip.com/tRENTALthr1v/Rental-Records#temp:C:abc)');
    expect(note).not.toContain('folder:');
  });

  it('exports only documents the user wrote that sit in no folder anywhere, never other people\'s or trashed ones', async () => {
    const summary = await runAll();
    const unfiled = (await visible()).filter((p) => p.startsWith('_Unfiled/'));
    expect(unfiled).toEqual(['_Unfiled/', '_Unfiled/Loose note.md']);
    expect(await notes()).not.toContain('_Unfiled/Deleted draft.md'); // in Trash: it is in a folder, just not a selected one
    expect(summary.othersUnfiled).toBe(2); // Ann's directly shared document and her document in a folder the user does not list
    expect(await read('_Quip export report.md')).toContain('2 documents written by other people');
  });

  it('refuses to guess ownership: without the signed-in user, unfiled documents are skipped', async () => {
    const events: ExportEvent[] = [];
    const summary = await makeSession({ ownerId: undefined }, { onEvent: (e) => events.push(e) }).exporter.run();
    expect(summary.docs.planned).toBe(8);
    expect(events.some((e) => e.type === 'log' && e.level === 'warn' && /unfiled/i.test(e.message))).toBe(true);
  });
});

describe('never overwriting what this tool did not create', () => {
  it('leaves an existing unrelated note alone and writes the Quip document beside it', async () => {
    await mkdir(join(ctx.dir, 'Private'), { recursive: true });
    await writeFile(join(ctx.dir, 'Private/Notes.md'), 'MY OWN NOTES, NOT FROM QUIP');
    await runAll();
    expect(await read('Private/Notes.md')).toBe('MY OWN NOTES, NOT FROM QUIP');
    expect(await read('Private/Notes (2).md')).toContain('quip_id: "NOTESthrdA1"');
    expect(await read('Private/notes (3).md')).toContain('quip_id: "NOTESthrdB1"');
  });

  it('leaves an existing unrelated attachment alone', async () => {
    await mkdir(join(ctx.dir, '_attachments/PLANthread1'), { recursive: true });
    await writeFile(join(ctx.dir, `_attachments/PLANthread1/${B_OK}.png`), 'MY OWN FILE');
    await runAll();
    expect(await read(`_attachments/PLANthread1/${B_OK}.png`)).toBe('MY OWN FILE');
    expect(new Uint8Array(await readFile(join(ctx.dir, `_attachments/PLANthread1/${B_OK} (2).png`)))).toEqual(PNG_1X1);
    expect(await read('Private/Projects/Project Plan.md')).toContain(`![architecture](../../_attachments/PLANthread1/${B_OK}%20%282%29.png)`);
  });

  it('recognises its own earlier note by quip_id, so lost state does not create duplicates', async () => {
    await runAll();
    const before = await notes();
    await rm(join(ctx.dir, '.quip-md-export'), { recursive: true });
    const again = await runAll();
    expect(again.docs.exported).toBe(9);
    expect(await notes()).toEqual(before);
  });

  it('never lets a Quip document or folder take a name the tool itself uses', async () => {
    const odd = await setup();
    const loose = odd.mock.fixture.threads[T_LOOSE];
    if (loose) loose.title = '_Quip export report';
    const priv = odd.mock.fixture.folders[F_PRIV];
    if (priv) priv.title = '_attachments';
    await runAll({ rootIds: [F_PRIV], threadIds: [T_LOOSE], includeUnfiled: false }, odd);
    const tree = await visible(odd);
    expect(tree).toContain('_Quip export report (2).md');
    expect(await read('_Quip export report.md', odd)).toMatch(/^# Quip export report\n/);
    expect(tree).toContain('_attachments (2)/');
    expect(tree).toContain('_attachments/PLANthread1/BLOBok00001.png');
  });
});

describe('never overwriting, checked again on every run', () => {
  it('keeps an existing report that is not its own, and writes its report beside it', async () => {
    await writeFile(join(ctx.dir, '_Quip export report.md'), 'MY OWN REPORT');
    const first = await runAll();
    expect(first.reportPath).toBe('_Quip export report (2).md');
    expect(await read('_Quip export report.md')).toBe('MY OWN REPORT');
    expect(await read('_Quip export report (2).md')).toMatch(/^# Quip export report\n/);

    const second = await runAll();
    expect(second.reportPath).toBe('_Quip export report (2).md'); // its own report is recognised and updated in place
    expect(await read('_Quip export report.md')).toBe('MY OWN REPORT');
    expect(await read('_Quip export report (2).md')).toContain('9 unchanged since the last run');
  });

  it('leaves a file that replaced one of its notes alone, and writes the note to a new name', async () => {
    await runAll();
    await writeFile(join(ctx.dir, 'Private/Notes.md'), 'MY OWN NOTES REPLACED THE EXPORTED ONE');
    const again = await runAll();
    expect(await read('Private/Notes.md')).toBe('MY OWN NOTES REPLACED THE EXPORTED ONE');
    expect(again.docs.exported).toBe(1);
    expect(again.relocated).toEqual([expect.objectContaining({ id: 'NOTESthrdA1', from: 'Private/Notes.md', to: 'Private/Notes (3).md' })]);
    expect(await read('Private/Notes (3).md')).toContain('quip_id: "NOTESthrdA1"');
    expect((await runAll()).docs).toMatchObject({ exported: 0, skipped: 9 }); // and the new name is stable
  });

  it('checks once more just before writing, so a file that appears after the scan is not replaced either', async () => {
    const events: ExportEvent[] = [];
    const late = (e: ExportEvent): void => {
      events.push(e);
      if (e.type === 'phase' && e.phase === 'export') {
        mkdirSync(join(ctx.dir, 'Private'), { recursive: true });
        writeFileSync(join(ctx.dir, 'Private/Notes.md'), 'APPEARED AFTER THE SCAN');
      }
    };
    const summary = await makeSession({}, { onEvent: late }).exporter.run();
    expect(summary.docs).toMatchObject({ exported: 9, failed: 0 });
    expect(await read('Private/Notes.md')).toBe('APPEARED AFTER THE SCAN');
    expect(await read('Private/Notes (3).md')).toContain('quip_id: "NOTESthrdA1"');
    expect(events.some((e) => e.type === 'log' && e.level === 'warn' && /appeared/.test(e.message))).toBe(true);
    expect((await runAll()).docs).toMatchObject({ exported: 0, skipped: 9 });
  });

  it('does not take over a file whose name it merely remembers from its state', async () => {
    await runAll();
    await rm(join(ctx.dir, 'Private/Rental Records.xlsx'));
    await writeFile(join(ctx.dir, 'Private/Rental Records.md'), 'NOT A QUIP NOTE'); // the note itself was replaced
    const again = await runAll();
    expect(await read('Private/Rental Records.md')).toBe('NOT A QUIP NOTE');
    expect(await read('Private/Rental Records (2).md')).toContain('quip_id: "tRENTALthr1"');
    expect(again.docs.exported).toBe(2); // the note, and the plan that links to it, so that link follows the note to its new name
    expect(await read('Private/Projects/Project Plan.md')).toContain('[Rental Records](../Rental%20Records%20%282%29.md)');
  });
});

describe('resuming with missing pieces', () => {
  it('fetches again an attachment or spreadsheet copy that was deleted, instead of skipping its note', async () => {
    await runAll();
    await rm(join(ctx.dir, '_attachments/PLANthread1/BLOBok00001.png'));
    await rm(join(ctx.dir, 'Private/Rental Records.xlsx'));
    const again = await runAll();
    expect(again.docs).toMatchObject({ exported: 2, skipped: 7 });
    expect(new Uint8Array(await readFile(join(ctx.dir, '_attachments/PLANthread1/BLOBok00001.png')))).toEqual(PNG_1X1);
    expect(new Uint8Array(await readFile(join(ctx.dir, 'Private/Rental Records.xlsx')))).toEqual(XLSX_BYTES);
    expect((await runAll()).docs.exported).toBe(0);
  });

  it('keeps a failed forced re-export marked, so a normal run afterwards does not treat the old copy as current', async () => {
    let failing = false;
    const flaky = await setup({ override: (req) => (failing && req.path === '/2/threads/NOTESthrdA1/html' ? { status: 500 } : undefined) });
    await runAll({}, flaky);
    failing = true;
    const forced = await runAll({ skipUnchanged: false }, flaky);
    expect(forced.docs).toMatchObject({ exported: 8, failed: 1 });
    failing = false;
    const next = await runAll({}, flaky);
    expect(next.docs).toMatchObject({ exported: 1, skipped: 8, failed: 0 });
  });

  it('turning the raw archive off does not re-export anything', async () => {
    await runAll({ keepRaw: true });
    expect((await runAll({ keepRaw: false })).docs).toMatchObject({ exported: 0, skipped: 9 });
  });
});

describe('attachments shared by several notes', () => {
  it('reports a failed download on every note that uses it, and retries all of them', async () => {
    let failing = true;
    const shared = await setup({ override: (req) => (failing && req.path === `/1/blob/${T_PLAN}/${B_OK}` ? { status: 500 } : undefined) });
    for (const id of ['NOTESthrdA1', 'NOTESthrdB1']) {
      const doc = shared.mock.fixture.threads[id];
      if (doc) doc.pages = [`${doc.pages[0]}<div data-section-style='11'><img src='/blob/${T_PLAN}/${B_OK}' alt='shared'/></div>`];
    }
    const first = await runAll({}, shared);
    expect(first.warnings['attachment-missing']?.count).toBe(4); // Project Plan twice (this image and the refused one), then both notes
    expect(await read('Private/Notes.md', shared)).toContain('*[missing image: shared]*');
    expect(await read('Private/notes (2).md', shared)).toContain('*[missing image: shared]*');

    failing = false;
    const second = await runAll({}, shared);
    expect(second.docs).toMatchObject({ exported: 3, skipped: 6 }); // all three were marked for retry, not just the first
    expect(await read('Private/Notes.md', shared)).toContain('![shared](../_attachments/PLANthread1/BLOBok00001.png)');
    expect(await read('Private/notes (2).md', shared)).toContain('![shared](../_attachments/PLANthread1/BLOBok00001.png)');
    expect((await runAll({}, shared)).docs.exported).toBe(0);
  });
});

describe('documents in no folder', () => {
  it('exports a document you wrote that is only starred, because Starred is a view and not a place', async () => {
    const starred = await setup();
    const loose = starred.mock.fixture.threads[T_LOOSE];
    if (!loose) throw new Error('fixture changed');
    starred.mock.fixture.threads.STARONLYth01 = { ...loose, id: 'STARONLYth01', title: 'Starred only' };
    starred.mock.fixture.owned.push('STARONLYth01');
    starred.mock.fixture.folders[F_STAR]?.children.push({ thread_id: 'STARONLYth01' });
    await runAll({}, starred);
    expect(await visible(starred)).toContain('_Unfiled/Starred only.md');
  });

  it('lists folders outside the selection that could not be read, because their documents may then look unfiled', async () => {
    const summary = await runAll({ rootIds: [F_PRIV], allRootIds: [F_PRIV, F_LOCKED] });
    expect(summary.docs.failed).toBe(0);
    const report = await read('_Quip export report.md');
    expect(report).toContain('- Folder `fLOCKED0001`, outside your selection (HTTP 403)');
    expect(report).toContain('a document you wrote there can appear under the unfiled directory');
  });

  it('reports a document it listed as unfiled but could not read', async () => {
    const odd = await setup({ override: (req) => (req.path === '/2/threads/' && req.query.ids?.includes('GHOSTthrd001') ? { status: 403 } : undefined) });
    const loose = odd.mock.fixture.threads[T_LOOSE];
    if (!loose) throw new Error('fixture changed');
    odd.mock.fixture.threads.GHOSTthrd001 = { ...loose, id: 'GHOSTthrd001', title: 'Ghost' };
    odd.mock.fixture.owned.push('GHOSTthrd001');
    const summary = await runAll({}, odd);
    expect(summary.unreadableThreads).toContainEqual({ id: 'GHOSTthrd001', status: 403, folderPath: '_Unfiled' });
    expect(await read('_Quip export report.md', odd)).toContain('Document `GHOSTthrd001` in _Unfiled (HTTP 403)');
  });
});

describe('downloads that are not what they claim to be', () => {
  it('does not save or link a spreadsheet copy that is not a workbook', async () => {
    const bad = await setup({ override: (req) => (req.path === `/1/threads/${T_RENTAL}/export/xlsx` ? { status: 200, body: { note: 'definitely not a workbook' } } : undefined) });
    const summary = await runAll({}, bad);
    expect(summary.warnings['xlsx-failed']).toBeDefined();
    expect(await visible(bad)).not.toContain('Private/Rental Records.xlsx');
    expect(await read('Private/Rental Records.md', bad)).not.toContain('.xlsx');
  });

  it('treats an error object delivered with a 200 as a failure', async () => {
    const bad = await setup({ override: (req) => (req.path === `/1/threads/${T_RENTAL}/export/xlsx` ? { status: 200, body: { error: 'application_error', error_code: 404, error_description: 'No such file' } } : undefined) });
    const summary = await runAll({}, bad);
    expect(summary.warnings['xlsx-failed']?.examples.join(' ')).toContain('HTTP 200');
    expect(await visible(bad)).not.toContain('Private/Rental Records.xlsx');
  });
});

describe('comments Quip will not list in full', () => {
  it('says so when more comments share one timestamp than a page holds', async () => {
    const tied = await setup();
    const doc = tied.mock.fixture.threads.NOTESthrdA1;
    if (doc) doc.messages = ['a', 'b', 'c'].map((id) => ({ id: `tie${id}`, author_id: ANN.id, author_name: ANN.name, created_usec: 5_000_000, text: `comment ${id}` }));
    const summary = await runAll({}, tied);
    expect(summary.warnings['comments-incomplete']).toBeDefined();
  });
});

describe('dates that depend on the time zone', () => {
  it('re-renders only documents with a project tracker when the time zone changes, and flags a guessed day', async () => {
    const first = await runAll({ timeZone: 'UTC' });
    expect(first.warnings['ambiguous-date']).toBeDefined(); // 08:00 UTC is midnight in Los Angeles, not in UTC
    expect((await runAll({ timeZone: 'UTC' })).docs).toMatchObject({ exported: 0, skipped: 9 });

    const moved = await runAll({ timeZone: 'America/Los_Angeles' });
    expect(moved.docs).toMatchObject({ exported: 1, skipped: 8 });
    expect(moved.warnings['ambiguous-date']).toBeUndefined();
    expect(await read('Private/Projects/Project Plan.md')).toContain('2020-11-18');
  });
});

describe('where documents end up', () => {
  it('lets the first root claim a document, even when it is nested deeper than a later root\'s copy', async () => {
    const dup = await setup();
    dup.mock.fixture.folders[F_DESK]?.children.push({ thread_id: T_PLAN });
    await runAll({ rootIds: [F_PRIV, F_DESK] }, dup);
    const note = await read('Private/Projects/Project Plan.md', dup);
    expect(note).toContain('folder: "Private/Projects"');
    expect(note).toContain('also_in:\n  - "Desktop"');
    expect(await visible(dup)).not.toContain('Desktop/Project Plan.md');
  });

  it('writes a moved or renamed document to its new place, leaves the old copy, and says so in the report', async () => {
    await runAll();
    const plan = ctx.mock.fixture.threads[T_PLAN];
    if (plan) {
      plan.title = 'Renamed plan';
      plan.updated += 1_000_000;
    }
    const summary = await runAll();
    expect(summary.relocated).toEqual([{ id: T_PLAN, title: 'Renamed plan', from: 'Private/Projects/Project Plan.md', to: 'Private/Projects/Renamed plan.md' }]);
    expect(await visible()).toEqual(expect.arrayContaining(['Private/Projects/Project Plan.md', 'Private/Projects/Renamed plan.md']));
    expect(await read('Private/Projects/Renamed plan.md')).toContain('title: "Renamed plan"');
    expect(await read('_Quip export report.md')).toContain('`Private/Projects/Project Plan.md` is now `Private/Projects/Renamed plan.md`');
  });

  it('re-renders notes whose link targets moved, so links never point at a stale copy', async () => {
    await runAll();
    const rental = ctx.mock.fixture.threads[T_RENTAL];
    if (rental) {
      rental.title = 'Rental history';
      rental.updated += 1_000_000;
    }
    const again = await runAll();
    expect(again.docs.exported).toBe(2); // the renamed document and Project Plan, which links to it
    expect(await read('Private/Projects/Project Plan.md')).toContain('[Rental Records](../Rental%20history.md)');
  });

  it('re-renders a note when a link that used to leave the export now stays inside it', async () => {
    const first = await runAll({ rootIds: [F_PROJ] });
    expect(first.unresolvedLinks).toContain(T_RENTAL.slice(0, 11) + 'v');
    expect(await read('Projects/Project Plan.md')).toContain('https://acme.quip.com/tRENTALthr1v/Rental-Records');

    const second = await runAll({ rootIds: [F_PROJ, F_PRIV] });
    expect(second.docs.skipped).toBeGreaterThan(0); // Budget and the slides did not change
    expect(await read('Projects/Project Plan.md')).toContain('[Rental Records](../Private/Rental%20Records.md)');
    expect(second.unresolvedLinks).not.toContain('tRENTALthr1v');
  });
});

describe('resuming', () => {
  it('skips unchanged documents on the next run and fetches only what changed', async () => {
    await runAll();
    const before = ctx.mock.requests.length;

    const again = await runAll();
    expect(again.docs).toMatchObject({ exported: 0, skipped: 9, failed: 0 });
    expect(ctx.mock.requests.slice(before).some((r) => /\/html$/.test(r.path))).toBe(false);
    // The report still describes the whole export, not just this run.
    expect(again.embeds).toMatchObject({ calendar: 1, kanban: 1, project_tracker: 1 });
    expect(again.warnings['attachment-missing']).toBeDefined();
    expect(again.unresolvedLinks).toEqual(['zZ9yY8xX7wWv']);

    const plan = ctx.mock.fixture.threads[T_PLAN];
    if (plan) plan.updated += 1_000_000;
    const mark = ctx.mock.requests.length;
    const third = await runAll();
    expect(third.docs).toMatchObject({ exported: 1, skipped: 8 });
    const htmlFetches = ctx.mock.requests.slice(mark).filter((r) => /\/html$/.test(r.path));
    expect(htmlFetches.map((r) => r.path)).toEqual([`/2/threads/${T_PLAN}/html`]);
  });

  it('re-exports when a skipped document is deleted from the target or options change', async () => {
    await runAll();
    await rm(join(ctx.dir, 'Private/Notes.md'));
    expect((await runAll()).docs).toMatchObject({ exported: 1, skipped: 8 });
    expect((await runAll({ includeComments: false })).docs.exported).toBe(9);
  });

  it('enabling the raw archive later actually creates it, instead of skipping unchanged notes', async () => {
    await runAll({ keepRaw: false });
    expect((await listTree(ctx.dir)).some((p) => p.startsWith('.quip-raw'))).toBe(false);
    const summary = await runAll({ keepRaw: true });
    expect(summary.docs.exported).toBe(9);
    expect(await read('.quip-raw/PLANthread1/body.html')).toContain('data-live-app-id');
  });

  it('stops cleanly when aborted, saves progress, and finishes on the next run', async () => {
    const controller = new AbortController();
    const first = await makeSession({}, { signal: controller.signal, onEvent: (e) => e.type === 'doc' && e.index === 1 && controller.abort() }).exporter.run();
    expect(first.aborted).toBe(true);
    expect(first.stopReason).toBe('aborted');
    expect(first.docs.exported).toBe(1);
    expect(await read('_Quip export report.md')).toContain('Stopped early');

    const second = await runAll();
    expect(second.aborted).toBe(false);
    expect(second.docs).toMatchObject({ exported: 8, skipped: 1 });
  });

  it('recovers from a corrupted state file by exporting everything again', async () => {
    await mkdir(join(ctx.dir, '.quip-md-export'), { recursive: true });
    await writeFile(join(ctx.dir, '.quip-md-export/state.json'), '{not json');
    const events: ExportEvent[] = [];
    const summary = await makeSession({}, { onEvent: (e) => events.push(e) }).exporter.run();
    expect(summary.docs.exported).toBe(9);
    expect(events.some((e) => e.type === 'log' && e.level === 'warn')).toBe(true);
  });
});

describe('when Quip misbehaves', () => {
  it('waits out rate limits and still produces the same export', async () => {
    const limited = await setup({ throttleEvery: 4 });
    const summary = await runAll({}, limited);
    expect(summary.docs).toMatchObject({ exported: 9, failed: 0 });
    expect(summary.rateLimitPauses).toBeGreaterThan(0);
    expect(limited.clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
    expect(await read('Private/Projects/Project Plan.md', limited)).toContain('**Kanban board**');
  });

  it('isolates a failing document: the others are exported and the report says what failed', async () => {
    const broken = await setup({ override: (req) => (req.path === `/2/threads/${T_PLAN}/html` ? { status: 500, body: { error: 'boom' } } : undefined) });
    const summary = await runAll({}, broken);
    expect(summary.docs).toMatchObject({ exported: 8, failed: 1 });
    expect(summary.failures).toEqual([expect.objectContaining({ id: T_PLAN, stage: 'fetch' })]);
    expect(await read('_Quip export report.md', broken)).toContain('Finished with problems');
    expect(await visible(broken)).not.toContain('Private/Projects/Project Plan.md');
  });

  it('retries only the failed document once Quip recovers', async () => {
    let failing = true;
    const flaky = await setup({ override: (req) => (failing && req.path === `/2/threads/${T_PLAN}/html` ? { status: 500 } : undefined) });
    await runAll({}, flaky);
    failing = false;
    const retry = await runAll({}, flaky);
    expect(retry.docs).toMatchObject({ exported: 1, skipped: 8, failed: 0 });
    expect(await visible(flaky)).toContain('Private/Projects/Project Plan.md');
  });

  it('does not mark a document complete when an attachment failed for a transient reason: the next run retries it', async () => {
    let failing = true;
    const flaky = await setup({ override: (req) => (failing && req.path === `/1/blob/${T_PLAN}/${B_OK}` ? { status: 500 } : undefined) });
    const first = await runAll({}, flaky);
    expect(first.attachments.missing).toBe(2); // the image that failed transiently, plus the one Quip refuses outright
    expect(await read('Private/Projects/Project Plan.md', flaky)).toContain('*[missing image: architecture]*');

    failing = false;
    const second = await runAll({}, flaky);
    expect(second.docs).toMatchObject({ exported: 1, skipped: 8 });
    expect(await read('Private/Projects/Project Plan.md', flaky)).toContain('![architecture](../../_attachments/PLANthread1/BLOBok00001.png)');
    // The refused image (HTTP 403) is permanent: it is reported, and not retried forever.
    const third = await runAll({}, flaky);
    expect(third.docs).toMatchObject({ exported: 0, skipped: 9 });
    expect(third.warnings['attachment-missing']).toBeDefined();
  });

  it('retries a spreadsheet sidecar that failed transiently', async () => {
    let failing = true;
    const flaky = await setup({ override: (req) => (failing && req.path === `/1/threads/${T_RENTAL}/export/xlsx` ? { status: 500 } : undefined) });
    const first = await runAll({}, flaky);
    expect(first.warnings['xlsx-failed']).toBeDefined();
    expect(await visible(flaky)).not.toContain('Private/Rental Records.xlsx');
    failing = false;
    const second = await runAll({}, flaky);
    expect(second.docs.exported).toBe(1);
    expect(await visible(flaky)).toContain('Private/Rental Records.xlsx');
  });

  it('reports a rejected token honestly: stopped, how many were not exported, and nothing is lost', async () => {
    let htmlCalls = 0;
    let revoked = true;
    const revoking = await setup({ override: (req) => (revoked && /\/html$/.test(req.path) && ++htmlCalls === 3 ? { status: 401 } : undefined) }); // Rental Records has 2 HTML pages, so the 3rd request is the 2nd document
    await expect(runAll({}, revoking)).rejects.toBeInstanceOf(AuthError);
    const report = await read('_Quip export report.md', revoking);
    expect(report).toContain('Status: Stopped: Quip rejected the access token (8 documents were not exported');
    expect(report).not.toContain('Status: Finished');
    expect(JSON.parse(await read('.quip-md-export/report.json', revoking))).toMatchObject({ stopReason: 'auth-error', docs: { exported: 1, notAttempted: 8 } });

    revoked = false; // a new token: the run continues where it stopped
    const resumed = await runAll({}, revoking);
    expect(resumed.docs).toMatchObject({ exported: 8, skipped: 1, failed: 0 });
  });

  it('stops everything when the token is rejected at the start, without writing partial output', async () => {
    const { exporter } = makeSession({}, { token: 'wrong-token' });
    await expect(exporter.run()).rejects.toBeInstanceOf(AuthError);
    expect(await listTree(ctx.dir)).toEqual([]);
    expect(ctx.mock.requests).toHaveLength(1);
  });

  it('survives a thread that Quip lists but will not return', async () => {
    const odd = await setup({ override: (req) => (req.path === '/2/threads/' && req.query.ids?.includes('NOTESthrdA1') ? { status: 403 } : undefined) });
    const summary = await runAll({}, odd);
    expect(summary.docs.failed).toBe(0);
    expect(summary.unreadableThreads.map((t) => t.id)).toContain('NOTESthrdA1');
    expect(summary.docs.exported).toBe(8);
  });
});

describe('file layout helpers', () => {
  it('never writes outside the target directory', async () => {
    const evil = await setup();
    const t = evil.mock.fixture.threads[T_LOOSE];
    if (t) t.title = '../../escape';
    await runAll({}, evil);
    const tree = await listTree(evil.dir);
    expect(tree).toContain('_Unfiled/__-..-escape.md');
    expect(tree.every((p) => p.split('/').every((segment) => segment !== '..' && segment !== '.'))).toBe(true);
    const outside = join(dirname(evil.dir), 'escape.md');
    await expect(readFile(outside)).rejects.toThrow();
  });
});
