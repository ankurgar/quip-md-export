import { escapeInline } from '../markdownUtils';
import type { ConvertOptions, ConvertResult } from '../types';
import { renderBlocks, joinBlocks, type Block } from './blocks';
import { Cx } from './context';
import { normalizeInline } from './inline';

export type HtmlParser = (html: string) => Document;

const defaultParser: HtmlParser = (html) => new DOMParser().parseFromString(html, 'text/html');

/**
 * Converts Quip thread HTML (`GET /2/threads/{id}/html`) to Markdown.
 *
 * The result may contain sentinel URLs (`quip-blob:` / `quip-doc:`) that the exporter resolves
 * once attachments are downloaded and every document's output path is known.
 */
export function htmlToMarkdown(html: string, options: ConvertOptions, parse: HtmlParser = defaultParser): ConvertResult {
  const doc = parse(html);
  const root = doc.body;
  normalizeInline(root);

  const cx = new Cx(options);
  const blocks: Block[] = [];
  if (options.titleHeading) blocks.push({ text: `# ${escapeInline(options.titleHeading.title)}` });
  renderBlocks(cx, root, blocks);
  const markdown = joinBlocks(blocks);

  return {
    markdown: markdown ? `${markdown}\n` : '',
    blobs: cx.blobs,
    docLinks: [...cx.docLinks],
    embeds: cx.embeds,
    warnings: cx.warnings,
    unknownUserIds: [...cx.unknownUsers],
  };
}
