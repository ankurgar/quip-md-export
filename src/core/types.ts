export type ThreadType = 'document' | 'spreadsheet' | 'slides' | 'chat' | 'unknown';

export interface ThreadMeta {
  id: string;
  title: string;
  type: ThreadType;
  secretPath?: string;
  link?: string;
  createdUsec?: number;
  updatedUsec?: number;
  authorId?: string;
  isDeleted?: boolean;
  hasSpreadsheet?: boolean;
  movedTo?: string;
}

export interface FolderMeta {
  id: string;
  title: string;
  parentId?: string;
  folderClass?: string;
  color?: string;
  secretPath?: string;
  childFolderIds: string[];
  threadIds: string[];
  accessible: boolean;
  error?: string;
}

export interface Warning {
  code: string;
  detail?: string;
}

export interface BlobRef {
  threadId: string;
  blobId: string;
  kind: 'image' | 'file';
  hint?: string;
}

/**
 * The converter is synchronous and pure. Anything that needs I/O is emitted as a
 * sentinel URL which the exporter resolves afterwards:
 *   quip-blob:<threadId>/<blobId>   -> downloaded attachment
 *   quip-doc:<idOrSecretPath>       -> another exported Quip document
 */
export const BLOB_SCHEME = 'quip-blob:';
export const DOC_SCHEME = 'quip-doc:';

export interface ConvertResult {
  markdown: string;
  blobs: BlobRef[];
  docLinks: string[];
  embeds: Record<string, number>;
  warnings: Warning[];
  unknownUserIds: string[];
}

export interface ConvertOptions {
  threadId: string;
  userNames?: ReadonlyMap<string, string>;
  titleHeading?: { title: string } | undefined;
  maxDumpChars?: number;
  /** Standalone spreadsheet threads render each sheet under an `##` heading. */
  spreadsheetThread?: boolean;
}
