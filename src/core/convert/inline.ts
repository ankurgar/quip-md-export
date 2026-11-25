import { codeSpan, collapseWs, escapeInline, linkDest, stripZeroWidth } from '../markdownUtils';
import type { Cx } from './context';
import { dayFromEpoch } from './dates';
import { classifyUrl } from './urls';

/** How a `<br>` is rendered: hard break in paragraphs, `<br>` in tables/lists, space in headings. */
export interface InlineMode {
  br: 'hard' | 'html' | 'space';
  /** Set while rendering inside an element that is already bold, italic or struck through, so nesting adds no second pair of marks. */
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

const tagOf = (el: Element): string => el.tagName.toLowerCase();

export function wrapMarks(open: string, inner: string, close = open): string {
  if (!inner.trim()) return inner;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m) return inner;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function styleFlags(el: Element): { bold: boolean; italic: boolean; strike: boolean; underline: boolean } {
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  return {
    bold: /font-weight\s*:\s*(bold|[6-9]00)/.test(style),
    italic: /font-style\s*:\s*italic/.test(style),
    strike: /text-decoration[^;]*line-through/.test(style),
    underline: /text-decoration[^;]*underline/.test(style),
  };
}

export function renderImage(cx: Cx, img: Element): string {
  const src = img.getAttribute('src') ?? '';
  const alt = (img.getAttribute('alt') ?? img.getAttribute('title') ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (/^data:/i.test(src)) {
    // Quip uses a tiny transparent GIF as an "add an image" placeholder.
    if (src.length > 256) cx.warn('inline-data-image-skipped', `${src.length} chars`);
    return '';
  }
  const url = classifyUrl(src);
  const safeAlt = alt.replace(/[[\]]/g, '\\$&');
  if (url.kind === 'blob') {
    return `![${safeAlt}](${cx.blob(url.threadId, url.blobId, 'image', alt || undefined)})`;
  }
  if (url.kind === 'external') {
    return `![${safeAlt}](${linkDest(url.url)})`;
  }
  return '';
}

function renderLink(cx: Cx, a: Element, mode: InlineMode): string {
  const inner = renderInline(cx, a, mode);
  const href = a.getAttribute('href');
  const url = classifyUrl(href);
  if (url.kind === 'none') return inner;
  const label = inner.trim();
  if (url.kind === 'blob') {
    const hint = (a.textContent ?? '').trim() || undefined;
    const dest = cx.blob(url.threadId, url.blobId, 'file', hint);
    return label ? `[${label}](${dest})` : `[attachment](${dest})`;
  }
  const dest = url.kind === 'doc' ? cx.doc(url.id, href ?? undefined) : linkDest(url.url);
  if (!label) {
    if (url.kind !== 'external') return `[${url.id}](${dest})`;
    // A bare <autolink> cannot hold whitespace or angle brackets, so anything unusual becomes a normal link.
    return /^[^\s<>]+$/.test(url.url) ? `<${url.url}>` : `[${escapeInline(url.url)}](${dest})`;
  }
  // Text that is just the URL reads better as an autolink.
  if (url.kind === 'external' && /^https?:\/\//i.test(url.url) && !/[\s<>]/.test(url.url) && (a.textContent ?? '').trim() === url.url) {
    return `<${url.url}>`;
  }
  return `[${label}](${dest})`;
}

export function renderInlineNode(cx: Cx, node: Node, mode: InlineMode): string {
  if (node.nodeType === 3) {
    return escapeInline(collapseWs(stripZeroWidth(node.nodeValue ?? '')));
  }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = tagOf(el);

  switch (tag) {
    case 'br':
      return mode.br === 'hard' ? '  \n' : mode.br === 'html' ? '<br>' : ' ';
    case 'img':
      return renderImage(cx, el);
    case 'a':
      return renderLink(cx, el, mode);
    case 'code':
    case 'kbd':
    case 'tt':
    case 'samp':
      return codeSpan(stripZeroWidth(el.textContent ?? '').replace(/\s+/g, ' ').trim());
    case 'script':
    case 'style':
    case 'input':
    case 'button':
      return '';
    case 'control': {
      // Quip wraps attachments, dates and mentions in <control>. One that renders to nothing is flagged, never silently dropped.
      const inner = renderInline(cx, el, mode);
      if (inner.trim() !== '') return inner;
      // A date control can keep its date in an attribute and nothing as content.
      const day = el.hasAttribute('date-ms') ? dayFromEpoch(el.getAttribute('date-ms'), cx.opts.timeZone, (guess) => cx.warn('ambiguous-date', guess)) : undefined;
      if (day) return day;
      cx.warn('empty-control', el.getAttribute('data-remapped') ?? el.getAttribute('id') ?? '');
      return '<!-- empty Quip control -->';
    }
    default:
      break;
  }

  const flags = styleFlags(el);
  const isBold = tag === 'b' || tag === 'strong' || flags.bold;
  const isItalic = tag === 'i' || tag === 'em' || tag === 'cite' || flags.italic;
  const isStrike = tag === 's' || tag === 'strike' || tag === 'del' || flags.strike;
  const isUnderline = tag === 'u' || tag === 'ins' || (flags.underline && !isStrike && tag !== 'a');
  let out = renderInline(cx, el, { ...mode, ...(isBold ? { bold: true } : {}), ...(isItalic ? { italic: true } : {}), ...(isStrike ? { strike: true } : {}) });
  if (isUnderline) out = wrapMarks('<u>', out, '</u>');
  if (isStrike && !mode.strike) out = wrapMarks('~~', out);
  if (isItalic && !mode.italic) out = wrapMarks('*', out);
  if (isBold && !mode.bold) out = wrapMarks('**', out);
  if (tag === 'sup') out = wrapMarks('<sup>', out, '</sup>');
  if (tag === 'sub') out = wrapMarks('<sub>', out, '</sub>');
  return out;
}

export function renderInline(cx: Cx, parent: Node, mode: InlineMode): string {
  let out = '';
  for (const child of Array.from(parent.childNodes)) out += renderInlineNode(cx, child, mode);
  return out;
}

export function renderInlineNodes(cx: Cx, nodes: Node[], mode: InlineMode): string {
  let out = '';
  for (const n of nodes) out += renderInlineNode(cx, n, mode);
  return out;
}

const FORMATTING_TAGS = new Set(['b', 'strong', 'i', 'em', 's', 'strike', 'del', 'u', 'code']);

const canonical = (tag: string): string => (tag === 'strong' ? 'b' : tag === 'em' ? 'i' : tag === 'strike' || tag === 'del' ? 's' : tag);

/**
 * Merges runs like `<b>a</b><b>b</b>` into `<b>ab</b>` so we never emit `**a****b**`,
 * which CommonMark parses incorrectly.
 */
export function normalizeInline(root: ParentNode): void {
  const all = [root as unknown as Element, ...Array.from(root.querySelectorAll('*'))];
  for (const parent of all) {
    let child = parent.firstChild;
    while (child) {
      const next = child.nextSibling;
      if (
        child.nodeType === 1 &&
        next &&
        next.nodeType === 1 &&
        FORMATTING_TAGS.has(tagOf(child as Element)) &&
        canonical(tagOf(child as Element)) === canonical(tagOf(next as Element)) &&
        !(child as Element).getAttribute('style') &&
        !(next as Element).getAttribute('style')
      ) {
        while ((next as Element).firstChild) child.appendChild((next as Element).firstChild as ChildNode);
        parent.removeChild(next);
        continue;
      }
      child = next;
    }
  }
}
