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
//
// Colour survival (B-42): <style> blocks and the style attribute are the CSS
// injection carriers (expression(), url(javascript:), @import, behavior) and are
// always removed. Because logo exporters (Illustrator, Inkscape, Figma) paint
// almost exclusively through CSS, removing them used to leave the logo with no
// fill at all — SVG then falls back to solid black, which is invisible on a dark
// background. So before the CSS is dropped we migrate the COLOUR declarations it
// holds onto presentation attributes, through a strict allowlist of properties
// AND of value shapes. Anything we cannot read with certainty is dropped
// (fail-closed): the worst case is a logo that keeps its previous colour, never
// a value we did not fully understand reaching the output.

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
  // Optional <!DOCTYPE svg ...> declaration. Note this deliberately does NOT
  // accept an internal subset ("<!DOCTYPE svg [ <!ENTITY ...> ]>"): the scan
  // stops at the first '>', so an entity-declaring doctype leaves "]>" in front
  // of the root and the document is rejected. That keeps entity-expansion
  // (billion laughs / XXE-shaped) payloads out before any parser sees them.
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

// SVG presentation properties that carry COLOR (or the opacity/width that makes
// a colour visible) and are safe to express as plain presentation attributes.
// We migrate these (and only these) out of stripped CSS so a logo's colour
// survives sanitization. Geometry/structure properties are not touched:
// defaults render the shape correctly, only the colour was being lost.
const COLOR_PRESENTATION_PROPS = new Set([
  'fill',
  'stroke',
  'color',
  'stop-color',
  'flood-color',
  'lighting-color',
  'fill-opacity',
  'stroke-opacity',
  'stop-opacity',
  'flood-opacity',
  'stroke-width',
  'opacity',
]);

// The complete CSS named-colour list (CSS Color Level 4) plus the four inert
// keywords a logo legitimately uses. This is an allowlist by design: accepting
// "any CSS identifier" would be fail-OPEN — an unknown identifier is a value we
// did not understand, and we do not copy values we did not understand.
const NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood',
  'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray',
  'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen',
  'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen',
  'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod',
  'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red',
  'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
  // Inert non-colour keywords that are valid on these properties.
  'none', 'transparent', 'currentcolor', 'inherit',
]);

// A same-document paint reference: url(#gradientId). Gradient-filled logos are
// exactly the colourful ones this whole migration exists for, so we accept this
// one function — but only in its fragment form. The pattern admits nothing but
// '#' followed by an XML-name-ish id: no quotes, no scheme, no slash, no dot-dot,
// no second argument. url(javascript:…), url(//evil), url('data:…') and
// url(#a) fallbacks all fail it. The referenced element is itself part of the
// same document and has already been through the sanitizer.
const LOCAL_URL_REF = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/;

// Accept only inert colour/number values, by shape. Everything that is not one
// of these five shapes is rejected — including anything carrying a scheme, a
// second function call, a semicolon, an escape or a string.
function isSafePresentationValue(rawValue) {
  // "!important" is an author priority marker, not part of the value; strip it
  // so `fill:#fff !important` (Inkscape/Figma emit it) still migrates.
  const v = String(rawValue).replace(/\s*!\s*important\s*$/i, '').trim();
  if (v.length === 0 || v.length > 64) {
    return false;
  }
  // A backslash means a CSS escape sequence — a value whose real text differs
  // from what we read. We never migrate one.
  if (v.includes('\\')) {
    return false;
  }
  // #rgb / #rgba / #rrggbb / #rrggbbaa — exact lengths only.
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) {
    return true;
  }
  // rgb()/rgba()/hsl()/hsla() with only numbers, %, commas, slashes, spaces,
  // dots and signs. Bounded by the 64-char cap above, so the alternation
  // cannot be driven into pathological backtracking.
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[-+0-9.,%/\s]{1,56}\)$/i.test(v)) {
    return true;
  }
  // Bare number or percentage (opacity, stroke-width), with optional CSS unit.
  if (/^[0-9]*\.?[0-9]+(?:%|px|pt|pc|mm|cm|in|em|rem|ex|ch)?$/.test(v)) {
    return true;
  }
  // A same-document paint reference.
  if (LOCAL_URL_REF.test(v)) {
    return true;
  }
  // A known CSS colour name or inert keyword — allowlist, never "any word".
  if (NAMED_COLORS.has(v.toLowerCase())) {
    return true;
  }
  return false;
}

// Parse a CSS declaration list ("fill:#fff;stroke:none") into [prop, value]
// pairs, keeping only safe colour presentation properties. Returns a Map.
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
      out.set(prop, value.replace(/\s*!\s*important\s*$/i, '').trim());
    }
  }
  return out;
}

// Hard cap on the CSS we will parse out of one document. The upload itself is
// size-capped upstream; this keeps the rule scan bounded regardless.
const MAX_CSS_CHARS = 200_000;

// Split a stylesheet into top-level [selectorList, declarations] pairs, with
// brace depth tracked so nested blocks cannot be mistaken for top-level rules.
// At-rules (@media, @supports, @import, @font-face …) are skipped WHOLESALE,
// including their nested blocks: a @media(prefers-color-scheme:dark) rule must
// not be applied unconditionally — that would repaint a light logo with the
// dark variant's colours.
function extractStyleRules(cssText) {
  const css = String(cssText).slice(0, MAX_CSS_CHARS).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = [];
  let i = 0;
  let selStart = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '}') {
      i += 1;
      selStart = i;
      continue;
    }
    if (ch !== '{') {
      i += 1;
      continue;
    }
    const selector = css.slice(selStart, i).trim();
    let depth = 1;
    let j = i + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') {
        depth += 1;
      } else if (css[j] === '}') {
        depth -= 1;
      }
      j += 1;
    }
    const body = css.slice(i + 1, depth === 0 ? j - 1 : css.length);
    if (selector.length > 0 && !selector.startsWith('@')) {
      rules.push([selector, body]);
    }
    i = j;
    selStart = i;
  }
  return rules;
}

function mergeInto(map, key, decls) {
  const target = map.get(key) ?? new Map();
  for (const [p, v] of decls) {
    target.set(p, v);
  }
  map.set(key, target);
}

// Migrate the COLOUR declarations held by <style> blocks and style attributes
// onto presentation attributes, then delete both carriers. Operates on the DOM
// DOMPurify already produced, so the markup we read is exactly the markup the
// sanitizer parsed — no second parser, hence no parser-differential gap.
//
// Cascade order is honoured deliberately: element rules < class rules < id
// rules < inline style, and ALL of them override an existing presentation
// attribute. That last point is the actual B-42 bug: presentation attributes are
// the *lowest* priority source in CSS, so an exporter that writes
// `<path fill="#000" class="cls-1"/>` with `.cls-1{fill:#fff}` renders white in
// a browser. Filling in only the missing attributes kept the black.
function inlineSafeColors(root) {
  const tagRules = new Map();
  const classRules = new Map();
  const idRules = new Map();

  for (const styleEl of root.querySelectorAll('style')) {
    for (const [selectorList, body] of extractStyleRules(styleEl.textContent || '')) {
      const decls = parseSafeColorDecls(body);
      if (decls.size === 0) {
        continue;
      }
      for (const rawSel of selectorList.split(',')) {
        const sel = rawSel.trim();
        if (/^\.[A-Za-z_-][\w-]*$/.test(sel)) {
          mergeInto(classRules, sel.slice(1), decls);
        } else if (/^#[A-Za-z_-][\w-]*$/.test(sel)) {
          mergeInto(idRules, sel.slice(1), decls);
        } else if (/^[A-Za-z][\w-]*$/.test(sel)) {
          mergeInto(tagRules, sel.toLowerCase(), decls);
        }
        // Anything more exotic (descendant, attribute, pseudo, universal) is
        // ignored: at worst the colour does not migrate, never a wrong or
        // unvalidated value.
      }
    }
  }

  for (const el of root.querySelectorAll('*')) {
    const resolved = new Map();

    const tagRule = tagRules.get(el.tagName.toLowerCase());
    if (tagRule) {
      for (const [p, v] of tagRule) resolved.set(p, v);
    }
    const classAttr = el.getAttribute('class');
    if (classAttr) {
      for (const cls of classAttr.trim().split(/\s+/)) {
        const rule = classRules.get(cls);
        if (rule) {
          for (const [p, v] of rule) resolved.set(p, v);
        }
      }
    }
    const idAttr = el.getAttribute('id');
    if (idAttr) {
      const rule = idRules.get(idAttr);
      if (rule) {
        for (const [p, v] of rule) resolved.set(p, v);
      }
    }
    const inlineStyle = el.getAttribute('style');
    if (inlineStyle) {
      for (const [p, v] of parseSafeColorDecls(inlineStyle)) resolved.set(p, v);
    }

    for (const [prop, value] of resolved) {
      el.setAttribute(prop, value);
    }
  }

  // Drop the carriers themselves. The second sanitizer pass forbids them again,
  // so this is redundancy, not the guarantee.
  for (const styleEl of Array.from(root.querySelectorAll('style'))) {
    styleEl.remove();
  }
  for (const el of root.querySelectorAll('[style]')) {
    el.removeAttribute('style');
  }
}

// Shared restriction of the allowed grammar to the SVG (+ filter) profile. This
// drops HTML/MathML elements and, with the forbid lists, every active-content
// vector.
const BASE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  RETURN_DOM_FRAGMENT: false,
  // Disallow data: URIs / unknown protocols in attributes; only same-document
  // refs and safe protocols survive. javascript: is stripped by default.
  ALLOW_DATA_ATTR: false,
};

const ACTIVE_CONTENT_TAGS = ['script', 'foreignObject', 'use', 'iframe', 'embed', 'object'];
const EVENT_HANDLER_ATTRS = ['onload', 'onerror', 'onclick', 'onmouseover', 'onbegin', 'onend', 'onrepeat'];

// Sanitize raw SVG markup and return the cleaned string, or null if the input
// is not a valid SVG-rooted document. The output is guaranteed (by DOMPurify
// with the SVG profile) to contain no <script>, <foreignObject>, event-handler
// attributes, javascript: URLs, external <use> references, <style> element or
// style attribute — hence no CSS expression()/url(javascript:)/@import payload.
export function sanitizeSvg(rawText) {
  if (!looksLikeSvgRoot(rawText)) {
    return null;
  }
  const purify = getPurifier();

  // Pass 1 — full sanitization EXCEPT that <style>/style survive, so their
  // colour declarations can still be read. Every active-content vector is
  // already gone at this point; CSS is the only thing still standing, and it is
  // never trusted: we copy out of it only values that match the allowlist, then
  // delete it. Working on this DOM (rather than re-parsing the raw bytes with a
  // different parser) is what closes the parser-differential gap and what fixed
  // Inkscape logos being rejected outright by the XML round-trip.
  let stage;
  try {
    const dom = purify.sanitize(rawText, {
      ...BASE_CONFIG,
      FORBID_TAGS: ACTIVE_CONTENT_TAGS,
      FORBID_ATTR: EVENT_HANDLER_ATTRS,
      RETURN_DOM: true,
    });
    inlineSafeColors(dom);
    stage = dom.innerHTML;
  } catch {
    // Never let a malformed document turn an upload into a 500: fall back to
    // sanitizing the raw bytes (colour migration is the only thing lost).
    stage = rawText;
  }

  // Pass 2 — sanitize again, now forbidding <style> and the style attribute
  // outright. Re-sanitizing the serialized output is also the standard defence
  // against mXSS: anything the serializer could have re-shaped is parsed and
  // cleaned a second time.
  const clean = purify.sanitize(stage, {
    ...BASE_CONFIG,
    FORBID_TAGS: [...ACTIVE_CONTENT_TAGS, 'style'],
    FORBID_ATTR: [...EVENT_HANDLER_ATTRS, 'style'],
    RETURN_DOM: false,
  });

  const result = typeof clean === 'string' ? clean.trim() : '';
  // After sanitization the root must still be an <svg> element; if DOMPurify
  // stripped everything (input was not real SVG content) we reject.
  if (!result || !/^<svg[\s>]/i.test(result)) {
    return null;
  }
  return result;
}
