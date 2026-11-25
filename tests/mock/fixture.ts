/**
 * Synthetic Quip account used by the integration and browser tests.
 * Shapes follow Quip's public Automation API specification; HTML shapes follow its documented
 * live-app examples. Nothing here comes from a real account.
 */
export const TOKEN = 'test-token-123';
export const SITE = 'https://acme.quip.com';

export const ME = { id: 'uME00000001', name: 'Jane Doe' };
export const ANN = { id: 'uANN0000001', name: 'Ann Lee' };

export const F_PRIV = 'fPRIVATE001';
export const F_PROJ = 'fPROJECTS01';
export const F_DESK = 'fDESKTOP001';
export const F_SHARED = 'fSHARED0001';
export const F_LOCKED = 'fLOCKED0001';
export const F_ARCH = 'fARCHIVE001';
export const F_STAR = 'fSTARRED001';
export const F_TRASH = 'fTRASH00001';

export const T_RENTAL = 'tRENTALthr1';
export const T_RENTAL_SECRET = 'tRENTALthr1v';
export const T_PLAN = 'PLANthread1';
export const T_SHEET = 'SHEETthrd01';
export const T_SLIDES = 'SLIDESthrd1';
export const T_NOTES_A = 'NOTESthrdA1';
export const T_NOTES_B = 'NOTESthrdB1';
export const T_ILLEGAL = 'ILLEGALthr1';
export const T_SHARED = 'SHAREDthrd1';
export const T_LOOSE = 'LOOSEthrd01';
export const T_CHAT = 'CHATthread01';

export const B_OK = 'BLOBok00001';
export const B_GONE = 'BLOBgone001';
export const B_FILE = 'BLOBfile001';

export interface FixtureMessage {
  id: string;
  author_id: string;
  author_name: string;
  created_usec: number;
  text: string;
  mention_user_ids?: string[];
  annotation?: { id: string };
  files?: Array<{ hash: string; name: string }>;
}

export interface FixtureThread {
  id: string;
  title: string;
  type: 'DOCUMENT' | 'SPREADSHEET' | 'SLIDES' | 'CHAT';
  secret?: string;
  authorId: string;
  created: number;
  updated: number;
  pages: string[];
  messages?: FixtureMessage[];
  movedTo?: string;
}

export interface FixtureFolder {
  id: string;
  title: string;
  children: Array<{ folder_id: string } | { thread_id: string }>;
}

export type FixtureBlob = { type: string; bytes: Uint8Array } | { forbidden: true };

export interface Fixture {
  folders: Record<string, FixtureFolder>;
  threads: Record<string, FixtureThread>;
  blobs: Record<string, FixtureBlob>;
  /** Threads the user owns, returned by /1/users/current/threads. */
  owned: string[];
  restrictedFolders: string[];
}

export const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);
export const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%mock attachment\n');

const US = 1_000_000;
const base = Date.UTC(2021, 1, 3, 10, 0, 0) / 1000;

const RENTAL_PAGE_1 = `<h1 id='r-title'>Rental Records</h1>
<p id='r-p1' class='line'>Monthly rent log for the flat. Paid by <b>bank transfer</b> unless noted.</p>
<div id='r-sheet' data-section-style='13'><table id='r-tbl' title='Rent' cellspacing='0' cellpadding='0'><thead><tr><th></th><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody>
<tr><td>1</td><td class='bold'>Month</td><td class='bold'>Rent</td><td class='bold'>Paid</td><td></td></tr>
<tr><td>2</td><td>Jan 2021</td><td>1,200</td><td>Yes</td><td></td></tr>
<tr><td>3</td><td>Feb 2021</td><td>1,200</td><td>No | late</td><td></td></tr>
<tr><td>4</td><td></td><td></td><td></td><td></td></tr></tbody></table></div>
`;
const RENTAL_PAGE_2 = `<h3 id='r-h1'>Notes</h3>
<div data-section-style='5'><ul id='r-ul'><li id='r-li1'>Deposit returned in <i>March</i></li><li id='r-li2'>Agreement renewed<ul><li id='r-li3'>Until 2022</li></ul></li></ul></div>
<div data-section-style='6'><ul id='r-ol'><li>First step</li><li>Second step</li></ul></div>
`;

const PLAN_HTML = `<h1 id='p-title'>Project Plan</h1>
<p id='p-1' class='line'>See <a href='${SITE}/${T_RENTAL_SECRET}/Rental-Records#temp:C:abc'>Rental Records</a> and <a href='${SITE}/zZ9yY8xX7wWv/Elsewhere'>a doc outside the export</a>.</p>
<div data-section-style='7'><ul id='p-cl'><li id='p-c1' class='checked'>Kick-off done</li><li id='p-c2'>Write the report</li></ul></div>
<div id='p-cal' data-live-app-id='AbNBjAC13no' data-live-app-payload='{"events":[{"color":"RED","dateRange":{"start":"2021-10-18","end":"2021-10-18"},"content":"Project Status"},{"color":"GREEN","dateRange":{"start":"2021-10-04","end":"2021-10-06"},"content":"Kickoff Meeting"}],"displayMonth":"2021-10"}'><details><summary></summary><table><tr><th>Date</th><th>Event</th></tr><tr><td>Oct 4</td><td>Kickoff Meeting</td></tr></table></details></div>
<div id='p-kb' data-live-app-id='KORAjAYHE50' data-live-app-payload='{"columns":[{"color":"RED","headerContent":"To Do","cards":[{"color":"RED","content":"First Card"}]},{"color":"BLUE","headerContent":"Done","cards":[{"color":"BLUE","content":"Third Card"}]}]}'><details><summary></summary><table><tr><th>To Do</th><th>Done</th></tr></table></details></div>
<div id='p-tr' data-live-app-id='JdGAjAc35Es' data-live-app-payload='{"columns":[{"content":"Project\\n","type":"TEXT","id":"0"},{"content":"Owner\\n","type":"PERSON","id":"1"},{"content":"Status\\n","type":"STATUS","id":"2","options":[{"label":"In Progress","devName":"in_progress","color":"YELLOW"}]},{"content":"Deadline\\n","type":"DATE","id":"3"}],"rows":[{"0":"Launch\\n","1":["${ANN.id}"],"2":"in_progress","3":1605686400000}]}'></div>
<div data-section-style='11'><img src='/blob/${T_PLAN}/${B_OK}' alt='architecture'/></div>
<div data-section-style='11'><img src='/blob/${T_PLAN}/${B_GONE}' alt='lost chart'/></div>
<p id='p-2' class='line'>Attachment: <a href='/blob/${T_PLAN}/${B_FILE}'>spec.pdf</a></p>
`;

const SHEET_HTML = `<div id='s-1' data-section-style='13'><table title='Budget'><thead><tr><th></th><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td class='bold'>Item</td><td class='bold'>Cost</td></tr><tr><td>2</td><td>Desk</td><td>300</td></tr></tbody></table><table title='Forecast'><tbody><tr><td>Q1</td><td>10</td></tr></tbody></table></div>`;

const SHARED_HTML = `<h1>Shared doc</h1><p class='line'>Written by Ann. Hello <a href='${SITE}/${ANN.id}'>@Ann</a>.</p>`;

function message(i: number, text: string, extra: Partial<FixtureMessage> = {}): FixtureMessage {
  return { id: `msg${i}`, author_id: ANN.id, author_name: ANN.name, created_usec: (base + i * 3600) * US, text, ...extra };
}

export function buildFixture(): Fixture {
  const thread = (id: string, title: string, pages: string[], extra: Partial<FixtureThread> = {}): FixtureThread => ({
    id,
    title,
    type: 'DOCUMENT',
    authorId: ME.id,
    created: base * US,
    updated: (base + 86_400) * US,
    pages,
    ...extra,
  });
  const threads: FixtureThread[] = [
    thread(T_RENTAL, 'Rental Records', [RENTAL_PAGE_1, RENTAL_PAGE_2], {
      secret: T_RENTAL_SECRET,
      messages: [
        message(1, 'Looks right to me.'),
        message(2, `cc ${SITE}/${ME.id}`, { mention_user_ids: [ME.id] }),
        message(3, 'Anchored remark\nsecond line', { annotation: { id: 'ann1' } }),
        message(4, 'See the receipt', { files: [{ hash: B_FILE, name: 'receipt.pdf' }] }),
        message(5, '1. not a list'),
      ],
    }),
    thread(T_PLAN, 'Project Plan', [PLAN_HTML]),
    thread(T_SHEET, 'Budget', [SHEET_HTML], { type: 'SPREADSHEET' }),
    thread(T_SLIDES, 'Pitch deck', [], { type: 'SLIDES' }),
    thread(T_NOTES_A, 'Notes', ["<h1>Notes</h1><p class='line'>first</p>"]),
    thread(T_NOTES_B, 'notes', ["<h1>notes</h1><p class='line'>second</p>"]),
    thread(T_ILLEGAL, 'Q3/Q4: plan? <final>', ["<p class='line'>no heading in this one</p>"]),
    thread(T_SHARED, 'Shared doc', [SHARED_HTML], { authorId: ANN.id }),
    thread(T_LOOSE, 'Loose note', ["<h1>Loose note</h1><p class='line'>in no folder</p>"]),
    thread(T_CHAT, 'A chat', [], { type: 'CHAT' }),
  ];
  const folders: FixtureFolder[] = [
    { id: F_PRIV, title: 'Private', children: [{ thread_id: T_RENTAL }, { folder_id: F_PROJ }, { thread_id: T_NOTES_A }, { thread_id: T_NOTES_B }, { thread_id: T_ILLEGAL }] },
    { id: F_PROJ, title: 'Projects', children: [{ thread_id: T_PLAN }, { thread_id: T_SHEET }, { thread_id: T_SLIDES }] },
    { id: F_DESK, title: 'Desktop', children: [{ thread_id: T_RENTAL }] },
    { id: F_SHARED, title: 'Team Shared', children: [{ folder_id: F_LOCKED }, { thread_id: T_SHARED }] },
    { id: F_LOCKED, title: 'Locked', children: [] },
    { id: F_ARCH, title: 'Archive', children: [] },
    { id: F_STAR, title: 'Starred', children: [{ thread_id: T_PLAN }] },
    { id: F_TRASH, title: 'Trash', children: [] },
  ];
  return {
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    threads: Object.fromEntries(threads.map((t) => [t.id, t])),
    blobs: {
      [`${T_PLAN}/${B_OK}`]: { type: 'image/png', bytes: PNG_1X1 },
      [`${T_PLAN}/${B_GONE}`]: { forbidden: true },
      [`${T_PLAN}/${B_FILE}`]: { type: 'application/pdf', bytes: PDF_BYTES },
      [`${T_RENTAL}/${B_FILE}`]: { type: 'application/pdf', bytes: PDF_BYTES },
    },
    owned: [T_RENTAL, T_PLAN, T_SHEET, T_SLIDES, T_NOTES_A, T_NOTES_B, T_ILLEGAL, T_LOOSE, T_CHAT],
    restrictedFolders: [F_LOCKED],
  };
}
