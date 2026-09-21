/** Interpret a model's local reference as a candidate only; the server authorizes it. */
export function shareableReference(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > 3072 || /[?#\\\x00-\x1f\x7f]/.test(href)) return null;
  let value: string;
  try { value = decodeURIComponent(href); } catch { return null; }
  const parts = value.split('/');
  if (value.length > 1024 || !['doc', 'docs'].includes(parts[0]) || parts.length < 2
    || parts.some(part => !part || part.startsWith('.') || /[\\:%?#\x00-\x1f\x7f]/.test(part))) return null;
  return /\.(?:pdf|docx|xlsx|txt|md|csv|html?|xhtml)$/i.test(value) ? value : null;
}

/** Only the dedicated sibling asset directory can participate in a page preview. */
export function pageAssetScope(relativePath: string): string | null {
  return /\.(?:html?|xhtml)$/i.test(relativePath) ? relativePath.replace(/\.[^.]+$/, '.assets') : null;
}

/** Accept a canonical share response, never invent a URL from an arbitrary model path. */
export function validCreatedShareUrl(value: unknown, origin: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.search) return false;
    if (/^\/share\/members\/[a-f0-9]{32}$/.test(url.pathname)) return !url.hash;
    return /^\/share\/[a-f0-9]{32}$/.test(url.pathname) && /^#token=[A-Za-z0-9_-]{43}$/.test(url.hash);
  } catch { return false; }
}
