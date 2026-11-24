/**
 * B-1805 — how the lightbox offers the original image without ever turning a
 * picture into a navigable document.
 *
 * - http(s), non-SVG: open in a new tab (`noopener noreferrer`).
 * - blob: / data:, or a same-origin SVG: a download link, never navigation.
 * - cross-origin SVG: no control (the browser ignores `download` cross-origin
 *   and would open the SVG as a document).
 * - any other scheme: no control.
 */

export type OriginalLink = { kind: 'open' | 'download'; href: string };

const SVG_PATH = /\.svg$/i;

/** Decide the original-image control for `src`, resolved against `base` (the page URL). */
export function originalLinkFor(src: string, base: string): OriginalLink | null {
  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    return null;
  }
  if (url.protocol === 'blob:' || url.protocol === 'data:') {
    return { kind: 'download', href: src };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (SVG_PATH.test(url.pathname)) {
    return url.origin === new URL(base).origin ? { kind: 'download', href: url.href } : null;
  }
  return { kind: 'open', href: url.href };
}
