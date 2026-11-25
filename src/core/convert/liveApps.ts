import { escapeBlockStart, escapeInline, fencedBlock } from '../markdownUtils';
import type { Cx } from './context';
import { renderInline } from './inline';
import { gridToMarkdown, renderCell, renderTable, tableToGrid } from './tables';

export type LiveAppType =
  | 'calendar'
  | 'kanban'
  | 'project_tracker'
  | 'process_bar'
  | 'poll'
  | 'countdown'
  | 'salesforce_record'
  | 'salesforce_list'
  | 'unknown';

/** Live-app type IDs published in Quip's own Automation API documentation. */
const APP_IDS: Record<string, LiveAppType> = {
  AbNBjAC13no: 'calendar',
  KORAjAYHE50: 'kanban',
  JdGAjAc35Es: 'project_tracker',
  XdJAjAN5Jbi: 'salesforce_record',
  QYUAjAGNxIo: 'salesforce_list',
};

const LABELS: Record<LiveAppType, string> = {
  calendar: 'Calendar',
  kanban: 'Kanban board',
  project_tracker: 'Project tracker',
  process_bar: 'Process bar',
  poll: 'Poll',
  countdown: 'Countdown',
  salesforce_record: 'Salesforce record',
  salesforce_list: 'Salesforce list',
  unknown: 'Live app',
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const DEFAULT_MAX_DUMP = 20_000;

export function isLiveApp(el: Element): boolean {
  return el.hasAttribute('data-live-app-id') || el.classList.contains('first-party-element') || el.getAttribute('data-section-style') === '19';
}

function parsePayload(el: Element): Json | undefined {
  const raw = el.getAttribute('data-live-app-payload');
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function detectType(el: Element, payload: Json | undefined): LiveAppType {
  if (payload) {
    if (Array.isArray(payload.events)) return 'calendar';
    const cols = payload.columns;
    if (Array.isArray(cols)) {
      if (cols.some((c) => isObj(c) && 'cards' in c)) return 'kanban';
      if (Array.isArray(payload.rows) || cols.some((c) => isObj(c) && 'type' in c)) return 'project_tracker';
    }
    if ('list_id' in payload || 'related_list_type' in payload) return 'salesforce_list';
    if ('record_id' in payload) return 'salesforce_record';
  }
  const id = el.getAttribute('data-live-app-id');
  const byId = id ? APP_IDS[id] : undefined;
  if (byId) return byId;
  if (el.querySelector('[data-live-app-process-bar-step-selected]')) return 'process_bar';
  const hints = `${el.className} ${el.querySelector('summary')?.textContent ?? ''}`.toLowerCase().replace(/[\s-]+/g, '_');
  if (hints.includes('kanban')) return 'kanban';
  if (hints.includes('calendar')) return 'calendar';
  if (hints.includes('project_tracker') || hints.includes('tracker')) return 'project_tracker';
  if (hints.includes('process_bar')) return 'process_bar';
  if (hints.includes('countdown')) return 'countdown';
  if (hints.includes('poll')) return 'poll';
  if (hints.includes('salesforce')) return 'salesforce_record';
  return 'unknown';
}

/** Single-line, table/list-safe text. */
function cellText(s: unknown): string {
  const text = typeof s === 'string' ? s : s == null ? '' : String(s);
  return escapeInline(text.replace(/\u200b/g, '').trim()).replace(/\s*\n\s*/g, '<br>').replace(/\|/g, '\\|');
}

/**
 * Quip stores date-only values as local midnight in the author's time zone. Rounding to the
 * nearest UTC midnight recovers the intended calendar day for any offset within +/-12h.
 */
export function epochToDate(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return cellText(value);
  const day = 86_400_000;
  return new Date(Math.round(n / day) * day).toISOString().slice(0, 10);
}

function monthLabel(displayMonth: unknown): string | undefined {
  return typeof displayMonth === 'string' && /^\d{4}-\d{2}$/.test(displayMonth) ? displayMonth : undefined;
}

function firstOwnTable(el: Element): Element | undefined {
  return Array.from(el.querySelectorAll('table')).find((t) => !t.parentElement?.closest('table'));
}

function truncate(text: string, cx: Cx, max: number, what: string): string {
  if (text.length <= max) return text;
  cx.warn('liveapp-truncated', what);
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : max)}\n\n*(truncated; the full data is in the raw HTML archive)*`;
}

function calendarFromPayload(payload: Json): { body: string; suffix?: string } {
  const events = asArray(payload.events)
    .filter(isObj)
    .map((e) => {
      const range = isObj(e.dateRange) ? e.dateRange : {};
      return {
        start: typeof range.start === 'string' ? range.start : '',
        end: typeof range.end === 'string' ? range.end : '',
        color: typeof e.color === 'string' ? e.color.toLowerCase() : '',
        content: cellText(e.content),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
  const month = monthLabel(payload.displayMonth);
  const suffix = month ? ` (${month})` : undefined;
  if (events.length === 0) return suffix ? { body: '*No events.*', suffix } : { body: '*No events.*' };
  const hasColor = events.some((e) => e.color);
  const rows = [
    ['Date', 'Event', ...(hasColor ? ['Color'] : [])],
    ...events.map((e) => [e.end && e.end !== e.start ? `${e.start} → ${e.end}` : e.start, e.content, ...(hasColor ? [e.color] : [])]),
  ];
  const body = gridToMarkdown({ rows });
  return suffix ? { body, suffix } : { body };
}

interface KanbanColumn {
  header: string;
  cards: string[];
}

function kanbanToMarkdown(columns: KanbanColumn[]): string {
  if (columns.length === 0) return '*Empty board.*';
  const lines: string[] = [];
  for (const col of columns) {
    lines.push(`- **${col.header || 'Untitled column'}**`);
    for (const card of col.cards) lines.push(`  - ${escapeBlockStart(card)}`);
  }
  return lines.join('\n');
}

function kanbanFromPayload(payload: Json): string {
  const columns = asArray(payload.columns)
    .filter(isObj)
    .map<KanbanColumn>((c) => ({
      header: cellText(c.headerContent).replace(/<br>/g, ' '),
      cards: asArray(c.cards)
        .filter(isObj)
        .map((card) => cellText(card.content))
        .filter((t) => t !== ''),
    }));
  return kanbanToMarkdown(columns);
}

/** Quip's own dump lays a Kanban board out column-major: header row, then one card per cell. */
function kanbanFromDump(cx: Cx, table: Element): string {
  const rows = tableToGrid(cx, table).rows;
  const header = rows[0] ?? [];
  const columns = header.map<KanbanColumn>((h, i) => ({
    header: h.replace(/<br>/g, ' ').trim(),
    cards: rows
      .slice(1)
      .map((r) => r[i] ?? '')
      .filter((t) => t.trim() !== ''),
  }));
  return kanbanToMarkdown(columns);
}

function trackerFromPayload(cx: Cx, payload: Json): string {
  const cols = asArray(payload.columns).filter(isObj);
  const rows = asArray(payload.rows).filter(isObj);
  if (cols.length === 0) return '*Empty tracker.*';
  const header = cols.map((c) => cellText(c.content));
  const body = rows
    .map((row) =>
      cols.map((col) => {
        const value = row[String(col.id)];
        if (value == null) return '';
        switch (String(col.type ?? '').toUpperCase()) {
          case 'PERSON':
            return asArray(value)
              .map((id) => cellText(cx.userName(String(id))))
              .join(', ');
          case 'STATUS': {
            const opt = asArray(col.options)
              .filter(isObj)
              .find((o) => o.devName === value || o.label === value);
            return cellText(opt?.label ?? value);
          }
          case 'DATE':
            return epochToDate(value);
          case 'FILE':
            return asArray(value)
              .map((v) => (isObj(v) ? cellText(v.name ?? v.id ?? '') : cellText(v)))
              .filter(Boolean)
              .join(', ');
          default:
            return Array.isArray(value) ? value.map((v) => cellText(v)).join(', ') : typeof value === 'boolean' ? (value ? '✓' : '') : isObj(value) ? cellText(JSON.stringify(value)) : cellText(value);
        }
      }),
    )
    .filter((r) => r.some((c) => c !== ''));
  return gridToMarkdown({ rows: [header, ...body] });
}

function processBar(cx: Cx, el: Element): string | undefined {
  const steps = Array.from(el.querySelectorAll('td, th'))
    .map((cell) => ({ text: renderCell(cx, cell), current: cell.hasAttribute('data-live-app-process-bar-step-selected') }))
    .filter((s) => s.text !== '');
  if (steps.length === 0) return undefined;
  return steps.map((s) => (s.current ? `**${s.text}** (current)` : s.text)).join(' → ');
}

function genericDump(cx: Cx, el: Element, payload: Json | undefined, max: number): string | undefined {
  const table = firstOwnTable(el);
  if (table) {
    const md = renderTable(cx, table);
    if (md) return truncate(md, cx, max, 'table');
  }
  const pre = el.querySelector('pre');
  const preText = (pre?.textContent ?? '').trim();
  if (preText) return truncate(fencedBlock(preText), cx, max, 'pre');
  const text = Array.from(el.querySelectorAll('details'))
    .map((d) => renderInline(cx, d, { br: 'hard' }).trim())
    .filter(Boolean)
    .join('\n\n');
  if (text) return truncate(text, cx, max, 'text');
  if (payload) return truncate(fencedBlock(JSON.stringify(payload, null, 2), 'json'), cx, max, 'payload');
  return undefined;
}

/** Converts a live-app block to Markdown. Fidelity ladder: payload JSON, then Quip's dump table, then a placeholder. */
export function renderLiveApp(cx: Cx, el: Element): string {
  const payload = parsePayload(el);
  const type = detectType(el, payload);
  const max = cx.opts.maxDumpChars ?? DEFAULT_MAX_DUMP;
  const table = firstOwnTable(el);
  const summaryName = (el.querySelector('summary')?.textContent ?? '').trim();
  const label = summaryName && summaryName.length < 60 ? summaryName : LABELS[type];
  cx.embed(type === 'unknown' ? 'live_app_unknown' : type);

  let body: string | undefined;
  let suffix = '';
  switch (type) {
    case 'calendar':
      if (payload && Array.isArray(payload.events)) {
        const c = calendarFromPayload(payload);
        body = c.body;
        suffix = c.suffix ?? '';
      } else body = genericDump(cx, el, payload, max);
      break;
    case 'kanban':
      if (payload && Array.isArray(payload.columns)) body = kanbanFromPayload(payload);
      else if (table) body = kanbanFromDump(cx, table);
      else body = genericDump(cx, el, payload, max);
      break;
    case 'project_tracker':
      body = payload && Array.isArray(payload.columns) ? trackerFromPayload(cx, payload) : genericDump(cx, el, payload, max);
      break;
    case 'process_bar':
      body = processBar(cx, el) ?? genericDump(cx, el, payload, max);
      break;
    case 'salesforce_record':
    case 'salesforce_list': {
      const ids = payload
        ? Object.entries(payload)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => `${k.replace(/_/g, ' ')}: \`${String(v)}\``)
            .join(', ')
        : '';
      const dump = table ? renderTable(cx, table) : '';
      body = [`*Live Salesforce data is not exported.*${ids ? ` (${ids})` : ''}`, dump].filter(Boolean).join('\n\n');
      break;
    }
    default:
      body = genericDump(cx, el, payload, max);
      if (type === 'unknown') cx.warn('unknown-live-app', el.getAttribute('data-live-app-id') ?? el.className);
  }

  if (!body) {
    cx.warn('live-app-no-data', `${type}:${el.getAttribute('data-live-app-id') ?? ''}`);
    body = `> ${LABELS[type]} content was not available in the exported HTML. See the raw archive for details.`;
  }
  return `**${escapeInline(label)}**${suffix}\n\n${body}`;
}
