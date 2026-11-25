import type { FolderMeta, ThreadMeta, ThreadType } from './types';
import type { CurrentUser, QuipMessage } from './quipTypes';

type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return undefined;
};
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** Handles V1 ("document"), V2 ("DOCUMENT") and the user-threads enum ("TEXT_DOCUMENT", "SPREADSHEET_DOCUMENT"). */
export function normalizeThreadType(v: unknown): ThreadType {
  const t = typeof v === 'string' ? v.toLowerCase() : '';
  if (t.includes('slide')) return 'slides';
  if (t.includes('spreadsheet')) return 'spreadsheet';
  if (t.includes('chat') || t.includes('channel')) return 'chat';
  if (t.includes('doc')) return 'document';
  return 'unknown';
}

/** Accepts both the single-thread shape `{ thread: {...} }` and the flat bulk shape. */
export function normalizeThread(id: string, raw: unknown): ThreadMeta {
  const root = isObj(raw) ? raw : {};
  const t = isObj(root.thread) ? root.thread : root;
  const summary = isObj(t.spreadsheet_summary) ? t.spreadsheet_summary : undefined;
  const moved = isObj(t.mark_as_moved_to_external) ? t.mark_as_moved_to_external : undefined;
  const meta: ThreadMeta = {
    id: str(t.id) ?? id,
    title: typeof t.title === 'string' ? t.title : '',
    type: normalizeThreadType(t.type),
  };
  const secretPath = str(t.secret_path);
  if (secretPath) meta.secretPath = secretPath;
  const link = str(t.link);
  if (link) meta.link = link;
  const created = num(t.created_usec);
  if (created !== undefined) meta.createdUsec = created;
  const updated = num(t.updated_usec);
  if (updated !== undefined) meta.updatedUsec = updated;
  const author = str(t.author_id);
  if (author) meta.authorId = author;
  if (t.is_deleted === true) meta.isDeleted = true;
  if (summary && (num(summary.num_tables) ?? 0) > 0) meta.hasSpreadsheet = true;
  const movedUrl = moved ? str(moved.url) : undefined;
  if (movedUrl) meta.movedTo = movedUrl;
  return meta;
}

export function normalizeFolder(id: string, raw: unknown): FolderMeta {
  const root = isObj(raw) ? raw : {};
  const f = isObj(root.folder) ? root.folder : {};
  const childFolderIds: string[] = [];
  const threadIds: string[] = [];
  for (const child of Array.isArray(root.children) ? root.children : []) {
    if (!isObj(child)) continue;
    const folderId = str(child.folder_id);
    const threadId = str(child.thread_id);
    if (folderId) childFolderIds.push(folderId);
    else if (threadId) threadIds.push(threadId);
  }
  const meta: FolderMeta = {
    id: str(f.id) ?? id,
    title: typeof f.title === 'string' ? f.title : '',
    childFolderIds,
    threadIds,
    accessible: true,
  };
  const parent = str(f.parent_id);
  if (parent) meta.parentId = parent;
  const cls = str(f.folder_class);
  if (cls) meta.folderClass = cls;
  const color = str(f.color);
  if (color) meta.color = color;
  const secret = str(f.secret_path);
  if (secret) meta.secretPath = secret;
  return meta;
}

export function normalizeCurrentUser(raw: unknown): CurrentUser {
  const u = isObj(raw) ? raw : {};
  const folders: CurrentUser['folders'] = { shared: strArray(u.shared_folder_ids), group: strArray(u.group_folder_ids) };
  const desktop = str(u.desktop_folder_id);
  if (desktop) folders.desktop = desktop;
  const archive = str(u.archive_folder_id);
  if (archive) folders.archive = archive;
  const starred = str(u.starred_folder_id);
  if (starred) folders.starred = starred;
  const priv = str(u.private_folder_id);
  if (priv) folders.private = priv;
  const trash = str(u.trash_folder_id);
  if (trash) folders.trash = trash;
  const user: CurrentUser = {
    id: str(u.id) ?? '',
    name: str(u.name) ?? '',
    emails: strArray(u.emails),
    folders,
  };
  const url = str(u.url);
  if (url) user.siteUrl = url.replace(/\/+$/, '');
  return user;
}

export function normalizeMessage(raw: unknown): QuipMessage | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id);
  const created = num(raw.created_usec);
  if (!id || created === undefined) return undefined;
  const files: QuipMessage['files'] = [];
  for (const f of Array.isArray(raw.files) ? raw.files : []) {
    if (isObj(f) && str(f.hash)) files.push({ hash: String(f.hash), name: typeof f.name === 'string' ? f.name : '' });
  }
  const msg: QuipMessage = {
    id,
    createdUsec: created,
    text: typeof raw.text === 'string' ? raw.text : '',
    files,
    anchored: isObj(raw.annotation),
    mentionUserIds: strArray(raw.mention_user_ids),
  };
  const authorId = str(raw.author_id);
  if (authorId) msg.authorId = authorId;
  const authorName = str(raw.author_name);
  if (authorName) msg.authorName = authorName;
  return msg;
}
