/** Return the safe external URL for an href, or null when it must not be a link. */
export function safeExternalHref(href: unknown, selfHost: string): string | null {
  if (typeof href !== 'string') return null;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (selfHost && url.hostname.toLowerCase() === selfHost.toLowerCase()) return null;
  return url.href;
}
