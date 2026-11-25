// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/core/convert';
import type { ConvertOptions } from '../../src/core/types';

const convert = (html: string, extra: Partial<ConvertOptions> = {}) => htmlToMarkdown(html, { threadId: 'T1abcdefghi', ...extra });
const md = (html: string, extra: Partial<ConvertOptions> = {}) => convert(html, extra).markdown.trimEnd();

describe('inline formatting and escaping', () => {
  it('maps emphasis tags and keeps whitespace outside the markers', () => {
    expect(md('<p>a <b> bold </b> <i>it</i> <s>gone</s> <u>und</u></p>')).toBe('a  **bold**  *it* ~~gone~~ <u>und</u>');
  });

  it('merges adjacent runs of the same mark instead of emitting ****', () => {
    expect(md('<p><b>one</b><b>two</b> <strong>three</strong></p>')).toBe('**onetwo** **three**');
  });

  it('honours inline styles used instead of tags', () => {
    expect(md(`<p><span style="font-weight: bold">b</span><span style="font-style: italic">i</span></p>`)).toBe('**b***i*');
  });

  it('escapes characters that Markdown or Obsidian would interpret', () => {
    const out = md('<p>Pay $5 and $10, tag #todo, *star*, [x](y), ==hi== %%c%% a_b _lead trail_ &lt;tag&gt; &amp;amp;</p>');
    expect(out).toContain('\\$5');
    expect(out).toContain('\\#todo');
    expect(out).toContain('\\*star\\*');
    expect(out).toContain('\\[x\\](y)');
    expect(out).toContain('\\=\\=hi\\=\\=');
    expect(out).toContain('\\%\\%c\\%\\%');
    expect(out).toContain('a_b'); // intraword underscore is safe
    expect(out).toContain('\\_lead');
    expect(out).toContain('trail\\_');
    expect(out).toContain('\\<tag>');
  });

  it('escapes block markers at the start of a paragraph', () => {
    expect(md('<p>1. not a list</p>')).toBe('1\\. not a list');
    expect(md('<p>- not a bullet</p>')).toBe('\\- not a bullet');
    expect(md('<p># not a heading</p>')).toBe('\\# not a heading');
    expect(md('<p>&gt; not a quote</p>')).toBe('\\> not a quote');
  });

  it('renders <br> as a hard break in paragraphs and drops empty paragraphs', () => {
    expect(md('<p>one<br>two</p><p class="line"><br/></p><p>\u200b</p>')).toBe('one  \ntwo');
  });

  it('uses safe code spans', () => {
    expect(md('<p><code>a`b</code></p>')).toBe('``a`b``');
  });

  it('turns headings into ATX headings on a single line', () => {
    expect(md('<h2>Big<br>Title</h2><h3>Small</h3>')).toBe('## Big Title\n\n### Small');
  });
});

describe('links, images and attachments', () => {
  it('rewrites links to other Quip docs to sentinels and keeps external links', () => {
    const r = convert(`<p><a href="https://acme.quip.com/YFEBthreadA1/February-2021#temp:C:xyz">Feb</a> <a href="/AbCdEfGhIjKl/Doc">rel</a> <a href="https://example.com/a b">ext</a></p>`);
    expect(r.markdown.trim()).toBe('[Feb](quip-doc:YFEBthreadA1) [rel](quip-doc:AbCdEfGhIjKl) [ext](<https://example.com/a b>)');
    expect(r.docLinks).toEqual(['YFEBthreadA1', 'AbCdEfGhIjKl']);
  });

  it('does not mistake ordinary Quip pages for documents', () => {
    expect(md('<p><a href="https://quip.com/subscription">s</a><a href="https://quip.com/browse">b</a></p>')).toBe(
      '[s](https://quip.com/subscription)[b](https://quip.com/browse)',
    );
  });

  it('collects blob images (relative and absolute forms) once each', () => {
    const r = convert(`<div data-section-style="11"><img src="/blob/T1abcdefghi/Bone" alt="a"></div><p><img src="https://quip.com/blob/T1abcdefghi/Bone"><img src="https://platform.quip.com/1/blob/T1abcdefghi/Btwo"></p>`);
    expect(r.blobs.map((b) => b.blobId)).toEqual(['Bone', 'Btwo']);
    expect(r.markdown).toContain('![a](quip-blob:T1abcdefghi/Bone)');
    expect(r.markdown).toContain('![](quip-blob:T1abcdefghi/Btwo)');
  });

  it('treats blob links as file attachments and external images as plain links', () => {
    const r = convert(`<p><a href="/blob/T1abcdefghi/Bpdf">report.pdf</a> <img src="https://cdn.example.com/x.png" alt="x"></p>`);
    expect(r.blobs).toEqual([{ threadId: 'T1abcdefghi', blobId: 'Bpdf', kind: 'file', hint: 'report.pdf' }]);
    expect(r.markdown).toContain('[report.pdf](quip-blob:T1abcdefghi/Bpdf)');
    expect(r.markdown).toContain('![x](https://cdn.example.com/x.png)');
  });

  it('skips the "add an image" spacer and warns about large inline data images', () => {
    const spacer = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    expect(md(`<div class="empty"><img src="${spacer}"></div>`)).toBe('');
    const big = `data:image/png;base64,${'A'.repeat(400)}`;
    const r = convert(`<p><img src="${big}"></p>`);
    expect(r.markdown).toBe('');
    expect(r.warnings.map((w) => w.code)).toContain('inline-data-image-skipped');
  });
});

describe('lists', () => {
  it('nests bullet lists and merges adjacent wrappers into one tight list', () => {
    const html = `<div data-section-style="5"><ul><li>A<ul><li>A1</li></ul></li></ul></div><div data-section-style="5"><ul><li>B</li></ul></div>`;
    expect(md(html)).toBe('- A\n  - A1\n- B');
  });

  it('treats a <ul> directly inside a <ul> as indentation', () => {
    expect(md(`<div data-section-style="5"><ul><li>A</li><ul><li>deep</li></ul><li>B</li></ul></div>`)).toBe('- A\n  - deep\n- B');
  });

  it('numbers Quip numbered lists (which use <ul>) and honours continue/restart', () => {
    const html = `
      <div data-section-style="6"><ul><li>one</li><li>two</li></ul></div>
      <div data-section-style="6" class="list-numbering-continue"><ul><li>three</li></ul></div>
      <p>break</p>
      <div data-section-style="6"><ul><li>again</li></ul></div>`;
    expect(md(html)).toBe('1. one\n2. two\n3. three\n\nbreak\n\n1. again');
  });

  it('indents nested items by the parent marker width', () => {
    const html = `<div data-section-style="6"><ul><li>a<ul><li>b</li></ul></li></ul></div>`;
    expect(md(html)).toBe('1. a\n   1. b');
  });

  it('renders checklists with checked state and treats "parent" rows as plain bullets', () => {
    const html = `<div data-section-style="7"><ul><li class="checked">done</li><li>todo</li><li class="parent">group</li></ul></div>`;
    expect(md(html)).toBe('- [x] done\n- [ ] todo\n- group');
  });

  it('handles bare <ul>/<ol> and skips empty items', () => {
    expect(md('<ul><li>x</li><li></li></ul><ol><li>y</li></ol>')).toBe('- x\n\n1. y');
  });

  it('uses <br> for line breaks inside list items so each item stays on one line', () => {
    expect(md(`<div data-section-style="5"><ul><li>a<br>b</li></ul></div>`)).toBe('- a<br>b');
  });

  it('escapes list-looking text inside items', () => {
    expect(md(`<div data-section-style="5"><ul><li>1. oops</li></ul></div>`)).toBe('- 1\\. oops');
  });
});

describe('tables and spreadsheets', () => {
  it('converts a plain table using the first row as header', () => {
    const html = `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2 | 3</td></tr></tbody></table>`;
    expect(md(html)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 \\| 3 |');
  });

  it('drops Quip spreadsheet chrome (letter header row, row-number column) and trims empty edges', () => {
    const html = `<div data-section-style="13"><table title="Sheet 1"><thead><tr><th></th><th>A</th><th>B</th><th>C</th></tr></thead><tbody>
      <tr><td>1</td><td class="bold">Name</td><td class="bold">Rent</td><td></td></tr>
      <tr><td>2</td><td>Ann</td><td>100</td><td></td></tr>
      <tr><td>3</td><td></td><td></td><td></td></tr></tbody></table></div>`;
    expect(md(html)).toBe('| Name | Rent |\n| --- | --- |\n| Ann | 100 |');
  });

  it('drops the letter row but keeps the first column when it is not a row-number column', () => {
    const html = `<table><thead><tr><th></th><th>A</th></tr></thead><tbody><tr><td>x</td><td>1</td></tr></tbody></table>`;
    expect(md(html)).toBe('| x | 1 |\n| --- | --- |');
  });

  it('names embedded sheets unless they carry the default name', () => {
    const named = `<div data-section-style="13"><table title="Budget"><tbody><tr><td>x</td></tr></tbody></table></div>`;
    expect(md(named)).toBe('**Budget**\n\n| x |\n| --- |');
    const plain = `<div data-section-style="13"><table title="Sheet 12"><tbody><tr><td>x</td></tr></tbody></table></div>`;
    expect(md(plain)).toBe('| x |\n| --- |');
  });

  it('renders every sheet of a standalone spreadsheet under an h2 heading', () => {
    const html = `<div data-section-style="13"><table title="Sheet 1"><tbody><tr><td>a</td></tr></tbody></table><table title="Sheet 2"><tbody><tr><td>b</td></tr></tbody></table></div>`;
    expect(md(html, { spreadsheetThread: true })).toBe('## Sheet 1\n\n| a |\n| --- |\n\n## Sheet 2\n\n| b |\n| --- |');
  });

  it('expands colspan and rowspan so columns stay aligned', () => {
    const html = `<table><tr><td colspan="2">wide</td><td>c</td></tr><tr><td rowspan="2">tall</td><td>b</td><td>c2</td></tr><tr><td>b2</td><td>c3</td></tr></table>`;
    expect(md(html)).toBe('| wide |   | c |\n| --- | --- | --- |\n| tall | b | c2 |\n|   | b2 | c3 |');
  });

  it('treats a full-width header row as a caption', () => {
    const html = `<table><tr><th colspan="3">Likes this quarter</th></tr><tr><td>83</td><td>75</td><td>3</td></tr></table>`;
    expect(md(html)).toBe('**Likes this quarter**\n\n| 83 | 75 | 3 |\n| --- | --- | --- |');
  });

  it('flattens lists and paragraphs inside cells', () => {
    const html = `<table><tr><td><ul><li>a</li><li>b</li></ul></td><td><p>x</p><p>y</p></td></tr></table>`;
    expect(md(html)).toBe('| • a<br>• b | x<br>y |\n| --- | --- |');
  });
});

describe('code, quotes and rules', () => {
  it('emits fenced code with language and longer fences when needed', () => {
    expect(md('<pre class="prettyprint lang-python">print(1)\nprint(2)</pre>')).toBe('```python\nprint(1)\nprint(2)\n```');
    expect(md('<pre>a ``` b</pre>')).toBe('````\na ``` b\n````');
  });

  it('quotes nested blocks', () => {
    expect(md('<blockquote><p>one</p><p>two</p></blockquote>')).toBe('> one\n>\n> two');
  });

  it('emits horizontal rules', () => {
    expect(md('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb');
  });

  it('prepends an escaped title heading on request', () => {
    expect(md('<p>x</p>', { titleHeading: { title: 'My #todo doc' } })).toBe('# My \\#todo doc\n\nx');
  });
});
