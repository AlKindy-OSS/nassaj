import { parseAsync, renderDocument, type HElement, type Options } from 'docx-preview';
import JSZip from 'jszip';

import { createCheckpoint, throwIfAborted } from './cancellation';
import type { SanitizedDocument } from './previewSrcdoc';
import { sanitizeDocument } from './sanitizeDocumentHtml';
import { OfficePackage, childrenByName, descendantsByName } from './zipXml';

/** Binary parts (images, fonts, …) beyond this total are left out of the preview. */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

const DOCX_OPTIONS: Partial<Options> & { keepOrigin: boolean } = {
  className: 'docx',
  inWrapper: true,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  // Images and fonts become data: URLs, the only kind the preview CSP allows.
  useBase64URL: true,
  // altChunks embed raw HTML in an iframe; comments/changes need live scripts.
  renderAltChunks: false,
  renderComments: false,
  renderChanges: false,
  experimental: false,
  // Keep the parsed document.xml so RTL tables need no second parse.
  keepOrigin: true,
};

// Macros, OLE objects and printer settings are never needed to render.
const SKIPPED_PART = /(^|\/)embeddings\/|\.bin$/i;
/**
 * True when part bytes look like XML: `<` first, after an optional UTF-8 or
 * UTF-16 byte-order mark and whitespace. Classified by content, not name,
 * because docx-preview loads images and fonts from any relationship target.
 */
export function looksLikeXml(bytes: Uint8Array): boolean {
  let index = 0;
  let stride = 1;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  else if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    index = bytes[0] === 0xff ? 2 : 3;
    stride = 2;
  }
  while (index < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[index])) index += stride;
  return bytes[index] === 0x3c;
}

/**
 * Re-packs the document as a fresh STORE (uncompressed) zip built only from
 * bytes inflated under our caps, so docx-preview never touches the original
 * archive and cannot be made to inflate more than we already accepted.
 */
async function repackWithinLimits(pkg: OfficePackage, signal?: AbortSignal): Promise<Uint8Array> {
  const checkpoint = createCheckpoint(signal);
  const repacked = new JSZip();
  let binaryBytes = 0;
  for (const path of pkg.paths()) {
    if (SKIPPED_PART.test(path)) continue;
    const bytes = await pkg.readBytes(path);
    if (!bytes) continue;
    if (!looksLikeXml(bytes)) {
      binaryBytes += bytes.length;
      if (binaryBytes > MAX_IMAGE_BYTES) continue;
    }
    repacked.file(path, bytes, { binary: true, createFolders: false });
    await checkpoint();
  }
  const zipped = await repacked.generateAsync({ type: 'uint8array', compression: 'STORE' });
  throwIfAborted(signal);
  return zipped;
}

/**
 * Element factory bound to an inert document (no browsing context): nodes it
 * creates never load resources or run handlers while the tree is assembled.
 */
export function createInertFactory(inert: Document): (elem: HElement | Node | string) => Node {
  const h = (elem: HElement | Node | string): Node => {
    if (typeof elem === 'string') return inert.createTextNode(elem);
    if (elem instanceof Node) return elem;
    const { ns, tagName, className, style, children, ...props } = elem;
    if (tagName === '#fragment') {
      const fragment = inert.createDocumentFragment();
      children?.forEach((child) => fragment.appendChild(h(child)));
      return fragment;
    }
    if (tagName === '#comment') return inert.createComment(String(children?.[0] ?? ''));
    const node = ns ? inert.createElementNS(ns, tagName) : inert.createElement(tagName);
    if (className) node.setAttribute('class', className);
    if (typeof style === 'string') node.setAttribute('style', style);
    else if (style) Object.assign((node as HTMLElement).style, style);
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined) (node as unknown as Record<string, unknown>)[key] = value;
    }
    children?.forEach((child) => node.appendChild(h(child)));
    return node;
  };
  return h;
}

/**
 * docx-preview ignores `w:bidiVisual`, so right-to-left tables would render
 * mirrored. Apply it from document.xml when the table order lines up.
 */
function applyRtlTables(documentXml: Document | undefined, body: Element): void {
  if (!documentXml) return;
  const flags = descendantsByName(documentXml, 'tbl').map((table) =>
    childrenByName(childrenByName(table, 'tblPr')[0] ?? table, 'bidiVisual').length > 0);
  const tables = Array.from(body.querySelectorAll('article table'));
  if (tables.length !== flags.length) return;
  tables.forEach((table, index) => {
    if (flags[index]) table.setAttribute('dir', 'rtl');
  });
}

// Word stores Symbol/Wingdings bullets as private-use code points (U+F0xx)
// that only render with those legacy fonts, so they would show blank.
const SYMBOL_BULLETS: Record<string, string> = {
  '\uF0B7': '\u2022', // Symbol bullet
  '\uF0A7': '\u25AA', // Wingdings small square
  '\uF0D8': '\u27A2', // Wingdings arrowhead
  '\uF076': '\u2756', // Wingdings diamond
  '\uF0FC': '\u2714', // Wingdings check mark
  '\uF06E': '\u25A0', // Wingdings black square
  '\uF06C': '\u25CF', // Wingdings black circle
  '\uF0E0': '\u2794', // Wingdings right arrow
  '\uF0A8': '\u25FB', // Symbol/Wingdings white square
  '\uF0D2': '\u00AE', // Symbol registered sign
};
const PRIVATE_USE_SYMBOL = /[\uF000-\uF0FF]/g;

/** Replaces private-use Symbol/Wingdings bullets with visible Unicode (others: bullet). */
export const mapSymbolBullets = (css: string): string =>
  css.replace(PRIVATE_USE_SYMBOL, (char) => SYMBOL_BULLETS[char] ?? '\u2022');

/** Renders a Word package into sanitized body HTML and CSS for the preview frame. */
export async function renderDocx(pkg: OfficePackage, signal?: AbortSignal): Promise<SanitizedDocument> {
  const repacked = await repackWithinLimits(pkg, signal);
  const parsed = await parseAsync(repacked, DOCX_OPTIONS);
  throwIfAborted(signal);
  const inert = document.implementation.createHTMLDocument('');
  const nodes = await renderDocument(parsed, { ...DOCX_OPTIONS, h: createInertFactory(inert) });
  throwIfAborted(signal);
  const body = inert.createElement('div');
  let css = '';
  for (const node of nodes) {
    if (node.nodeName === 'STYLE') css += `${node.textContent ?? ''}\n`;
    else body.appendChild(node);
  }
  const documentXml = (parsed as { documentPart?: { _xmlDocument?: Document } }).documentPart?._xmlDocument;
  applyRtlTables(documentXml, body);
  return sanitizeDocument({ bodyHtml: body.innerHTML, css: mapSymbolBullets(css) });
}
