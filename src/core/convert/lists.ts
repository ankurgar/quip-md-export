import { escapeBlockStart } from '../markdownUtils';
import type { Cx } from './context';
import { renderInlineNodes, type InlineMode } from './inline';

export type ListKind = 'bullet' | 'number' | 'check';

const LIST_MODE: InlineMode = { br: 'html' };
const tagOf = (el: Element): string => el.tagName.toLowerCase();
const isListTag = (el: Element): boolean => tagOf(el) === 'ul' || tagOf(el) === 'ol';

interface Walk {
  lines: string[];
  /** Content offset (marker width) of the last item emitted at each depth. */
  widths: number[];
}

function indentFor(state: Walk, depth: number): string {
  let s = '';
  for (let d = 0; d < depth; d += 1) s += ' '.repeat(state.widths[d] ?? 2);
  return s;
}

function itemText(cx: Cx, li: Element): string {
  const nodes = Array.from(li.childNodes).filter((n) => !(n.nodeType === 1 && isListTag(n as Element)));
  return escapeBlockStart(renderInlineNodes(cx, nodes, LIST_MODE).trim());
}

function walkContainer(cx: Cx, container: Element, kind: ListKind, depth: number, state: Walk, continueNumbering: boolean): void {
  let n = continueNumbering ? (cx.numbering[depth] ?? 0) + 1 : 1;
  for (const child of Array.from(container.children)) {
    if (tagOf(child) === 'li') {
      const nested = Array.from(child.children).filter(isListTag);
      const text = itemText(cx, child);
      if (text === '' && nested.length === 0) continue;

      let marker: string;
      if (kind === 'number') marker = `${n}. `;
      else if (kind === 'check') marker = child.classList.contains('parent') ? '- ' : `- [${child.classList.contains('checked') ? 'x' : ' '}] `;
      else marker = '- ';

      state.lines.push(`${indentFor(state, depth)}${marker}${text}`.replace(/\s+$/, ''));
      state.widths[depth] = kind === 'check' ? 2 : marker.length;
      state.widths.length = depth + 1;
      if (kind === 'number') {
        cx.numbering[depth] = n;
        cx.numbering.length = depth + 1;
        n += 1;
      }
      for (const inner of nested) walkContainer(cx, inner, tagOf(inner) === 'ol' ? 'number' : kind, depth + 1, state, false);
    } else if (isListTag(child)) {
      // Quip sometimes expresses indentation as a <ul> directly inside a <ul>.
      walkContainer(cx, child, tagOf(child) === 'ol' ? 'number' : kind, depth + 1, state, false);
    }
  }
}

/** `div[data-section-style=5|6|7]` list wrapper. */
export function renderListWrapper(cx: Cx, wrapper: Element, kind: ListKind): string {
  const state: Walk = { lines: [], widths: [] };
  const cont = wrapper.classList.contains('list-numbering-continue');
  const containers = Array.from(wrapper.children).filter(isListTag);
  if (containers.length === 0) {
    walkContainer(cx, wrapper, kind, 0, state, cont);
  } else {
    for (const c of containers) walkContainer(cx, c, tagOf(c) === 'ol' ? 'number' : kind, 0, state, cont);
  }
  return state.lines.join('\n');
}

export function inferBareListKind(el: Element): ListKind {
  if (tagOf(el) === 'ol') return 'number';
  if (el.classList.contains('checklist') || el.querySelector('li.checked, li.unchecked')) return 'check';
  return 'bullet';
}

export function renderBareList(cx: Cx, list: Element): { text: string; kind: ListKind } {
  const kind = inferBareListKind(list);
  const state: Walk = { lines: [], widths: [] };
  walkContainer(cx, list, kind, 0, state, false);
  return { text: state.lines.join('\n'), kind };
}
