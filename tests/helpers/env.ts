import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { splitSafePath, type Sink } from '../../src/core/sink';

/** Writes into a real directory, so tests can inspect exactly what a user would see on disk. */
export class NodeFsSink implements Sink {
  constructor(readonly root: string) {}

  private abs(path: string): string {
    return join(this.root, ...splitSafePath(path));
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(path === '' ? this.root : this.abs(path), { recursive: true });
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const file = this.abs(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(this.abs(path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.abs(path)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    let handle;
    try {
      handle = await open(this.abs(path), 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }
}

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
