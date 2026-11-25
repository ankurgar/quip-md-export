/** Where exported files go. The browser build writes through the File System Access API. */
export interface Sink {
  /** Creates a directory (and its parents). Used so empty Quip folders still exist in the target. */
  ensureDir(path: string): Promise<void>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readText(path: string): Promise<string | undefined>;
  /** The first `maxBytes` bytes as text, or undefined when the file does not exist. Cheap way to recognise a file. */
  readHead(path: string, maxBytes: number): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
}

/** Splits a root-relative path and refuses anything that could escape the target directory. */
export function splitSafePath(path: string): string[] {
  const parts = path.split('/');
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => p === '' || p === '.' || p === '..' || /[\\\u0000]/.test(p))) {
    throw new Error(`Refusing unsafe path: ${JSON.stringify(path)}`);
  }
  return parts;
}

export class MemorySink implements Sink {
  readonly files = new Map<string, string | Uint8Array>();
  readonly dirs = new Set<string>();

  ensureDir(path: string): Promise<void> {
    if (path !== '') splitSafePath(path);
    this.dirs.add(path);
    return Promise.resolve();
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    splitSafePath(path);
    this.files.set(path, data);
    return Promise.resolve();
  }

  readText(path: string): Promise<string | undefined> {
    const data = this.files.get(path);
    if (data === undefined) return Promise.resolve(undefined);
    return Promise.resolve(typeof data === 'string' ? data : new TextDecoder().decode(data));
  }

  async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    const data = this.files.get(path);
    if (data === undefined) return undefined;
    return typeof data === 'string' ? data.slice(0, maxBytes) : new TextDecoder().decode(data.subarray(0, maxBytes));
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
}
