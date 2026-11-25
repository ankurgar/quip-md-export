// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/core/convert';
import { epochToDate } from '../../src/core/convert/liveApps';
import type { ConvertOptions } from '../../src/core/types';

const convert = (html: string, extra: Partial<ConvertOptions> = {}) => htmlToMarkdown(html, { threadId: 'T1abcdefghi', ...extra });
const md = (html: string, extra: Partial<ConvertOptions> = {}) => convert(html, extra).markdown.trimEnd();

/** Builds a V2-style live app block; the payload is HTML-escaped like Quip does. */
const app = (id: string, payload: unknown, inner = '') =>
  `<div id="s1" data-live-app-id="${id}"${payload === undefined ? '' : ` data-live-app-payload='${JSON.stringify(payload).replace(/'/g, '&#39;')}'`}>${inner}</div>`;

const CAL = 'AbNBjAC13no';
const KANBAN = 'KORAjAYHE50';
const TRACKER = 'JdGAjAc35Es';

describe('calendar', () => {
  it('renders events sorted by date with ranges and colours', () => {
    const html = app(CAL, {
      events: [
        { color: 'RED', dateRange: { start: '2021-10-18', end: '2021-10-18' }, content: 'Project Status' },
        { color: 'GREEN', dateRange: { start: '2021-10-04', end: '2021-10-06' }, content: 'Kickoff | Phase 1' },
      ],
      displayMonth: '2021-10',
    });
    expect(md(html)).toBe(
      [
        '**Calendar** (2021-10)',
        '',
        '| Date | Event | Color |',
        '| --- | --- | --- |',
        '| 2021-10-04 → 2021-10-06 | Kickoff \\| Phase 1 | green |',
        '| 2021-10-18 | Project Status | red |',
      ].join('\n'),
    );
  });

  it('omits the colour column when no event has a colour and handles an empty calendar', () => {
    const r = md(app(CAL, { events: [{ dateRange: { start: '2022-01-01', end: '2022-01-01' }, content: 'New year' }] }));
    expect(r).toContain('| Date | Event |');
    expect(r).not.toContain('Color');
    expect(md(app(CAL, { events: [] }))).toBe('**Calendar**\n\n*No events.*');
  });

  it('counts the embed and detects the calendar from the payload even without a known app id', () => {
    const r = convert(app('unknownId', { events: [{ dateRange: { start: '2022-01-01', end: '2022-01-01' }, content: 'x' }] }));
    expect(r.embeds).toEqual({ calendar: 1 });
  });

  it('falls back to Quip\'s own dump table when there is no payload', () => {
    const dump = `<details><summary>Calendar</summary><table><tr><th>Date</th><th>Event</th></tr><tr><td>Oct 4</td><td>Kickoff</td></tr></table></details>`;
    expect(md(app(CAL, undefined, dump))).toBe('**Calendar**\n\n| Date | Event |\n| --- | --- |\n| Oct 4 | Kickoff |');
  });
});

describe('kanban board', () => {
  it('renders columns as a nested list and drops empty cards', () => {
    const html = app(KANBAN, {
      columns: [
        { color: 'RED', headerContent: 'To Do', cards: [{ content: 'First Card' }, { content: '' }] },
        { headerContent: '', cards: [] },
        { headerContent: 'Done', cards: [{ content: '1. numbered?' }, { content: 'two\nlines' }] },
      ],
    });
    expect(md(html)).toBe(
      ['**Kanban board**', '', '- **To Do**', '  - First Card', '- **Untitled column**', '- **Done**', '  - 1\\. numbered?', '  - two<br>lines'].join('\n'),
    );
  });

  it('reads the column-major dump when the payload is missing (V2 behaviour seen in real exports)', () => {
    const dump = `<details><summary></summary><table><tr><th>To Do</th><th>Done</th></tr><tr><td>First</td><td>Second</td></tr><tr><td></td><td>Third</td></tr></table></details>`;
    expect(md(app(KANBAN, undefined, dump))).toBe('**Kanban board**\n\n- **To Do**\n  - First\n- **Done**\n  - Second\n  - Third');
  });

  it('recognises the V1 first-party-element markup by class', () => {
    const dump = `<details><table><tr><th>A</th></tr><tr><td>card</td></tr></table></details>`;
    const html = `<div data-section-style="19" class="first-party-element kanban">${dump}</div>`;
    expect(md(html)).toBe('**Kanban board**\n\n- **A**\n  - card');
  });
});

describe('project tracker', () => {
  const payload = {
    columns: [
      { content: 'Project\n', type: 'TEXT', id: '0' },
      { content: 'Owner\n', type: 'PERSON', id: '1' },
      { content: 'Status\n', type: 'STATUS', id: '2', options: [{ label: 'In Progress', devName: 'in_progress', color: 'YELLOW' }] },
      { content: 'Deadline\n', type: 'DATE', id: '3' },
      { content: 'Attachment\n', type: 'FILE', id: '4' },
    ],
    rows: [
      { '0': 'Launch\n', '1': ['u1', 'u2'], '2': 'in_progress', '3': 1605686400000, '4': [{ name: 'plan.pdf' }] },
      { '0': '', '1': [], '2': null, '3': null, '4': null },
      { '0': 'Odd | name', '1': ['u9'], '2': 'custom', '3': null, '4': null },
    ],
  };

  it('maps typed columns: people, status labels, dates, files; drops fully empty rows', () => {
    const names = new Map([
      ['u1', 'Ann Lee'],
      ['u2', 'Bob Ray'],
    ]);
    const r = convert(app(TRACKER, payload), { userNames: names });
    expect(r.markdown.trimEnd()).toBe(
      [
        '**Project tracker**',
        '',
        '| Project | Owner | Status | Deadline | Attachment |',
        '| --- | --- | --- | --- | --- |',
        '| Launch | Ann Lee, Bob Ray | In Progress | 2020-11-18 | plan.pdf |',
        '| Odd \\| name | u9 | custom |   |   |',
      ].join('\n'),
    );
    expect(r.unknownUserIds).toEqual(['u9']);
  });
});

describe('date handling', () => {
  it('recovers the intended calendar day for local-midnight timestamps in any time zone', () => {
    const pst = Date.UTC(2020, 10, 18, 8, 0, 0); // midnight at UTC-8
    const ist = Date.UTC(2020, 10, 17, 18, 30, 0); // midnight at UTC+5:30
    const utc = Date.UTC(2020, 10, 18, 0, 0, 0);
    expect([pst, ist, utc].map(epochToDate)).toEqual(['2020-11-18', '2020-11-18', '2020-11-18']);
  });

  it('passes through values that are not timestamps', () => {
    expect(epochToDate('soon')).toBe('soon');
  });
});

describe('process bar and other apps', () => {
  it('renders the step sequence and marks the current step', () => {
    const dump = `<details><table><tr><td>Plan</td><td data-live-app-process-bar-step-selected>Build</td><td>Ship</td></tr></table></details>`;
    expect(md(app('procId', undefined, dump))).toBe('**Process bar**\n\nPlan → **Build** (current) → Ship');
  });

  it('does not pretend to export live Salesforce data', () => {
    const r = md(app('XdJAjAN5Jbi', { record_id: '0013h00000C9tHJAAZ', org_id: '00D3h000004XoQgEAK' }));
    expect(r).toContain('**Salesforce record**');
    expect(r).toContain('Live Salesforce data is not exported');
    expect(r).toContain('`0013h00000C9tHJAAZ`');
  });

  it('keeps unknown apps as a generic table and records a warning for follow-up', () => {
    const dump = `<details><summary>Weather</summary><table><tr><th>City</th></tr><tr><td>Pune</td></tr></table></details>`;
    const r = convert(app('zzzUnknown1', undefined, dump));
    expect(r.markdown.trimEnd()).toBe('**Weather**\n\n| City |\n| --- |\n| Pune |');
    expect(r.warnings).toEqual([{ code: 'unknown-live-app', detail: 'zzzUnknown1' }]);
    expect(r.embeds).toEqual({ live_app_unknown: 1 });
  });

  it('preserves an unknown payload as JSON rather than dropping it', () => {
    const r = md(app('zzzUnknown2', { foo: 'bar' }));
    expect(r).toContain('```json');
    expect(r).toContain('"foo": "bar"');
  });

  it('falls back to a visible placeholder when nothing was exported', () => {
    const r = convert(app(KANBAN, undefined));
    expect(r.markdown).toContain('Kanban board content was not available');
    expect(r.warnings.map((w) => w.code)).toContain('live-app-no-data');
  });

  it('truncates oversized dumps and says so', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `<tr><td>row ${i}</td></tr>`).join('');
    const r = convert(app('zzzUnknown3', undefined, `<details><table><tr><th>h</th></tr>${rows}</table></details>`), { maxDumpChars: 500 });
    expect(r.markdown).toContain('truncated');
    expect(r.markdown.length).toBeLessThan(900);
    expect(r.warnings.map((w) => w.code)).toContain('liveapp-truncated');
  });

  it('survives malformed payload JSON', () => {
    const html = `<div data-live-app-id="${CAL}" data-live-app-payload="{not json"><details><table><tr><th>d</th></tr><tr><td>x</td></tr></table></details></div>`;
    expect(md(html)).toBe('**Calendar**\n\n| d |\n| --- |\n| x |');
  });
});

describe('documents mixing live apps with ordinary content', () => {
  it('keeps document order and separates blocks with blank lines', () => {
    const html = `<h2>Plan</h2><p>Intro</p>${app(CAL, { events: [{ dateRange: { start: '2022-02-02', end: '2022-02-02' }, content: 'Go' }] })}<p>Outro</p>`;
    expect(md(html)).toBe('## Plan\n\nIntro\n\n**Calendar**\n\n| Date | Event |\n| --- | --- |\n| 2022-02-02 | Go |\n\nOutro');
  });
});
