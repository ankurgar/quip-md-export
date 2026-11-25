const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const SEPARATOR_RUN = /[\s\\/:*?"<>|\u0000-\u001f\u007f]+/g;
/** APFS and ext4 limit a name to 255 bytes; leave room for " (2)" and an extension. */
const MAX_NAME_BYTES = 180;

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

function clip(s: string, maxChars: number, maxBytes: number): string {
  let out = '';
  let chars = 0;
  let bytes = 0;
  for (const ch of s) {
    const size = utf8Length(ch.codePointAt(0) ?? 0);
    if (chars + 1 > maxChars || bytes + size > maxBytes) break;
    out += ch;
    chars += 1;
    bytes += size;
  }
  return out;
}

/**
 * File/dir name that is safe on macOS, Windows and Linux and never hidden.
 * A run of illegal characters becomes "-", or " - " when whitespace touches it, so
 * "Q3/Q4: plan" reads as "Q3-Q4 - plan".
 */
export function sanitizeName(raw: string, fallback = 'Untitled', maxChars = 120): string {
  let s = (raw ?? '').normalize('NFC').replace(INVISIBLE, '');
  s = s.replace(SEPARATOR_RUN, (run) => (ILLEGAL.test(run) ? (/\s/.test(run) ? ' - ' : '-') : ' '));
  s = s.trim().replace(/^-+\s*/, '');
  s = s.replace(/^\.+/, (m) => '_'.repeat(m.length)).replace(/[\s.-]+$/, '');
  if (!s || /^[-_\s]+$/.test(s)) s = fallback;
  if (RESERVED_WINDOWS.test(s)) s = `${s}_`;
  const clipped = clip(s, maxChars, MAX_NAME_BYTES);
  if (clipped !== s) {
    s = clipped.replace(/[\s.-]+$/, '');
    if (!s) s = fallback;
  }
  return s;
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Hands out unique paths. Uniqueness is case-insensitive (default macOS/Windows file
 * systems) and allocations are keyed so a re-run reuses the previous path.
 */
export class PathAllocator {
  private readonly used = new Set<string>();
  private readonly byKey = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, path] of Object.entries(seed)) {
      this.byKey.set(key, path);
      this.used.add(path.toLowerCase());
    }
  }

  get(key: string): string | undefined {
    return this.byKey.get(key);
  }

  /** Re-registers a previously allocated path (used when resuming from saved state). */
  restore(key: string, path: string): void {
    this.byKey.set(key, path);
    this.used.add(path.toLowerCase());
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.byKey);
  }

  allocate(key: string, parentDir: string, desiredName: string, ext = ''): string {
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const base = sanitizeName(desiredName);
    let candidate = joinPath(parentDir, `${base}${ext}`);
    let n = 2;
    while (this.used.has(candidate.toLowerCase())) {
      candidate = joinPath(parentDir, `${base} (${n})${ext}`);
      n += 1;
    }
    this.used.add(candidate.toLowerCase());
    this.byKey.set(key, candidate);
    return candidate;
  }
}
