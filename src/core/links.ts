import { encodePathSegment, yamlString } from './markdownUtils';
import { dirname } from './naming';

/** Relative path from the directory of `fromFile` to `toPath` (both root-relative, `/`-separated). */
export function relativePath(fromFile: string, toPath: string): string {
  const from = dirname(fromFile).split('/').filter(Boolean);
  const to = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i += 1;
  const up = from.length - i;
  const rel = [...Array<string>(up).fill('..'), ...to.slice(i)];
  return rel.join('/');
}

/** Relative path, percent-encoded segment by segment so it is a valid Markdown link destination. */
export function relativeLink(fromFile: string, toPath: string): string {
  return relativePath(fromFile, toPath)
    .split('/')
    .map((seg) => (seg === '..' || seg === '.' ? seg : encodePathSegment(seg)))
    .join('/');
}

export function usecToIso(usec: number | undefined): string | undefined {
  if (!usec || !Number.isFinite(usec)) return undefined;
  const d = new Date(Math.round(usec / 1000));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * True when the text starts with a front-matter block that names this document, so a note is recognised as
 * the tool's own by what the tool wrote at the top, not by a line that happens to appear somewhere in a body.
 */
export function frontMatterHasId(head: string, id: string): boolean {
  if (!/^---\r?\n/.test(head)) return false;
  const end = head.indexOf('\n---', 3);
  const block = end === -1 ? head : head.slice(0, end);
  return new RegExp(`^quip_id:\\s*"${id}"\\s*$`, 'm').test(block);
}

type FrontMatterValue = string | number | boolean | string[] | undefined;

export function frontMatter(fields: Record<string, FrontMatterValue>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const v of value) lines.push(`  - ${yamlString(v)}`);
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${yamlString(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}
