import {
  BLOB_SCHEME,
  DOC_SCHEME,
  DOC_VARIANT,
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

  private readonly docVariants = new Map<string, string[]>();
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

  /**
   * Registers a link to another document and returns the placeholder the exporter resolves later. Each distinct
   * address that links to the same document gets its own placeholder, so that when the target is outside the
   * export every link keeps the address it had (a different section, say) rather than the first one seen.
   */
  doc(idOrSecretPath: string, href?: string): string {
    this.docLinks.add(idOrSecretPath);
    if (!href) return `${DOC_SCHEME}${idOrSecretPath}`;
    const seen = this.docVariants.get(idOrSecretPath) ?? [];
    let index = seen.indexOf(href);
    if (index < 0) {
      index = seen.push(href) - 1;
      this.docVariants.set(idOrSecretPath, seen);
    }
    const key = index === 0 ? idOrSecretPath : `${idOrSecretPath}${DOC_VARIANT}${index}`;
    this.docUrls[key] = href;
    return `${DOC_SCHEME}${key}`;
  }

  userName(id: string): string {
    const name = this.opts.userNames?.get(id);
    if (name) return name;
    this.unknownUsers.add(id);
    return id;
  }
}
