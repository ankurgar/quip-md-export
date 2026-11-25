import { describe, expect, it } from 'vitest';
import { frontMatter, relativeLink, relativePath, usecToIso } from '../../src/core/links';
import { codeSpan, encodePathSegment, escapeInline, fencedBlock, linkDest } from '../../src/core/markdownUtils';
import { PathAllocator, sanitizeName } from '../../src/core/naming';

describe('sanitizeName', () => {
  it('replaces characters that are illegal on common file systems', () => {
    expect(sanitizeName('Q3/Q4: plan? "final" <v2> |x|')).toBe('Q3-Q4 - plan - final - v2 - x');
  });

  it('never produces hidden, empty or reserved names', () => {
    expect(sanitizeName('.hidden')).toBe('_hidden');
    expect(sanitizeName('...')).toBe('Untitled');
    expect(sanitizeName('')).toBe('Untitled');
    expect(sanitizeName('   ')).toBe('Untitled');
    expect(sanitizeName('CON')).toBe('CON_');
    expect(sanitizeName('trailing dots...  ')).toBe('trailing dots');
  });

  it('keeps unicode and emoji and normalises to NFC', () => {
    expect(sanitizeName('Café ☕ 計画')).toBe('Café ☕ 計画');
    expect(sanitizeName('e\u0301')).toBe('é');
    expect(sanitizeName('zero\u200bwidth')).toBe('zerowidth');
  });

  it('caps length by code points and by UTF-8 bytes without splitting a character', () => {
    const ascii = sanitizeName('x'.repeat(300));
    expect(ascii.length).toBe(120);
    const emoji = sanitizeName('😀'.repeat(300));
    expect(new TextEncoder().encode(emoji).length).toBeLessThanOrEqual(180);
    expect(Array.from(emoji).every((c) => c === '😀')).toBe(true);
    const cjk = sanitizeName('計'.repeat(300));
    expect(new TextEncoder().encode(cjk).length).toBeLessThanOrEqual(180);
  });
});

describe('PathAllocator', () => {
  it('disambiguates case-insensitively and keeps a name stable while its folder and title are unchanged', () => {
    const a = new PathAllocator();
    expect(a.allocate('t1', 'Work', 'Notes', '.md')).toBe('Work/Notes.md');
    expect(a.allocate('t2', 'Work', 'notes', '.md')).toBe('Work/notes (2).md');
    expect(a.allocate('t3', 'Work', 'NOTES', '.md')).toBe('Work/NOTES (3).md');
    expect(a.allocate('t2', 'Work', 'notes', '.md')).toBe('Work/notes (2).md');
    expect(a.allocate('t1', 'Work', 'NOTES', '.md')).toBe('Work/Notes.md'); // a case-only change is not a rename
  });

  it('gives a document a new path when its folder or title changes, and never hands out the old one again', () => {
    const a = new PathAllocator();
    expect(a.allocate('t1', 'Work', 'Notes', '.md')).toBe('Work/Notes.md');
    expect(a.allocate('t1', 'Elsewhere', 'Notes', '.md')).toBe('Elsewhere/Notes.md');
    expect(a.allocate('t1', 'Elsewhere', 'Renamed', '.md')).toBe('Elsewhere/Renamed.md');
    expect(a.allocate('t9', 'Work', 'Notes', '.md')).toBe('Work/Notes (2).md'); // the stale copy still occupies its name
  });

  it('honours a seeded snapshot so re-runs keep their paths and new items avoid them', () => {
    const first = new PathAllocator();
    first.allocate('t1', '', 'Doc', '.md');
    const second = new PathAllocator(first.snapshot());
    expect(second.get('t1')).toBe('Doc.md');
    expect(second.allocate('t9', '', 'Doc', '.md')).toBe('Doc (2).md');
  });

  it('lets a folder and a file share a name stem', () => {
    const a = new PathAllocator();
    expect(a.allocate('f1', '', 'Plans')).toBe('Plans');
    expect(a.allocate('t1', '', 'Plans', '.md')).toBe('Plans.md');
  });

  it('keeps reserved names for the tool itself', () => {
    const a = new PathAllocator();
    a.reserve('_Quip export report.md');
    expect(a.allocate('t1', '', '_Quip export report', '.md')).toBe('_Quip export report (2).md');
  });

  it('skips names that something else already occupies, and never reuses a rejected name', async () => {
    const a = new PathAllocator();
    const occupied = new Set(['Work/Notes.md', 'Work/Notes (2).md']);
    const free = (p: string): Promise<boolean> => Promise.resolve(!occupied.has(p));
    expect(await a.allocateFree('t1', 'Work', 'Notes', '.md', free)).toBe('Work/Notes (3).md');
    expect(await a.allocateFree('t2', 'Work', 'Notes', '.md', () => Promise.resolve(true))).toBe('Work/Notes (4).md');
    expect(await a.allocateFree('t1', 'Work', 'Notes', '.md', () => Promise.resolve(false))).toBe('Work/Notes (3).md'); // stable, no re-check
  });
});

describe('relative links', () => {
  it('computes paths between nested files', () => {
    expect(relativePath('A/B/doc.md', 'A/B/other.md')).toBe('other.md');
    expect(relativePath('A/B/doc.md', 'A/C/other.md')).toBe('../C/other.md');
    expect(relativePath('doc.md', 'A/other.md')).toBe('A/other.md');
    expect(relativePath('A/B/C/doc.md', '_attachments/T/x.png')).toBe('../../../_attachments/T/x.png');
  });

  it('percent-encodes segments so spaces and parentheses are valid in Markdown', () => {
    expect(relativeLink('A/doc.md', 'My Folder/Plan (v2).md')).toBe('../My%20Folder/Plan%20%28v2%29.md');
  });
});

describe('frontMatter and timestamps', () => {
  it('emits quoted YAML and skips empty values', () => {
    const fm = frontMatter({ title: 'He said "hi": ok', quip_id: 'abc', n: 3, ok: true, tags: ['a', 'b'], empty: [], missing: undefined });
    expect(fm).toBe(['---', 'title: "He said \\"hi\\": ok"', 'quip_id: "abc"', 'n: 3', 'ok: true', 'tags:', '  - "a"', '  - "b"', '---'].join('\n'));
  });

  it('converts microsecond timestamps to ISO strings', () => {
    expect(usecToIso(1_605_686_400_000_000)).toBe('2020-11-18T08:00:00.000Z');
    expect(usecToIso(undefined)).toBeUndefined();
  });
});

describe('markdown helpers', () => {
  it('wraps destinations that contain spaces or parentheses', () => {
    expect(linkDest('https://a.b/c')).toBe('https://a.b/c');
    expect(linkDest('https://a.b/c d')).toBe('<https://a.b/c d>');
    expect(linkDest('https://a.b/c(1)')).toBe('<https://a.b/c(1)>');
  });

  it('chooses fences longer than any run inside', () => {
    expect(codeSpan('a')).toBe('`a`');
    expect(codeSpan('`')).toBe('`` ` ``');
    expect(fencedBlock('x\n', 'ts')).toBe('```ts\nx\n```');
  });

  it('encodes path segments strictly', () => {
    expect(encodePathSegment("a b(c)!'*")).toBe('a%20b%28c%29%21%27%2A');
  });

  it('escapes but keeps readable text', () => {
    expect(escapeInline('plain text, snake_case, 5 * 3')).toBe('plain text, snake_case, 5 \\* 3');
  });
});
