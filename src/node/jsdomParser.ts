import { JSDOM } from 'jsdom';
import type { HtmlParser } from '../core/convert';

/**
 * Parses with jsdom. The converter uses the document synchronously, so the window can be released on the next
 * turn of the event loop; left alone, jsdom keeps hundreds of kilobytes per document alive for the whole run.
 */
export const parseHtmlWithJsdom: HtmlParser = (html) => {
  const dom = new JSDOM(html);
  setImmediate(() => dom.window.close());
  return dom.window.document;
};
