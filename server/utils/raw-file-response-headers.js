/**
 * Response headers for the raw project-file endpoint
 * (GET /api/projects/:projectId/files/content).
 *
 * Direct navigation to the raw bytes must never execute stored script in the
 * app origin (B-158 / T-844). The wallet device cookie (ADR-163 amendment 1,
 * inventory M9) is sent with a top-level navigation, so a link to this route
 * now arrives authenticated; the defence therefore cannot rely on the old
 * "Bearer cannot ride a navigation" property.
 *
 * - `nosniff` on every response, so bytes are never re-sniffed into an active type.
 * - A sandboxing CSP on every response, so any document type the browser
 *   chooses to render (HTML, SVG, any XML dialect) runs with no script and an
 *   opaque origin. The in-app previews fetch the bytes and render a blob URL,
 *   which this header does not reach.
 * - A download disposition for the types a browser renders as an active
 *   document: the known HTML/SVG/XML types and every `+xml` suffix type.
 */

const ACTIVE_DOCUMENT_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
  'text/xsl',
  'text/mathml',
]);

export const RAW_FILE_CSP = "default-src 'none'; sandbox";

/**
 * Whether a content type renders as an active document on direct navigation.
 * @param {unknown} mimeType the Content-Type chosen for the response
 * @returns {boolean}
 */
export function isActiveDocumentType(mimeType) {
  const type = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  return ACTIVE_DOCUMENT_TYPES.has(type) || type.endsWith('+xml');
}

/**
 * Sets the content type and the navigation-safety headers on a raw-bytes response.
 * @param {{ setHeader: (name: string, value: string) => unknown }} res
 * @param {string} mimeType
 */
export function applyRawFileResponseHeaders(res, mimeType) {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', RAW_FILE_CSP);
  if (isActiveDocumentType(mimeType)) res.setHeader('Content-Disposition', 'attachment');
}
