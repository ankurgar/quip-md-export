import { escapeInline } from '../markdownUtils';
import type { Cx } from './context';
import { renderInline, renderInlineNodes, wrapMarks, type InlineMode } from './inline';

const CELL_MODE: InlineMode = { br: 'html' };
const tagOf = (el: Element): string => el.tagName.toLowerCase();

export interface Grid {
  rows: string[][];
  caption?: string;
}

function childRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const t = tagOf(child);
    if (t === 'tr') rows.push(child);
    else if (t === 'thead' || t === 'tbody' || t === 'tfoot') {
      for (const r of Array.from(child.children)) if (tagOf(r) === 'tr') rows.push(r);
    }
  }
  return rows;
}

function clampInt(v: string | null, min: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** One table cell as single-line Markdown: blocks become `<br>`-separated segments, `|` is escaped. */
export function renderCell(cx: Cx, cell: Element): string {
  const segments: string[] = [];
  let inlineBuf: Node[] = [];
  const flush = (): void => {
    if (inlineBuf.length === 0) return;
    const s = renderInlineNodes(cx, inlineBuf, CELL_MODE).trim();
    if (s) segments.push(s);
    inlineBuf = [];
  };

  for (const node of Array.from(cell.childNodes)) {
    if (node.nodeType !== 1) {
      inlineBuf.push(node);
      continue;
    }
    const el = node as Element;
    const t = tagOf(el);
    if (t === 'p' || t === 'div' || t === 'section') {
      flush();
      const s = renderCell(cx, el);
      if (s) segments.push(s);
    } else if (t === 'ul' || t === 'ol') {
      flush();
      Array.from(el.children).forEach((li, i) => {
        const s = renderCell(cx, li);
        if (s) segments.push(t === 'ol' ? `${i + 1}. ${s}` : `• ${s}`);
      });
    } else if (t === 'table') {
      flush();
      const s = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (s) segments.push(s);
      cx.warn('nested-table-flattened');
    } else {
      inlineBuf.push(node);
    }
  }
  flush();

  // Quip ends every spreadsheet cell with a <br>; it is not content.
  let text = segments.join('<br>').replace(/^(?:\s*<br>)+\s*|(?:\s*<br>)+\s*$/g, '');
  const cls = cell.classList;
  if (text.trim()) {
    if (cls.contains('strikethrough')) text = wrapMarks('~~', text);
    if (cls.contains('italic')) text = wrapMarks('*', text);
    if (cls.contains('bold')) text = wrapMarks('**', text);
  }
  return text.replace(/\|/g, '\\|');
}

export function tableToGrid(cx: Cx, table: Element): Grid {
  const rowEls = childRows(table);
  const rows: string[][] = [];
  const carry = new Map<number, number>();
  let caption: string | undefined;

  const captionEl = Array.from(table.children).find((c) => tagOf(c) === 'caption');
  if (captionEl) caption = renderInline(cx, captionEl, { br: 'space' }).trim() || undefined;

  rowEls.forEach((tr, rIdx) => {
    const cells = Array.from(tr.children).filter((c) => tagOf(c) === 'td' || tagOf(c) === 'th');
    const first = cells[0];
    if (
      rIdx === 0 &&
      !caption &&
      rowEls.length > 1 &&
      cells.length === 1 &&
      first &&
      tagOf(first) === 'th' &&
      clampInt(first.getAttribute('colspan'), 1, 200) >= 2
    ) {
      caption = renderCell(cx, first) || undefined;
      return;
    }

    const row: string[] = [];
    let c = 0;
    const fillCarried = (): void => {
      let remaining = carry.get(c);
      while (remaining !== undefined) {
        row[c] = '';
        if (remaining <= 1) carry.delete(c);
        else carry.set(c, remaining - 1);
        c += 1;
        remaining = carry.get(c);
      }
    };
    for (const cell of cells) {
      fillCarried();
      const colspan = clampInt(cell.getAttribute('colspan'), 1, 200);
      const rowspan = clampInt(cell.getAttribute('rowspan'), 1, 1000);
      row[c] = renderCell(cx, cell);
      for (let k = 1; k < colspan; k += 1) row[c + k] = '';
      if (rowspan > 1) for (let k = 0; k < colspan; k += 1) carry.set(c + k, rowspan - 1);
      c += colspan;
    }
    fillCarried();
    rows.push(Array.from({ length: row.length }, (_, i) => row[i] ?? ''));
  });

  const grid: Grid = { rows };
  if (caption) grid.caption = caption;
  return grid;
}

export function columnLabel(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function trimEmptyEdges(rows: string[][]): string[][] {
  let lastRow = rows.length - 1;
  while (lastRow >= 0 && (rows[lastRow] ?? []).every((c) => c.trim() === '')) lastRow -= 1;
  const kept = rows.slice(0, lastRow + 1);
  let width = Math.max(0, ...kept.map((r) => r.length));
  while (width > 0 && kept.every((r) => (r[width - 1] ?? '').trim() === '')) width -= 1;
  return kept.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}

/**
 * Quip renders spreadsheets with a header row of column letters, sometimes with a first column of
 * row numbers. Those are UI chrome, not data. Only call this for tables known to be spreadsheets:
 * an ordinary table could legitimately look the same.
 */
export function normalizeSpreadsheetGrid(rows: string[][]): string[][] {
  let out = rows;
  const first = out[0];
  if (first && first.length >= 2 && first[0]?.trim() === '' && first.slice(1).every((v, i) => v.trim() === columnLabel(i))) {
    out = out.slice(1);
    const nums = out.map((r) => r[0]?.trim() ?? '');
    const sequential = nums.length > 0 && nums.every((v, i) => /^\d+$/.test(v) && (i === 0 || Number(v) > Number(nums[i - 1])));
    if (sequential) out = out.map((r) => r.slice(1));
  } else if (first && first.length >= 1 && first.every((v, i) => v.trim() === columnLabel(i))) {
    out = out.slice(1);
  }
  return trimEmptyEdges(out);
}

/** Header cells that are entirely bold do not need `**` in a table header. */
function unwrapBoldHeader(row: string[]): string[] {
  const nonEmpty = row.filter((c) => c.trim() !== '');
  if (nonEmpty.length === 0 || !nonEmpty.every((c) => /^\*\*[\s\S]+\*\*$/.test(c) && !c.slice(2, -2).includes('**'))) return row;
  return row.map((c) => (c.trim() === '' ? c : c.slice(2, -2)));
}

export function gridToMarkdown(grid: Grid): string {
  const rows = grid.rows;
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (rows.length === 0 || width === 0) return grid.caption ? `**${grid.caption}**` : '';
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  const [headerRaw, ...body] = norm;
  const header = unwrapBoldHeader(headerRaw ?? []);
  const line = (cells: string[]): string => `| ${cells.map((c) => (c === '' ? ' ' : c)).join(' | ')} |`;
  const out = [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...body.map(line)];
  const table = out.join('\n');
  return grid.caption ? `**${grid.caption}**\n\n${table}` : table;
}

export interface TableOptions {
  /** The table is a confirmed Quip spreadsheet (inside data-section-style="13"): strip its letter header and row numbers. */
  spreadsheet?: boolean;
}

export function renderTable(cx: Cx, table: Element, opts: TableOptions = {}): string {
  const grid = tableToGrid(cx, table);
  grid.rows = opts.spreadsheet === true ? normalizeSpreadsheetGrid(grid.rows) : trimEmptyEdges(grid.rows);
  return gridToMarkdown(grid);
}

const DEFAULT_SHEET_NAME = /^sheet\s*\d*$/i;

/** Spreadsheet wrapper (`data-section-style="13"`): one table per sheet. */
export function renderSpreadsheet(cx: Cx, wrapper: Element, opts: { standalone: boolean }): string {
  const tables = Array.from(wrapper.querySelectorAll('table')).filter((t) => !t.parentElement?.closest('table'));
  const parts: string[] = [];
  const multi = tables.length > 1;
  for (const table of tables) {
    const title = (table.getAttribute('title') ?? '').trim();
    const md = renderTable(cx, table, { spreadsheet: true });
    if (!md) continue;
    cx.embed('spreadsheet');
    let heading = '';
    const showTitle = title && (opts.standalone ? multi || !DEFAULT_SHEET_NAME.test(title) : !DEFAULT_SHEET_NAME.test(title));
    if (showTitle) {
      const safeTitle = escapeInline(title);
      heading = opts.standalone ? `## ${safeTitle}` : `**${safeTitle}**`;
    }
    parts.push(heading ? `${heading}\n\n${md}` : md);
  }
  return parts.join('\n\n');
}
