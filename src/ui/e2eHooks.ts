/**
 * Test-only helpers. Imported solely behind `if (__E2E__)`, so the production bundle never contains this file.
 * It deliberately sends a write request to prove the browser-level guard blocks it.
 */
/** An empty folder in the origin-private file system, standing in for the folder picker in tests. */
export async function freshTestTarget(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry('e2e-target', { recursive: true }).catch(() => undefined);
  return root.getDirectoryHandle('e2e-target', { create: true });
}

export function installTestHooks(getTarget: () => FileSystemDirectoryHandle | undefined): void {
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, out: Record<string, string>): Promise<void> => {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const path = `${prefix}${name}`;
      if (handle.kind === 'directory') {
        out[`${path}/`] = '';
        await walk(handle as FileSystemDirectoryHandle, `${path}/`, out);
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        out[path] = /\.(md|json|html|txt)$/.test(name) ? await file.text() : `<binary ${file.size} bytes>`;
      }
    }
  };
  const outcome = (p: Promise<Response>): Promise<string> =>
    p.then(
      (r) => `reached:${r.status}`,
      (e: unknown) => `blocked:${e instanceof Error ? e.name : 'error'}`,
    );
  (window as unknown as { __e2e: unknown }).__e2e = {
    readTree: async () => {
      const out: Record<string, string> = {};
      const target = getTarget();
      if (target) await walk(target, '', out);
      return out;
    },
    tryMutation: (url: string) => outcome(fetch(url, { method: 'POST', body: '{}' })),
    tryRead: (url: string) => outcome(fetch(url, { method: 'GET' })),
  };
}
