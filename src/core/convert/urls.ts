export type UrlKind =
  | { kind: 'blob'; threadId: string; blobId: string }
  | { kind: 'doc'; id: string }
  | { kind: 'external'; url: string }
  | { kind: 'none' };

const QUIP_HOST = /(^|\.)quip\.com$|(^|\.)onquip\.com$|(^|\.)quip-cdn\.com$|^quip-[a-z0-9-]+\.com$/i;

function looksLikeThreadId(seg: string): boolean {
  return /^[A-Za-z0-9]{11,12}$/.test(seg) && /[A-Z]/.test(seg) && /[a-z0-9]/.test(seg);
}

/** Classifies a link/image target found in Quip HTML. */
export function classifyUrl(raw: string | null | undefined): UrlKind {
  const href = (raw ?? '').trim();
  if (!href || href.startsWith('#')) return { kind: 'none' };
  if (/^(javascript|data|blob):/i.test(href)) return { kind: 'none' };
  if (/^(mailto|tel):/i.test(href)) return { kind: 'external', url: href };

  let host = '';
  let path: string;
  if (href.startsWith('/') && !href.startsWith('//')) {
    path = href.split(/[?#]/)[0] ?? '';
  } else {
    try {
      const u = new URL(href);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return { kind: 'external', url: href };
    }
  }

  const isQuip = host === '' || QUIP_HOST.test(host);
  if (isQuip) {
    const blob = /^\/(?:1\/)?blob\/([\w-]+)\/([\w-]+)/.exec(path);
    if (blob?.[1] && blob[2]) return { kind: 'blob', threadId: blob[1], blobId: blob[2] };
    const doc = /^\/([A-Za-z0-9]{11,12})(?:\/|$)/.exec(path);
    if (doc?.[1] && looksLikeThreadId(doc[1])) return { kind: 'doc', id: doc[1] };
  }
  return { kind: 'external', url: href };
}
