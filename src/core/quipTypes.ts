import type { FolderMeta, ThreadMeta } from './types';

export interface CurrentUser {
  id: string;
  name: string;
  emails: string[];
  /** Home URL of the user's Quip site, e.g. https://acme.quip.com */
  siteUrl?: string;
  folders: {
    desktop?: string;
    archive?: string;
    starred?: string;
    private?: string;
    trash?: string;
    shared: string[];
    group: string[];
  };
}

export type Result<T> = { ok: true; value: T; raw: unknown } | { ok: false; status: number; message: string };

export interface QuipMessage {
  id: string;
  authorId?: string;
  authorName?: string;
  createdUsec: number;
  text: string;
  files: Array<{ hash: string; name: string }>;
  /** True when the message is a comment anchored to highlighted text. */
  anchored: boolean;
  mentionUserIds: string[];
}

export interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string;
}

export interface OwnedThread {
  id: string;
  type: ThreadMeta['type'];
  updatedUsec?: number;
  isDeleted: boolean;
}

/** A document's comments, oldest first. */
export interface MessageList {
  messages: QuipMessage[];
  /**
   * A whole page of messages shared one timestamp. Quip cannot page past such a run, so if the run was longer
   * than a page, the rest are missing. Not expected in practice (timestamps have microsecond resolution).
   */
  incomplete: boolean;
}

/** The read-only surface of Quip the exporter depends on. */
export interface QuipApi {
  currentUser(): Promise<CurrentUser>;
  getFolder(idOrSecret: string): Promise<Result<FolderMeta>>;
  getThread(idOrSecret: string): Promise<Result<ThreadMeta>>;
  getFolders(ids: string[]): Promise<Map<string, Result<FolderMeta>>>;
  getThreads(ids: string[]): Promise<Map<string, Result<ThreadMeta>>>;
  getThreadHtml(id: string): Promise<string>;
  getMessages(id: string): Promise<MessageList>;
  getBlob(threadId: string, blobId: string): Promise<BinaryResponse>;
  getSlidesPdf(threadId: string): Promise<BinaryResponse>;
  getXlsx(threadId: string): Promise<BinaryResponse>;
  getUsers(ids: string[]): Promise<Map<string, string>>;
  listOwnedThreads(): Promise<OwnedThread[]>;
}
