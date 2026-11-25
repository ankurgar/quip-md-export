import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

export { NodeFsSink } from '../../src/node/nodeSink';

/** All files and directories under root as sorted root-relative paths (directories end with "/"). */
export async function listTree(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(`${path}/`, ...(await listTree(root, path)));
    } else out.push(path);
  }
  return out.sort();
}

export const parseHtml = (html: string): Document => new JSDOM(html).window.document;

/** A clock whose sleeps advance time instantly, so rate-limit waits cost nothing in tests. */
export function virtualClock(start = 1_700_000_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}
