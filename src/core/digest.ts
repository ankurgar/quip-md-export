/**
 * A fast, non-cryptographic fingerprint of some bytes. It is only used to tell whether a file on disk is still
 * exactly what this tool wrote, so that a file someone edited or replaced is never overwritten.
 */
export function digest(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef ^ bytes.length;
  let h2 = 0x41c6ce57 ^ bytes.length;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${bytes.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** The fingerprint of text as it is stored on disk (UTF-8). */
export const digestText = (text: string): string => digest(new TextEncoder().encode(text));
