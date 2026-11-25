import { escapeBlockStart, fencedBlock, stripZeroWidth } from '../markdownUtils';
import type { Cx } from './context';
import { renderImage, renderInline, renderInlineNodes, type InlineMode } from './inline';
import { renderBareList, renderListWrapper, type ListKind } from './lists';
import { isLiveApp, renderLiveApp } from './liveApps';
import { renderSpreadsheet, renderTable } from './tables';

export interface Block {
  text: string;
  list?: ListKind;
  /** For numbered lists: this block continues the previous list's numbering. */
  continues?: boolean;
}

const PARA: InlineMode = { br: 'hard' };
const HEADING: InlineMode = { br: 'space' };

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'big', 'br', 'cite', 'code', 'del', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);

const tagOf = (el: Element): string => el.tagName.toLowerCase();

function tidyParagraph(text: string): string {
  return text.replace(/^(?:\s*\n)+/, '').replace(/(?:  \n|\s)+$/, '').trim();
}

export function joinBlocks(blocks: Block[]): string {
  let out = '';
  let prev: Block | undefined;
  for (const b of blocks) {
    if (!b.text.trim()) continue;
    if (prev) {
      const tight = prev.list !== undefined && prev.list === b.list && (b.list !== 'number' || b.continues === true);
      out += tight ? '\n' : '\n\n';
    }
    out += b.text;
    prev = b;
  }
  return out;
}

function preText(el: Element): string {
  let s = '';
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      s += n.nodeValue ?? '';
    } else if (n.nodeType === 1) {
      const e = n as Element;
      const t = tagOf(e);
      if (t === 'br') {
        s += '\n';
        return;
      }
      for (const c of Array.from(e.childNodes)) walk(c);
      if (t === 'div' || t === 'p') s += '\n';
    }
  };
  walk(el);
  return stripZeroWidth(s).replace(/\u00a0/g, ' ');
}

function codeLanguage(el: Element): string {
  const probe = [el, el.querySelector('code')].filter((x): x is Element => x !== null);
  for (const p of probe) {
    const m = /(?:^|\s)(?:lang|language)-([\w+#.-]+)/.exec(p.className);
    if (m?.[1]) return m[1];
    const data = p.getAttribute('data-lang') ?? p.getAttribute('data-language');
    if (data) return data;
  }
  return '';
}

function pushParagraph(out: Block[], text: string): void {
  const t = tidyParagraph(text);
  if (t) out.push({ text: escapeBlockStart(t) });
}

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((c) => !INLINE_TAGS.has(tagOf(c)));
}

function renderSectionWrapper(cx: Cx, el: Element, style: string, out: Block[]): boolean {
  switch (style) {
    case '5':
    case '6':
    case '7': {
      const kind: ListKind = style === '5' ? 'bullet' : style === '6' ? 'number' : 'check';
      const text = renderListWrapper(cx, el, kind);
      if (text) out.push({ text, list: kind, continues: el.classList.contains('list-numbering-continue') });
      return true;
    }
    case '8': {
      for (const table of Array.from(el.querySelectorAll('table')).filter((t) => !t.parentElement?.closest('table'))) {
        const md = renderTable(cx, table);
        if (md) out.push({ text: md });
      }
      return true;
    }
    case '11': {
      for (const img of Array.from(el.querySelectorAll('img'))) {
        const md = renderImage(cx, img);
        if (md) out.push({ text: md });
      }
      const caption = el.querySelector('figcaption');
      if (caption) pushParagraph(out, `*${renderInline(cx, caption, PARA).trim()}*`);
      return true;
    }
    case '13': {
      const md = renderSpreadsheet(cx, el, { standalone: cx.opts.spreadsheetThread === true });
      if (md) out.push({ text: md });
      return true;
    }
    default:
      return false;
  }
}

function renderBlockElement(cx: Cx, el: Element, out: Block[]): void {
  const tag = tagOf(el);

  if (isLiveApp(el)) {
    out.push({ text: renderLiveApp(cx, el) });
    return;
  }

  if (/^h[1-6]$/.test(tag)) {
    const text = renderInline(cx, el, HEADING).replace(/\s+/g, ' ').trim();
    if (text) out.push({ text: `${'#'.repeat(Number(tag[1]))} ${text}` });
    return;
  }

  switch (tag) {
    case 'p':
      pushParagraph(out, renderInline(cx, el, PARA));
      return;
    case 'ul':
    case 'ol': {
      const { text, kind } = renderBareList(cx, el);
      if (text) out.push({ text, list: kind });
      return;
    }
    case 'table': {
      const md = renderTable(cx, el);
      if (md) out.push({ text: md });
      return;
    }
    case 'pre': {
      const text = preText(el);
      if (text.trim()) out.push({ text: fencedBlock(text, codeLanguage(el)) });
      return;
    }
    case 'blockquote': {
      const inner: Block[] = [];
      renderBlocks(cx, el, inner);
      const text = joinBlocks(inner);
      if (text) out.push({ text: text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') });
      return;
    }
    case 'hr':
      out.push({ text: '---' });
      return;
    case 'img': {
      const md = renderImage(cx, el);
      if (md) out.push({ text: md });
      return;
    }
    case 'details': {
      const summary = Array.from(el.children).find((c) => tagOf(c) === 'summary');
      const label = summary ? renderInline(cx, summary, HEADING).trim() : '';
      if (label) out.push({ text: `**${label}**` });
      const inner: Block[] = [];
      for (const child of Array.from(el.childNodes)) {
        if (child === summary) continue;
        if (child.nodeType === 1) renderBlockElement(cx, child as Element, inner);
      }
      out.push(...inner);
      return;
    }
    case 'script':
    case 'style':
      return;
    default:
      break;
  }

  const style = el.getAttribute('data-section-style');
  if (style && renderSectionWrapper(cx, el, style, out)) return;

  if (hasBlockChild(el)) {
    renderBlocks(cx, el, out);
  } else {
    pushParagraph(out, renderInline(cx, el, PARA));
  }
}

export function renderBlocks(cx: Cx, parent: Element, out: Block[]): void {
  let run: Node[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    pushParagraph(out, renderInlineNodes(cx, run, PARA));
    run = [];
  };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      run.push(node);
    } else if (node.nodeType === 1) {
      const el = node as Element;
      if (INLINE_TAGS.has(tagOf(el)) && !isLiveApp(el)) {
        run.push(el);
      } else {
        flush();
        renderBlockElement(cx, el, out);
      }
    }
  }
  flush();
}
