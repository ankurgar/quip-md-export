import {
  BLOB_SCHEME,
  DOC_SCHEME,
  type BlobRef,
  type ConvertOptions,
  type Warning,
} from '../types';

/** Mutable state for one conversion run. */
export class Cx {
  readonly blobs: BlobRef[] = [];
  readonly docLinks = new Set<string>();
  readonly docUrls: Record<string, string> = {};
  readonly embeds: Record<string, number> = {};
  readonly warnings: Warning[] = [];
  readonly unknownUsers = new Set<string>();
  /** Ordered-list counters by depth, used to honour "continue numbering". */
  readonly numbering: number[] = [];

  private readonly blobKeys = new Set<string>();
  private readonly warnKeys = new Set<string>();

  constructor(readonly opts: ConvertOptions) {}

  warn(code: string, detail?: string): void {
    const key = `${code}|${detail ?? ''}`;
    if (this.warnKeys.has(key)) return;
    this.warnKeys.add(key);
    this.warnings.push(detail === undefined ? { code } : { code, detail });
  }

  embed(type: string): void {
    this.embeds[type] = (this.embeds[type] ?? 0) + 1;
  }

  /** Registers an attachment and returns the sentinel URL the exporter resolves later. */
  blob(threadId: string, blobId: string, kind: 'image' | 'file', hint?: string): string {
    const key = `${threadId}/${blobId}`;
    if (!this.blobKeys.has(key)) {
      this.blobKeys.add(key);
      const ref: BlobRef = { threadId, blobId, kind };
      if (hint) ref.hint = hint;
      this.blobs.push(ref);
    }
    return `${BLOB_SCHEME}${key}`;
  }

  doc(idOrSecretPath: string, href?: string): string {
    this.docLinks.add(idOrSecretPath);
    if (href && !(idOrSecretPath in this.docUrls)) this.docUrls[idOrSecretPath] = href;
    return `${DOC_SCHEME}${idOrSecretPath}`;
  }

  userName(id: string): string {
    const name = this.opts.userNames?.get(id);
    if (name) return name;
    this.unknownUsers.add(id);
    return id;
  }
}
