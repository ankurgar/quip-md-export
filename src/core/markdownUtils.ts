/** Pure string helpers for emitting safe, Obsidian-friendly Markdown. */

/** Quip pads empty paragraphs with U+200B. ZWNJ/ZWJ are NOT removed: they are meaningful in Persian, Indic scripts and emoji sequences. */
const ZERO_WIDTH = /[\u200b\u2060\ufeff]/g;

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH, '');
}

/** Collapse HTML-style whitespace (but keep non-breaking spaces as plain spaces). */
export function collapseWs(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/[ \t\r\n\f]+/g, ' ');
}

/**
 * Escape characters that would change meaning in CommonMark / GFM / Obsidian.
 * Underscores are only escaped at word boundaries so snake_case stays readable.
 * `$`, `#tag`, `%%`, `==` and `[[` are escaped because Obsidian gives them meaning.
 */
export function escapeInline(text: string): string {
  let out = text.replace(/\\/g, '\\\\');
  out = out.replace(/[*`[\]$]/g, '\\$&');
  out = out.replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (m) => m.replace('_', '\\_'));
  out = out.replace(/<(?=[A-Za-z/!?])/g, '\\<');
  out = out.replace(/&(?=#?\w+;)/g, '\\&');
  out = out.replace(/~~/g, '\\~\\~');
  out = out.replace(/%%/g, '\\%\\%');
  out = out.replace(/==/g, '\\=\\=');
  out = out.replace(/(^|\s)#(?=[\p{L}_])/gu, '$1\\#');
  return out;
}

/** Escape block-level markers at the start of every line of a paragraph-like string. */
export function escapeBlockStart(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let l = line;
      l = l.replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3');
      l = l.replace(/^(\s*)>/, '$1\\>');
      l = l.replace(/^(\s*)([-+])(\s)/, '$1\\$2$3');
      l = l.replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4');
      l = l.replace(/^(\s*)([-=_]{3,}\s*)$/, '$1\\$2');
      return l;
    })
    .join('\n');
}

export function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim()) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function fencedBlock(text: string, lang = ''): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const runs = body.match(/`{3,}/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 2);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** Link destination: wrap in <> when it contains characters that end a bare destination. */
export function linkDest(url: string): string {
  if (/[\s()<>]/.test(url)) {
    return `<${url.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`;
  }
  return url;
}

export function encodePathSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** A YAML double-quoted scalar (JSON string syntax is valid YAML). */
export function yamlString(s: string): string {
  return JSON.stringify(s);
}

export function trimBlankLines(s: string): string {
  return s.replace(/^\n+/, '').replace(/\s+$/, '');
}
