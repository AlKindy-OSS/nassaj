// Server-side SVG sanitization for the branding logo upload path.
//
// SVG is an XML document that can carry inline scripts, event handlers and
// external references — a stored-XSS vector when served same-origin. We allow
// SVG logos again (raster-only was too restrictive for vector brand marks) but
// ONLY after stripping every active-content vector here. The sanitized markup
// is what gets written to disk; the original bytes are never persisted.
//
// We use DOMPurify (a real, audited sanitizer) wired to a jsdom window rather
// than fragile hand-rolled regexes. DOMPurify normalizes the markup via a real
// DOM parser, so obfuscations like split attributes, entity-encoded payloads or
// malformed nesting are handled by the parser, not by us.

import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

// One jsdom window + DOMPurify instance for the process. JSDOM construction is
// relatively expensive, so we create it lazily and reuse it across uploads.
let purifier = null;

function getPurifier() {
  if (purifier) {
    return purifier;
  }
  const { window } = new JSDOM('');
  purifier = DOMPurify(window);
  return purifier;
}

// Quick structural gate: after skipping a UTF-8 BOM, leading whitespace, an
// optional XML declaration (<?xml ...?>) and any leading XML comments, the first
// real markup must be the <svg> root element. This rejects HTML/script payloads
// that merely *contain* the substring "<svg" somewhere, requiring SVG to be the
// actual document root before we even hand it to the sanitizer.
export function looksLikeSvgRoot(text) {
  if (typeof text !== 'string') {
    return false;
  }
  let s = text;
  // Strip a leading UTF-8 BOM if present.
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
  }
  s = s.replace(/^\s+/, '');
  // Optional XML prolog: <?xml ... ?>
  if (s.startsWith('<?xml')) {
    const end = s.indexOf('?>');
    if (end === -1) {
      return false;
    }
    s = s.slice(end + 2).replace(/^\s+/, '');
  }
  // Skip any number of leading XML comments / whitespace before the root.
  while (s.startsWith('<!--')) {
    const end = s.indexOf('-->');
    if (end === -1) {
      return false;
    }
    s = s.slice(end + 3).replace(/^\s+/, '');
  }
  // Optional <!DOCTYPE svg ...> declaration.
  if (/^<!doctype\s+svg/i.test(s)) {
    const end = s.indexOf('>');
    if (end === -1) {
      return false;
    }
    s = s.slice(end + 1).replace(/^\s+/, '');
  }
  // The root element must be <svg> (start tag), case-insensitive, followed by
  // whitespace, '>' or '/' (self-closing) — not e.g. "<svgx".
  return /^<svg(\s|>|\/)/i.test(s);
}

// SVG presentation properties that carry COLOR and are safe to express as plain
// presentation attributes. We migrate these (and only these) out of stripped CSS
// so a logo's color survives sanitization. Geometry/structure properties are not
// touched: defaults render the shape correctly, only the color was being lost.
const COLOR_PRESENTATION_PROPS = new Set([
  'fill',
  'stroke',
  'color',
  'stop-color',
  'flood-color',
  'lighting-color',
  'fill-opacity',
  'stroke-opacity',
  'stroke-width',
  'opacity',
]);

// Accept only inert color/number values. A safe value is a hex color, an
// rgb()/rgba()/hsl()/hsla() function, a bare number/percentage (opacity, width)
// or a plain CSS keyword (named colors like "white", plus none/currentColor/
// transparent/inherit). Anything carrying a URL, another function call, a
// semicolon, or non-color punctuation is rejected — this is what keeps the
// CSS-injection vector (url(javascript:), expression(), image()) closed even
// though the value ends up in a presentation attribute.
function isSafePresentationValue(value) {
  const v = value.trim();
  if (v.length === 0 || v.length > 64) {
    return false;
  }
  // #rgb / #rgba / #rrggbb / #rrggbbaa
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
    return true;
  }
  // rgb()/rgba()/hsl()/hsla() with only numbers, %, commas, slashes, spaces, dots.
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%/\s]+\)$/i.test(v)) {
    return true;
  }
  // Bare number or percentage (opacity, stroke-width).
  if (/^[0-9]+(?:\.[0-9]+)?%?$/.test(v)) {
    return true;
  }
  // A single CSS identifier keyword (named colors, none, currentColor, etc.).
  // No parentheses, colons, slashes or url tokens can reach here.
  if (/^[a-zA-Z][a-zA-Z-]*$/.test(v)) {
    return true;
  }
  return false;
}

// Parse a CSS declaration list ("fill:#fff;stroke:none") into [prop, value]
// pairs, keeping only safe color presentation properties. Returns a Map.
function parseSafeColorDecls(cssText) {
  const out = new Map();
  for (const decl of String(cssText).split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) {
      continue;
    }
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (COLOR_PRESENTATION_PROPS.has(prop) && isSafePresentationValue(value)) {
      out.set(prop, value);
    }
  }
  return out;
}

// Before DOMPurify strips <style> and the style attribute (the CSS-injection
// carriers), migrate the COLOR declarations they hold onto safe presentation
// attributes so a logo keeps its color. Without this, an SVG that paints itself
// white via CSS (common for dark-theme logo variants exported from Illustrator/
// Inkscape) loses all fill information and falls back to the SVG default of solid
// black — invisible on a dark background. We never copy a value that isn't a
// validated inert color/number, so no URL/function payload can ride along.
//
// An explicit presentation attribute already on the element wins over the CSS we
// derive (matches CSS cascade: presentation attributes are the lowest priority,
// but we only fill in what is MISSING, so we never override author intent).
function inlineSafeColors(rawText) {
  let dom;
  try {
    dom = new JSDOM(rawText, { contentType: 'image/svg+xml' });
  } catch {
    // Malformed XML: let DOMPurify handle/reject it; skip color migration.
    return rawText;
  }
  const doc = dom.window.document;
  const svg = doc.querySelector('svg');
  if (!svg) {
    return rawText;
  }

  // 1) Class/element rules from <style> blocks. We support the simple, common
  //    selectors logo exporters emit: ".class" and bare element names ("path").
  //    Anything more exotic is ignored (the color just won't migrate) — never a
  //    security risk, at worst the original (broken) rendering.
  const classRules = new Map(); // className -> Map(prop,value)
  const tagRules = new Map();   // tagName(lower) -> Map(prop,value)
  for (const styleEl of doc.querySelectorAll('style')) {
    const css = styleEl.textContent || '';
    // Match "selector { decls }" blocks. Selector list split on commas.
    const blockRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = blockRe.exec(css)) !== null) {
      const decls = parseSafeColorDecls(m[2]);
      if (decls.size === 0) {
        continue;
      }
      for (const rawSel of m[1].split(',')) {
        const sel = rawSel.trim();
        if (/^\.[A-Za-z_][\w-]*$/.test(sel)) {
          const name = sel.slice(1);
          const target = classRules.get(name) ?? new Map();
          for (const [p, v] of decls) target.set(p, v);
          classRules.set(name, target);
        } else if (/^[A-Za-z][\w-]*$/.test(sel)) {
          const name = sel.toLowerCase();
          const target = tagRules.get(name) ?? new Map();
          for (const [p, v] of decls) target.set(p, v);
          tagRules.set(name, target);
        }
      }
    }
  }

  // 2) Walk every element: apply (a) matching tag rules, (b) matching class
  //    rules, then (c) the element's own inline style — later sources win, which
  //    mirrors CSS specificity for these simple cases. Only set an attribute that
  //    is not already present so explicit author attributes are preserved.
  const all = svg.tagName.toLowerCase() === 'svg' ? [svg, ...svg.querySelectorAll('*')] : svg.querySelectorAll('*');
  for (const el of all) {
    const resolved = new Map();

    const tagRule = tagRules.get(el.tagName.toLowerCase());
    if (tagRule) {
      for (const [p, v] of tagRule) resolved.set(p, v);
    }
    const classAttr = el.getAttribute('class');
    if (classAttr) {
      for (const cls of classAttr.split(/\s+/)) {
        const rule = classRules.get(cls);
        if (rule) {
          for (const [p, v] of rule) resolved.set(p, v);
        }
      }
    }
    const inlineStyle = el.getAttribute('style');
    if (inlineStyle) {
      for (const [p, v] of parseSafeColorDecls(inlineStyle)) resolved.set(p, v);
    }

    for (const [prop, value] of resolved) {
      if (!el.hasAttribute(prop)) {
        el.setAttribute(prop, value);
      }
    }
  }

  return svg.outerHTML;
}

// Sanitize raw SVG markup and return the cleaned string, or null if the input
// is not a valid SVG-rooted document. The output is guaranteed (by DOMPurify
// with the SVG profile) to contain no <script>, <foreignObject>, event-handler
// attributes, javascript: URLs, external <use> references or CSS expression()/
// url(javascript:) payloads.
export function sanitizeSvg(rawText) {
  if (!looksLikeSvgRoot(rawText)) {
    return null;
  }

  // Migrate safe color declarations out of <style>/style (which DOMPurify strips
  // below) onto presentation attributes, so logos that color themselves via CSS
  // keep their color instead of falling back to solid black. Security is
  // unchanged: only validated inert color values survive, and <style>/style are
  // still removed by the sanitizer pass that follows.
  const colorized = inlineSafeColors(rawText);

  const clean = getPurifier().sanitize(colorized, {
    // Restrict the allowed grammar to the SVG (+ filter) profile. This drops
    // HTML/MathML elements and, combined with the forbid lists below, removes
    // every active-content vector.
    USE_PROFILES: { svg: true, svgFilters: true },
    // Belt-and-braces explicit denials on top of the profile. We additionally
    // drop <style> elements and the `style` attribute outright: they are the
    // only carriers of CSS expression()/url(javascript:) payloads and are not
    // needed for logo rendering (presentation attributes like fill/stroke cover
    // it), so removing them eliminates the CSS-based vector entirely rather than
    // relying on per-property CSS filtering.
    FORBID_TAGS: ['script', 'foreignObject', 'use', 'iframe', 'embed', 'object', 'style'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onbegin', 'onend', 'onrepeat', 'style'],
    // Return a string, not a DOM node.
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    // Disallow data: URIs / unknown protocols in attributes; only same-document
    // refs and safe protocols survive. javascript: is stripped by default.
    ALLOW_DATA_ATTR: false,
  });

  const result = typeof clean === 'string' ? clean.trim() : '';
  // After sanitization the root must still be an <svg> element; if DOMPurify
  // stripped everything (input was not real SVG content) we reject.
  if (!result || !/^<svg[\s>]/i.test(result)) {
    return null;
  }
  return result;
}
