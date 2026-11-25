import { relativeLink } from './links';

export interface RewriteContext {
  /** Root-relative path of the note being written. */
  from: string;
  /** Root-relative path of a downloaded attachment, or null/undefined when it could not be fetched. */
  blobPath: (key: string) => string | null | undefined;
  /** Root-relative path of another exported note, if the target is part of this export. */
  docPath: (idOrSecret: string) => string | undefined;
  /** True when the id belongs to a person: Quip uses the same URL shape for @mentions and documents. */
  isUser?: (id: string) => boolean;
  /** Site used for links to documents outside this export. */
  siteUrl: string;
}

export interface RewriteResult {
  markdown: string;
  unresolvedDocs: string[];
  missingBlobs: string[];
}

/** Images and links the converter emitted with `quip-blob:` / `quip-doc:` placeholders. Labels never contain an unescaped `[`. */
const SENTINEL = /(!?)\[((?:\\.|[^[\]\\])*)\]\((quip-blob|quip-doc):([^)\s]+)\)/g;

/** Turns converter placeholders into relative links, or visible markers when the target is unavailable. */
export function rewriteSentinels(markdown: string, ctx: RewriteContext): RewriteResult {
  const unresolvedDocs = new Set<string>();
  const missingBlobs = new Set<string>();
  const out = markdown.replace(SENTINEL, (_m, bang: string, label: string, scheme: string, target: string) => {
    if (scheme === 'quip-blob') {
      const path = ctx.blobPath(target);
      if (path) return `${bang}[${label}](${relativeLink(ctx.from, path)})`;
      missingBlobs.add(target);
      return bang ? `*[missing image${label ? `: ${label}` : ''}]*` : `${label || 'attachment'} *(attachment unavailable)*`;
    }
    const path = ctx.docPath(target);
    if (path) return `[${label}](${relativeLink(ctx.from, path)})`;
    if (ctx.isUser?.(target)) return label;
    unresolvedDocs.add(target);
    return `[${label}](${ctx.siteUrl.replace(/\/+$/, '')}/${target})`;
  });
  return { markdown: out, unresolvedDocs: [...unresolvedDocs], missingBlobs: [...missingBlobs] };
}

const TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

function sniff(bytes: Uint8Array): string | undefined {
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return '.png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return '.jpg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return '.gif';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45) return '.webp';
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return '.pdf';
  return undefined;
}

export function attachmentExtension(contentType: string, hint: string | undefined, bytes: Uint8Array): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const fromType = TYPE_EXT[type];
  if (fromType) return fromType;
  const fromBytes = sniff(bytes);
  if (fromBytes) return fromBytes;
  const fromHint = hint ? /\.([A-Za-z0-9]{1,8})$/.exec(hint.trim()) : null;
  return fromHint?.[1] ? `.${fromHint[1].toLowerCase()}` : '.bin';
}

export function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
}
