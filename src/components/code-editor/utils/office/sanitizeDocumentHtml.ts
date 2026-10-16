import DOMPurify, { type Config } from 'dompurify';

import { referencesExternalResource, sanitizeStyleAttribute, sanitizeStylesheet } from './cssSanitizer';
import { canonicalDataUrl } from './dataUrl';
import type { SanitizedDocument } from './previewSrcdoc';

// Document HTML comes from an untrusted file. It is (1) sanitized here, then
// (2) shown in an iframe with an empty `sandbox` (no scripts, opaque origin)
// and (3) a CSP that only allows inline styles plus data: images and fonts, so
// nothing can execute or reach the network even if one layer is bypassed.

const FORBIDDEN_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'audio', 'video', 'source', 'track',
  'foreignObject', 'animate', 'animateMotion', 'animateTransform', 'set', 'feImage',
];
const FORBIDDEN_ATTRS = ['srcset', 'action', 'formaction', 'ping', 'background', 'poster', 'target'];
const URL_ATTRIBUTES = ['src', 'href', 'xlink:href'];
const FRAGMENT = /^#[A-Za-z0-9_.:-]*$/;
const IMAGE_ELEMENTS = new Set(['img', 'image']);

const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  FORBID_TAGS: FORBIDDEN_TAGS,
  FORBID_ATTR: FORBIDDEN_ATTRS,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

/** Keeps in-document links, re-tagged data: images; drops every other URL. */
function neutralizeUrlAttributes(node: Element): void {
  for (const name of URL_ATTRIBUTES) {
    const value = node.getAttribute(name);
    if (value === null) continue;
    const trimmed = value.trim();
    if (IMAGE_ELEMENTS.has(node.localName)) {
      const safe = canonicalDataUrl(trimmed, ['image']);
      if (safe) node.setAttribute(name, safe);
      else node.removeAttribute(name);
      continue;
    }
    if (FRAGMENT.test(trimmed)) continue;
    node.removeAttribute(name);
    // Show where an external link pointed without making it navigable.
    if (node.localName === 'a' && /^(https?:|mailto:)/i.test(trimmed)) node.setAttribute('title', trimmed);
  }
}

/**
 * Style attributes are re-tokenized; any other attribute that reads as a CSS
 * resource reference (SVG fill/stroke/filter/mask/clip-path/marker-*, cursor)
 * is removed as defence in depth.
 */
function neutralizeCssAttributes(node: Element): void {
  for (const attribute of Array.from(node.attributes)) {
    if (URL_ATTRIBUTES.includes(attribute.name)) continue;
    if (attribute.name === 'style') {
      const clean = sanitizeStyleAttribute(attribute.value);
      if (clean === null) node.removeAttribute('style');
      else node.setAttribute('style', clean);
    } else if (referencesExternalResource(attribute.value)) {
      node.removeAttribute(attribute.name);
    }
  }
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** A private DOMPurify instance so the URL hook never leaks to other callers. */
function getPurifier(): ReturnType<typeof DOMPurify> {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeType !== 1) return;
      neutralizeUrlAttributes(node as Element);
      neutralizeCssAttributes(node as Element);
    });
  }
  return purifier;
}

/** Sanitizes untrusted document body HTML for the sandboxed preview frame. */
export function sanitizeDocumentHtml(html: string): string {
  return getPurifier().sanitize(html, { ...PURIFY_CONFIG, RETURN_TRUSTED_TYPE: false }) as string;
}

/** Sanitizes document body HTML and stylesheet text once, at parse time. */
export function sanitizeDocument({ bodyHtml, css }: { bodyHtml: string; css: string }): SanitizedDocument {
  return { bodyHtml: sanitizeDocumentHtml(bodyHtml), css: sanitizeStylesheet(css), __sanitized: true };
}
