// Import-free so the viewer can assemble the srcdoc without pulling the
// sanitizer (DOMPurify) into the main bundle. Content arrives pre-sanitized.

export const DOCUMENT_PREVIEW_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/** Sanitized document parts; only `sanitizeDocument` produces this type. */
export type SanitizedDocument = { readonly bodyHtml: string; readonly css: string; readonly __sanitized: true };

/** Page chrome: neutral backdrop, and fluid pages on narrow screens. Trusted constant. */
export const previewChromeCss = (dark: boolean): string => `
html, body { margin: 0; background: ${dark ? '#1f1f23' : '#f1f1f3'}; }
.docx-wrapper { background: transparent; padding: 24px 16px 0; }
.docx-wrapper > section.docx { box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); margin-bottom: 24px; }
a:not([href]) { color: inherit; text-decoration: underline; cursor: default; }
@media (max-width: 860px) {
  .docx-wrapper { padding: 8px 0 0; }
  .docx-wrapper > section.docx { width: auto !important; min-height: 0 !important;
    padding: 20px 16px !important; margin-bottom: 8px; }
  .docx-wrapper img, .docx-wrapper svg, .docx-wrapper table { max-width: 100%; height: auto; }
}`;

/**
 * Builds the complete `srcdoc` for the sandboxed preview frame. Cheap: the
 * document is already sanitized, so a theme switch only swaps the chrome CSS.
 */
export function buildPreviewSrcdoc(document: SanitizedDocument, dark: boolean): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_PREVIEW_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${document.css}</style><style>${previewChromeCss(dark)}</style>`,
    `</head><body>${document.bodyHtml}</body></html>`,
  ].join('');
}
