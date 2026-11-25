import type { CurrentUser } from './quipTypes';

export type RootKind = 'private' | 'desktop' | 'shared' | 'group' | 'archive' | 'starred' | 'trash';

export interface RootChoice {
  id: string;
  kind: RootKind;
  defaultOn: boolean;
}

/**
 * Top-level folders worth offering. Starred is a virtual view of documents that live elsewhere
 * and Trash holds deleted items, so both are off by default.
 */
export function rootChoices(user: CurrentUser): RootChoice[] {
  const out: RootChoice[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined, kind: RootKind, defaultOn: boolean): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, kind, defaultOn });
  };
  add(user.folders.private, 'private', true);
  add(user.folders.desktop, 'desktop', true);
  for (const id of user.folders.shared) add(id, 'shared', true);
  for (const id of user.folders.group) add(id, 'group', true);
  add(user.folders.archive, 'archive', true);
  add(user.folders.starred, 'starred', false);
  add(user.folders.trash, 'trash', false);
  return out;
}

export interface QuipLink {
  host: string;
  /** First path segment: a thread/folder id or its secret path. */
  id: string;
}

/** Recognises a Quip document or folder URL such as https://site.quip.com/AbCdEfGhIjKl/Title. */
export function parseQuipUrl(raw: string): QuipLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!/(^|\.)quip\.com$/i.test(url.hostname) || url.hostname.toLowerCase() === 'platform.quip.com') return undefined;
  const id = url.pathname.split('/').filter(Boolean)[0];
  if (!id || !/^[A-Za-z0-9]{11,12}$/.test(id) || !/[A-Z]/.test(id)) return undefined;
  return { host: url.hostname, id };
}
