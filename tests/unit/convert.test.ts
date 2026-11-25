// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/core/convert';
import { rewriteSentinels } from '../../src/core/rewrite';
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

  it('keeps zero-width joiners and non-joiners that carry meaning, and drops only Quip\'s padding', () => {
    expect(md('<p>می\u200cخواهم \u{1F469}\u200d\u{1F4BB} a\u200bb</p>')).toBe('می\u200cخواهم \u{1F469}\u200d\u{1F4BB} ab');
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

  it('recognises attachment links of the form quip.com/-/blob/<thread>/<blob>?name=…', () => {
    const r = convert(`<p><control data-remapped="true"><a href="https://quip.com/-/blob/NATTACHthr1/SyntheticBlobId0000001?name=Shortcut.lnk">Shortcut.lnk</a></control></p>`);
    expect(r.blobs).toEqual([{ threadId: 'NATTACHthr1', blobId: 'SyntheticBlobId0000001', kind: 'file', hint: 'Shortcut.lnk' }]);
    expect(r.markdown.trim()).toBe('[Shortcut.lnk](quip-blob:NATTACHthr1/SyntheticBlobId0000001)');
  });

  it('never lets an empty link with an unusual URL break out of an autolink', () => {
    const out = md('<p><a href="https://a.example/x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></a></p>');
    expect(out).not.toMatch(/(^|[^\\])<img/); // every '<' that could start HTML is backslash-escaped or percent-encoded
    expect(out.startsWith('[')).toBe(true);
    expect(md('<p><a href="https://a.example/ok"></a></p>')).toBe('<https://a.example/ok>');
  });

  it('flags a Quip control that renders to nothing instead of silently dropping it', () => {
    const r = convert('<p>before <control data-remapped="true"></control> after</p>');
    expect(r.markdown).toContain('<!-- empty Quip control -->');
    expect(r.warnings).toEqual([{ code: 'empty-control', detail: 'true' }]);
  });

  it('writes a link whose text is its own URL as an autolink', () => {
    expect(md('<p><a href="https://swagger.io">https://swagger.io</a> and <a href="https://a.example/x">the site</a></p>')).toBe('<https://swagger.io> and [the site](https://a.example/x)');
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

describe('nested emphasis', () => {
  it('does not wrap an already bold span in a second pair of marks', () => {
    expect(md('<p><b><b>Hello</b></b> <b>world</b></p>')).toBe('**Hello** **world**');
    expect(md('<p><b><span style="font-weight:bold">Hello</span> and <i>more</i></b></p>')).toBe('**Hello and *more***');
  });
});

describe('date controls', () => {
  it('renders a date that Quip keeps in an attribute, and lets visible content win when there is some', () => {
    expect(md('<p>Complete by <control date-ms="1550448000000" id="c1"></control>.</p>')).toBe('Complete by 2019-02-18.');
    expect(md('<p>Due <control date-ms="1550448000000">Feb 18</control></p>')).toBe('Due Feb 18');
  });

  it('knows the day when it is midnight in the reader\'s zone, and says when it had to guess', () => {
    const control = '<p><control date-ms="1572892200000"></control></p>'; // 2019-11-05 00:00 in India
    const known = convert(control, { timeZone: 'Asia/Kolkata' });
    expect(known.markdown.trim()).toBe('2019-11-05');
    expect(known.warnings).toEqual([]);
    const guessed = convert(control, { timeZone: 'UTC' });
    expect(guessed.markdown.trim()).toBe('2019-11-05');
    expect(guessed.warnings.map((w) => w.code)).toEqual(['ambiguous-date']);
  });

  it('still flags a control with neither content nor a date', () => {
    const r = convert('<p>x <control id="c2"></control></p>');
    expect(r.markdown.trim()).toBe('x <!-- empty Quip control -->');
    expect(r.warnings.map((w) => w.code)).toEqual(['empty-control']);
  });
});

describe('several links to one document', () => {
  const id = 'AbCdEfGhIjKl';
  const SITE = 'https://acme.quip.com';

  it('gives each distinct address its own placeholder, so none is replaced by the first one seen', () => {
    const r = htmlToMarkdown(`<p><a href="${SITE}/${id}/Doc#sec1">one</a> <a href="${SITE}/${id}/Doc#sec2">two</a> <a href="${SITE}/${id}/Doc#sec1">again</a></p>`, { threadId: 'T1abcdefghi' });
    expect(r.markdown.trim()).toBe(`[one](quip-doc:${id}) [two](quip-doc:${id}~1) [again](quip-doc:${id})`);
    expect(r.docUrls).toEqual({ [id]: `${SITE}/${id}/Doc#sec1`, [`${id}~1`]: `${SITE}/${id}/Doc#sec2` });
    expect(r.docLinks).toEqual([id]);
  });

  it('writes each original address back when the document is outside the export, and a relative one in full', () => {
    const r = htmlToMarkdown(`<p><a href="${SITE}/${id}/Doc#sec1">one</a> <a href="${SITE}/${id}/Doc#sec2">two</a> <a href="/${id}/Doc#sec3">three</a></p>`, { threadId: 'T1abcdefghi' });
    const out = rewriteSentinels(r.markdown, { from: 'Note.md', blobPath: () => undefined, docPath: () => undefined, originalUrl: (key) => r.docUrls[key], siteUrl: SITE });
    expect(out.markdown.trim()).toBe(`[one](${SITE}/${id}/Doc#sec1) [two](${SITE}/${id}/Doc#sec2) [three](${SITE}/${id}/Doc#sec3)`);
    expect(out.unresolvedDocs).toEqual([id]);
  });

  it('points every variant at the exported note when the document is inside the export', () => {
    const r = htmlToMarkdown(`<p><a href="${SITE}/${id}/Doc#sec1">one</a> <a href="${SITE}/${id}/Doc#sec2">two</a></p>`, { threadId: 'T1abcdefghi' });
    const out = rewriteSentinels(r.markdown, { from: 'A/Note.md', blobPath: () => undefined, docPath: (key) => (key === id ? 'B/Doc.md' : undefined), siteUrl: SITE });
    expect(out.markdown.trim()).toBe('[one](../B/Doc.md) [two](../B/Doc.md)');
    expect(out.unresolvedDocs).toEqual([]);
  });
});

describe('lists', () => {
  it("drops the meaningless <br/> Quip puts at the end of every list item, but keeps a break inside one", () => {
    // Shape seen in a real Quip export: <li><span>text</span>\n\n<br/></li>
    const html = `<div data-section-style='5'><ul><li><span>First</span>\n\n<br/></li><li>two<br/>lines<br/></li><li><br/></li><li>Parent<br/><ul><li>Child<br/></li></ul></li></ul></div>`;
    expect(md(html)).toBe('- First\n- two<br>lines\n- Parent\n  - Child');
  });

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

  it('drops the letter row of a confirmed spreadsheet but keeps a first column that is not row numbers', () => {
    const html = `<div data-section-style="13"><table><thead><tr><th></th><th>A</th></tr></thead><tbody><tr><td>x</td><td>1</td></tr></tbody></table></div>`;
    expect(md(html)).toBe('| x | 1 |\n| --- | --- |');
  });

  it('never strips data from an ordinary table, even one that looks like spreadsheet chrome', () => {
    const html = `<table><thead><tr><th></th><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>true</td><td>false</td></tr><tr><td>2</td><td>false</td><td>true</td></tr></tbody></table>`;
    expect(md(html)).toBe('|   | A | B |\n| --- | --- | --- |\n| 1 | true | false |\n| 2 | false | true |');
  });

  it("removes the <br> Quip puts at the end of every cell and drops a letters-only header row (real export shape)", () => {
    const cell = (text: string) => `<td id='s:R_C'><span id='s:R_C'>${text}</span>\n\n<br/></td>`;
    const html = `<div data-section-style='13'><table title='Sheet1'><thead><tr><th class='empty'>A<br/></th><th class='empty'>B<br/></th></tr></thead><tbody>
      <tr>${cell('Shortcut')}${cell('Action')}</tr><tr>${cell('Ctrl + Q')}${cell('open preview')}</tr><tr>${cell('')}${cell('')}</tr></tbody></table></div>`;
    expect(md(html)).toBe('| Shortcut | Action |\n| --- | --- |\n| Ctrl + Q | open preview |');
  });

  it('keeps a header row of letters in an ordinary table that is not a Quip spreadsheet', () => {
    expect(md('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
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
  it('drops a code language that is not a plain identifier, so it cannot inject markup', () => {
    expect(md('<pre data-lang="js\n</pre><script>alert(1)</script>">x</pre>')).toBe('```\nx\n```');
    expect(md('<pre class="lang-c++">x</pre>')).toBe('```c++\nx\n```');
  });

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
