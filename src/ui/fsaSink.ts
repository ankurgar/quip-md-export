import { splitSafePath, type Sink } from '../core/sink';

const isMissing = (err: unknown): boolean => err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

/** Writes into a folder the user picked (File System Access API). Also works on the origin-private file system. */
export class FsaSink implements Sink {
  private readonly dirs = new Map<string, FileSystemDirectoryHandle>();

  constructor(private readonly root: FileSystemDirectoryHandle) {
    this.dirs.set('', root);
  }

  private async dir(path: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    const cached = this.dirs.get(path);
    if (cached) return cached;
    const parts = path.split('/');
    const name = parts[parts.length - 1] as string;
    const parent = await this.dir(parts.slice(0, -1).join('/'), create);
    if (!parent) return undefined;
    try {
      const handle = await parent.getDirectoryHandle(name, { create });
      this.dirs.set(path, handle);
      return handle;
    } catch (err) {
      if (!create && isMissing(err)) return undefined;
      throw err;
    }
  }

  async ensureDir(path: string): Promise<void> {
    if (path === '') return;
    splitSafePath(path);
    await this.dir(path, true);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const parts = splitSafePath(path);
    const name = parts.pop() as string;
    const dirPath = parts.join('/');
    // A cached handle goes stale if the user deletes or renames a folder mid-export: retry once with a fresh walk.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const dir = (await this.dir(dirPath, true)) as FileSystemDirectoryHandle;
        const file = await dir.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        try {
          await writable.write(data as unknown as FileSystemWriteChunkType);
        } finally {
          await writable.close();
        }
        return;
      } catch (err) {
        if (attempt >= 1 || !(err instanceof DOMException)) throw err;
        this.dirs.clear();
        this.dirs.set('', this.root);
      }
    }
  }

  private async file(path: string): Promise<File | undefined> {
    const parts = splitSafePath(path);
    const name = parts.pop() as string;
    const dir = await this.dir(parts.join('/'), false);
    if (!dir) return undefined;
    try {
      return await (await dir.getFileHandle(name)).getFile();
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }

  async readText(path: string): Promise<string | undefined> {
    return (await this.file(path))?.text();
  }

  async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    return (await this.file(path))?.slice(0, maxBytes).text();
  }

  async exists(path: string): Promise<boolean> {
    return (await this.file(path)) !== undefined;
  }
}
