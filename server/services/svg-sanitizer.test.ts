/**
 * Tests for server/services/svg-sanitizer.js — the branding/plugin SVG upload
 * sanitizer (B-42).
 *
 * The requirement has two halves that pull against each other:
 *   1. COLOUR MUST SURVIVE. Logo exporters paint through CSS (<style> class
 *      rules, style attributes). The sanitizer removes both, so without a
 *      migration step the logo loses every fill and SVG falls back to solid
 *      black — the dark-theme logo becomes unreadable. That is B-42.
 *   2. CSS MUST NOT BECOME AN XSS VECTOR. <style>/style are precisely the
 *      carriers for expression(), url(javascript:), @import, behavior and
 *      external references.
 * The resolution is an allowlist of properties AND of value shapes: anything not
 * read with certainty is dropped (fail-closed).
 *
 * Fixture policy (lesson of 2026-06-28: synthetic fixtures give false
 * confidence — a regex that passed 18/18 green tests matched 6.5% of real data):
 * every colour-survival test below runs against SVG files that actually ship in
 * this repo (public/*.svg, public/icons/*.svg), produced by Adobe Illustrator,
 * Inkscape and a web icon set. Two real files were failing before this fix:
 *   - public/icons/cursor-white.svg  — Illustrator, colour only in <style>.
 *   - public/nassaj-logo-on-dark.svg — Inkscape, colour only in style="", and
 *     was REJECTED OUTRIGHT (the old XML re-serialization emitted <svg:svg>
 *     because Inkscape declares xmlns:svg, so the root check failed).
 * The attack fixtures are the same real documents with a hostile value swapped
 * into the same position, not shapes invented for the test.
 *
 * Guard policy: every guard here is proven by MUTATION — the guard is removed
 * from a copy of the module, and the test asserts the payload then leaks. A
 * guard whose removal changes nothing is not a guard; those are called out in
 * comments as defence-in-depth rather than claimed as protection.
 *
 * Framework: node:test + node:assert/strict via tsx, matching the server suite.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { sanitizeSvg, looksLikeSvgRoot } from './svg-sanitizer.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SANITIZER_PATH = path.join(REPO_ROOT, 'server/services/svg-sanitizer.js');
const SANITIZER_SRC = fs.readFileSync(SANITIZER_PATH, 'utf8');

const readAsset = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Mutation harness
 * ------------------------------------------------------------------ */

type Mutation = { find: string; replace: string };
type Sanitizer = { sanitizeSvg: (s: string) => string | null; looksLikeSvgRoot: (s: string) => boolean };

// Mutant modules are written INSIDE the repo tree (not os.tmpdir) so that their
// bare `import 'dompurify'` / `import 'jsdom'` specifiers still resolve through
// the repo's node_modules. The directory is removed immediately afterwards.
const MUTANT_DIR = path.join(REPO_ROOT, 'server/services/.svg-sanitizer-mutants');
let mutantSeq = 0;

async function withMutant(mutations: Mutation[], fn: (mod: Sanitizer) => void | Promise<void>) {
  let src = SANITIZER_SRC;
  for (const { find, replace } of mutations) {
    assert.ok(
      src.includes(find),
      `mutation anchor no longer present in svg-sanitizer.js (the guard was renamed or removed): ${find}`
    );
    src = src.replace(find, replace);
  }
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  mutantSeq += 1;
  const file = path.join(MUTANT_DIR, `mutant-${process.pid}-${mutantSeq}.js`);
  fs.writeFileSync(file, src, 'utf8');
  try {
    const mod = (await import(pathToFileURL(file).href)) as Sanitizer;
    await fn(mod);
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 1. Colour survival on REAL repo logos
 * ------------------------------------------------------------------ */

// Adobe Illustrator export: the only colour in the file is `.st0 { fill: #edecec }`
// inside <defs><style>. Before the fix the sanitizer dropped the <style> and the
// mark rendered solid black.
test('real Illustrator logo (cursor-white.svg): <style> class colour survives', () => {
  const out = sanitizeSvg(readAsset('public/icons/cursor-white.svg'));
  assert.ok(out, 'the real logo must be accepted');
  assert.match(out!, /fill="#edecec"/, 'the .st0 fill must migrate onto the <path>');
  assert.doesNotMatch(out!, /<style/i, 'the <style> carrier itself must be gone');
});

// Inkscape export: colour lives in style="fill:#ffffff" on a <g>, and the file
// declares xmlns:svg — which made the previous XML round-trip serialize the root
// as <svg:svg> and the whole upload was rejected. This is the project's own
// dark-mode logo, i.e. exactly the B-42 symptom.
test('real Inkscape logo (nassaj-logo-on-dark.svg): accepted, and style="" colour survives', () => {
  const out = sanitizeSvg(readAsset('public/nassaj-logo-on-dark.svg'));
  assert.ok(out, 'the Inkscape logo must not be rejected');
  assert.match(out!, /^<svg[\s>]/i, 'root must still be <svg> (not the namespaced <svg:svg>)');
  assert.match(out!, /fill="#ffffff"/, 'the white fill must migrate onto the <g>');
  assert.doesNotMatch(out!, /style=/i, 'the style attribute carrier must be gone');
});

test('real light-mode logo (nassaj-logo-on-light.svg) survives with its paths intact', () => {
  const raw = readAsset('public/nassaj-logo-on-light.svg');
  const out = sanitizeSvg(raw);
  assert.ok(out, 'the light logo must be accepted');
  const rawPaths = (raw.match(/<path/g) || []).length;
  const outPaths = (out!.match(/<path/g) || []).length;
  assert.equal(outPaths, rawPaths, 'no path may be dropped by sanitization');
});

// Web icon set export: colour is in fill="" attributes, and style="" carries only
// non-colour layout properties which must simply be dropped.
test('real icon (gemini-ai-icon.svg): attribute colours kept, non-colour style dropped', () => {
  const out = sanitizeSvg(readAsset('public/icons/gemini-ai-icon.svg'));
  assert.ok(out);
  assert.match(out!, /fill="#3186FF"/i, 'existing fill attributes must be preserved verbatim');
  assert.doesNotMatch(out!, /line-height/i, 'non-colour CSS must not be migrated anywhere');
  assert.doesNotMatch(out!, /style=/i);
});

// Corpus check rather than a hand-picked pair: every SVG shipped in public/ must
// round-trip. This is what catches a guard that is too strict for real exporters.
test('every SVG shipped in public/ is accepted and keeps an <svg> root', () => {
  const dirs = ['public', 'public/icons', 'public/avatars-gallery'];
  const files: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.toLowerCase().endsWith('.svg')) files.push(path.join(dir, name));
    }
  }
  assert.ok(files.length >= 20, `expected a real corpus of SVGs, found ${files.length}`);
  const rejected: string[] = [];
  for (const rel of files) {
    const out = sanitizeSvg(readAsset(rel));
    if (!out || !/^<svg[\s>]/i.test(out)) rejected.push(rel);
  }
  assert.deepEqual(rejected, [], 'no real repo SVG may be rejected by the sanitizer');
});

/* ------------------------------------------------------------------ *
 * 2. Cascade correctness (the actual "logo stays black" mechanism)
 * ------------------------------------------------------------------ */

// Derived from the real Illustrator structure: exporters routinely emit BOTH a
// presentation attribute and a class rule that overrides it. In a browser the
// class rule wins (presentation attributes are the lowest-priority source), so
// once we delete the CSS we must carry its value over the attribute. Filling in
// only the MISSING attributes leaves the old black behind.
const ILLUSTRATOR_WITH_ATTR_FALLBACK = readAsset('public/icons/cursor-white.svg').replace(
  '<path class="st0"',
  '<path class="st0" fill="#000000"'
);

test('CSS beats an existing presentation attribute (cascade order)', () => {
  const out = sanitizeSvg(ILLUSTRATOR_WITH_ATTR_FALLBACK);
  assert.ok(out);
  assert.match(out!, /fill="#edecec"/, 'the class rule must override the black attribute');
  assert.doesNotMatch(out!, /fill="#000000"/, 'the overridden black must not survive');
});

test('mutation: keeping only missing attributes reintroduces the B-42 black logo', async () => {
  await withMutant(
    [{ find: '      el.setAttribute(prop, value);', replace: '      if (!el.hasAttribute(prop)) el.setAttribute(prop, value);' }],
    (mod) => {
      const out = mod.sanitizeSvg(ILLUSTRATOR_WITH_ATTR_FALLBACK);
      assert.match(String(out), /fill="#000000"/, 'without the cascade fix the logo stays black');
    }
  );
});

test('inline style beats a class rule, and both beat the attribute', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.st0{fill:#edecec}path{fill:#111}</style>' +
    '<path class="st0" fill="#000" style="fill:#ffffff" d="M0 0"/></svg>';
  const out = sanitizeSvg(svg);
  assert.match(String(out), /fill="#ffffff"/);
  assert.doesNotMatch(String(out), /#edecec|#111|#000"/);
});

test('#id selectors migrate (Inkscape/Figma emit them)', () => {
  const out = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><style>#p1{fill:#edecec}</style><path id="p1" d="M0 0"/></svg>'
  );
  assert.match(String(out), /fill="#edecec"/);
});

test('CSS comments in the stylesheet do not break colour migration', () => {
  // Illustrator/Inkscape emit generator comments inside <style>.
  const out = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><style>/* Generator: Adobe Illustrator */\n.st0{fill:#edecec}</style><path class="st0" d="M0 0"/></svg>'
  );
  assert.match(String(out), /fill="#edecec"/);
});

test('!important is stripped from the value rather than voiding it', () => {
  const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:#edecec !important" d="M0 0"/></svg>');
  assert.match(String(out), /fill="#edecec"/);
  assert.doesNotMatch(String(out), /important/i, 'the priority marker must not reach the attribute');
});

test('gradient stops keep stop-color and stop-opacity', () => {
  const out = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g">' +
      '<stop style="stop-color:#edecec;stop-opacity:0.5"/></linearGradient></defs>' +
      '<path fill="url(#g)" d="M0 0"/></svg>'
  );
  assert.match(String(out), /stop-color="#edecec"/);
  assert.match(String(out), /stop-opacity="0.5"/);
});

// A @media(prefers-color-scheme) rule must NOT be applied unconditionally: doing
// so repaints a light logo with the dark variant's colour — the same class of
// user-visible defect B-42 describes, in reverse.
const MEDIA_QUERY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><style>.st0{fill:#edecec}' +
  '@media (prefers-color-scheme: dark){.st0{fill:#000000}}</style><path class="st0" d="M0 0"/></svg>';

test('@media rules are not applied unconditionally', () => {
  const out = sanitizeSvg(MEDIA_QUERY_SVG);
  assert.match(String(out), /fill="#edecec"/);
  assert.doesNotMatch(String(out), /#000000/, 'the dark-scheme value must not be baked in');
});

// What actually prevents this is the brace-depth-aware block scanner: an at-rule
// and everything nested inside it is consumed as ONE block, so its inner rules
// can never surface as top-level rules. The mutation therefore replaces the
// scanner with the previously shipped regex (`/([^{}]+)\{([^{}]*)\}/g`), which
// happily matched the nested `.st0{fill:#000000}` and baked the dark-scheme
// colour into every logo.
test('mutation: the previously shipped regex scanner bakes in the @media colour', async () => {
  await withMutant(
    [
      {
        find: '  const rules = [];\n  let i = 0;',
        replace:
          '  const rules = [];\n' +
          '  { const blockRe = /([^{}]+)\\{([^{}]*)\\}/g; let m;\n' +
          '    while ((m = blockRe.exec(css)) !== null) rules.push([m[1].trim(), m[2]]);\n' +
          '    return rules; }\n' +
          '  let i = 0;',
      },
    ],
    (mod) => {
      assert.match(String(mod.sanitizeSvg(MEDIA_QUERY_SVG)), /#000000/, 'the old scanner leaks the nested dark-scheme rule');
    }
  );
});

/* ------------------------------------------------------------------ *
 * 3. XSS vectors — every one proven by mutation
 * ------------------------------------------------------------------ */

// Hostile values injected into the exact position the real Illustrator export
// uses for its colour, so the payload travels the same code path the fix opened.
const inStyleBlock = (value: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><defs><style>\n      .st0 {\n        fill: ${value};\n      }\n    </style></defs><path class="st0" d="M0 0"/></svg>`;
const inStyleAttr = (value: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><path class="st0" style="fill:${value}" d="M0 0"/></svg>`;

const VALUE_PAYLOADS: Array<[string, string]> = [
  ['expression', 'expression(alert(1))'],
  ['javascript url', 'url(javascript:alert(1))'],
  ['javascript url, quoted', "url('javascript:alert(1)')"],
  ['data uri', 'url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)'],
  ['protocol-relative external ref', 'url(//evil.example/x.svg#g)'],
  ['absolute external ref', 'url(https://evil.example/x.svg#g)'],
  ['external image()', 'image("https://evil.example/t.png")'],
  ['css variable', 'var(--x)'],
  ['attr()', 'attr(href)'],
  ['escaped url token', '\\75 rl(javascript:alert(1))'],
  ['unknown identifier', 'definitelynotacolor'],
];

test('no hostile CSS value reaches a presentation attribute (<style> block)', () => {
  for (const [name, payload] of VALUE_PAYLOADS) {
    const out = String(sanitizeSvg(inStyleBlock(payload)));
    assert.doesNotMatch(out, /fill=/i, `payload migrated a fill attribute: ${name}`);
    assert.doesNotMatch(out, /javascript:|expression\(|behavior|evil\.example|data:|onload|var\(|attr\(/i, `payload leaked: ${name}`);
  }
});

test('no hostile CSS value reaches a presentation attribute (style attribute)', () => {
  for (const [name, payload] of VALUE_PAYLOADS) {
    const out = String(sanitizeSvg(inStyleAttr(payload)));
    assert.doesNotMatch(out, /fill=/i, `payload migrated a fill attribute: ${name}`);
    assert.doesNotMatch(out, /javascript:|expression\(|behavior|evil\.example|data:|onload|var\(|attr\(/i, `payload leaked: ${name}`);
  }
});

// A declaration break-out ("#fff;behavior:url(#default#time2)") is handled by
// the property allowlist rather than the value allowlist: the value ends at the
// ';', the safe colour migrates, and the smuggled `behavior` declaration is
// dropped because it is not a colour property. Asserted explicitly so the
// difference from the payloads above is deliberate, not accidental.
test('a declaration break-out yields only the safe colour, never the smuggled property', () => {
  for (const svg of [inStyleBlock('#fff;behavior:url(#default#time2)'), inStyleAttr('#fff;behavior:url(#default#time2)')]) {
    const out = String(sanitizeSvg(svg));
    assert.match(out, /fill="#fff"/, 'the leading safe colour is legitimate and survives');
    assert.doesNotMatch(out, /behavior|default#time2/i, 'the smuggled declaration must not appear anywhere');
  }
});

// A quote break-out is neutralised one layer earlier, by the HTML parser: the
// attribute value ends at the quote and `onload="alert(1)"` becomes a separate
// attribute, which DOMPurify then removes. The leading colour is a real colour
// and legitimately survives; what must never survive is the handler.
test('a quote break-out inside style="" cannot introduce an event handler', () => {
  const out = String(sanitizeSvg(inStyleAttr('#fff" onload="alert(1)')));
  assert.doesNotMatch(out, /onload|alert/i);
  assert.doesNotMatch(String(sanitizeSvg(inStyleBlock('#fff" onload="alert(1)'))), /onload|alert|fill=/i);
});

// The property allowlist is a SCOPE guard, not the last line of defence: it
// keeps arbitrary CSS properties from becoming SVG attributes. Removing it lets
// a non-colour property through — while DOMPurify's own attribute allowlist
// still blocks the event handler underneath it. Both layers are asserted here so
// the division of labour is explicit rather than assumed.
test('mutation: without the property allowlist, non-colour properties become attributes', async () => {
  await withMutant(
    [{ find: '    if (COLOR_PRESENTATION_PROPS.has(prop) && isSafePresentationValue(value)) {', replace: '    if (isSafePresentationValue(value)) {' }],
    (mod) => {
      const out = String(mod.sanitizeSvg(inStyleAttr('#fff;mask:none;onload:none')));
      assert.match(out, /mask="none"/, 'an arbitrary property leaks into an attribute without the allowlist');
      assert.doesNotMatch(out, /onload/i, 'but DOMPurify still refuses the event-handler attribute');
    }
  );
  // The real implementation lets neither through.
  const real = String(sanitizeSvg(inStyleAttr('#fff;mask:none;onload:none')));
  assert.doesNotMatch(real, /mask=|onload/i);
  assert.match(real, /fill="#fff"/);
});

// THE load-bearing guard. Remove the value allowlist and every payload above
// lands in a fill attribute — this is the proof that the whole colour feature
// rests on value validation, not on hope.
test('mutation: without the value allowlist, hostile CSS values become attributes', async () => {
  await withMutant(
    [{ find: 'function isSafePresentationValue(rawValue) {', replace: 'function isSafePresentationValue(rawValue) {\n  if (true) return true;' }],
    (mod) => {
      const leaked = String(mod.sanitizeSvg(inStyleBlock('expression(alert(1))')));
      assert.match(leaked, /fill="expression\(alert\(1\)\)"/, 'expression() must leak once the allowlist is gone');
      const leaked2 = String(mod.sanitizeSvg(inStyleAttr('url(javascript:alert(1))')));
      assert.match(leaked2, /javascript:/i, 'url(javascript:) must leak once the allowlist is gone');
    }
  );
});

// The named-colour set is what makes identifiers fail-CLOSED. The previous
// implementation accepted "any CSS identifier", i.e. any word we never
// understood, which is the fail-open shape this replaces.
test('mutation: accepting any identifier (the old rule) lets unknown values through', async () => {
  await withMutant(
    [{ find: '  if (NAMED_COLORS.has(v.toLowerCase())) {\n    return true;\n  }', replace: '  if (/^[a-zA-Z][a-zA-Z-]*$/.test(v)) {\n    return true;\n  }' }],
    (mod) => {
      assert.match(String(mod.sanitizeSvg(inStyleAttr('definitelynotacolor'))), /fill="definitelynotacolor"/);
    }
  );
  // …and the real rule still accepts genuine named colours.
  assert.match(String(sanitizeSvg(inStyleAttr('white'))), /fill="white"/);
  assert.match(String(sanitizeSvg(inStyleAttr('currentColor'))), /fill="currentColor"/);
  assert.match(String(sanitizeSvg(inStyleAttr('none'))), /fill="none"/);
});

// url(#id) is allowed — gradient logos need it — but ONLY in its fragment form.
test('same-document url(#id) paint refs are allowed', () => {
  const out = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="#edecec"/></linearGradient></defs>' +
      '<path style="fill:url(#g)" d="M0 0"/></svg>'
  );
  assert.match(String(out), /fill="url\(#g\)"/);
});

test('mutation: a permissive url() pattern lets javascript: and external refs in', async () => {
  await withMutant(
    [{ find: 'const LOCAL_URL_REF = /^url\\(#[A-Za-z_][A-Za-z0-9_.-]*\\)$/;', replace: 'const LOCAL_URL_REF = /^url\\(.*\\)$/;' }],
    (mod) => {
      assert.match(String(mod.sanitizeSvg(inStyleAttr('url(javascript:alert(1))'))), /javascript:/i);
      assert.match(String(mod.sanitizeSvg(inStyleAttr('url(//evil.example/x.svg#g)'))), /evil\.example/i);
    }
  );
});

/* ------------------------------------------------------------------ *
 * 4. The CSS carriers themselves, and classic active content
 * ------------------------------------------------------------------ */

const CARRIER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://evil.example/x.css");.st0{fill:#edecec}</style>' +
  '<path class="st0" style="fill:#edecec" d="M0 0"/></svg>';

test('<style> elements and style attributes never appear in the output', () => {
  const out = String(sanitizeSvg(CARRIER_SVG));
  assert.doesNotMatch(out, /<style/i);
  assert.doesNotMatch(out, /style=/i);
  assert.doesNotMatch(out, /@import|evil\.example/i);
  assert.match(out, /fill="#edecec"/, 'while the colour still made it across');
});

// The carriers are removed twice on purpose (once when we strip them from the
// DOM, once by the second DOMPurify pass). Each removal alone is sufficient —
// so a single mutation must NOT leak, and only removing both may.
test('mutation: carrier removal is genuinely defence-in-depth (both layers must fail to leak)', async () => {
  const dropDomRemoval: Mutation = {
    find: "  for (const styleEl of Array.from(root.querySelectorAll('style'))) {\n    styleEl.remove();\n  }\n  for (const el of root.querySelectorAll('[style]')) {\n    el.removeAttribute('style');\n  }",
    replace: '  /* mutated: DOM-level carrier removal disabled */',
  };
  const dropPurifyForbid: Mutation = {
    find: "    FORBID_TAGS: [...ACTIVE_CONTENT_TAGS, 'style'],\n    FORBID_ATTR: [...EVENT_HANDLER_ATTRS, 'style'],",
    replace: '    FORBID_TAGS: ACTIVE_CONTENT_TAGS,\n    FORBID_ATTR: EVENT_HANDLER_ATTRS,',
  };

  await withMutant([dropDomRemoval], (mod) => {
    assert.doesNotMatch(String(mod.sanitizeSvg(CARRIER_SVG)), /<style|style=/i, 'the DOMPurify pass alone must still remove the carriers');
  });
  await withMutant([dropPurifyForbid], (mod) => {
    assert.doesNotMatch(String(mod.sanitizeSvg(CARRIER_SVG)), /<style|style=/i, 'the DOM removal alone must still remove the carriers');
  });
  await withMutant([dropDomRemoval, dropPurifyForbid], (mod) => {
    const out = String(mod.sanitizeSvg(CARRIER_SVG));
    assert.match(out, /<style|style=/i, 'with BOTH layers gone the carriers survive — proving neither is decorative');
  });
});

test('script, event handlers and external <use> are stripped from a real-looking logo', () => {
  const hostile = readAsset('public/icons/cursor-white.svg')
    .replace('<defs>', '<defs><script>alert(1)</script>')
    .replace('<path class="st0"', '<use href="https://evil.example/x.svg#p"/><path class="st0" onload="alert(1)"');
  const out = String(sanitizeSvg(hostile));
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /\bon[a-z]+\s*=/i);
  assert.doesNotMatch(out, /<use/i);
  assert.doesNotMatch(out, /evil\.example/i);
  assert.match(out, /fill="#edecec"/, 'and the legitimate colour still survives the hostile document');
});

/* ------------------------------------------------------------------ *
 * 5. The structural gate (looksLikeSvgRoot)
 * ------------------------------------------------------------------ */

const HTML_WITH_SVG = '<html><body><img src=x onerror=alert(1)><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg></body></html>';

test('a document that merely contains <svg> is rejected — SVG must be the root', () => {
  assert.equal(looksLikeSvgRoot(HTML_WITH_SVG), false);
  assert.equal(sanitizeSvg(HTML_WITH_SVG), null);
});

test('mutation: a substring-based root check accepts HTML polyglots', async () => {
  await withMutant(
    [{ find: "  return /^<svg(\\s|>|\\/)/i.test(s);", replace: '  return /<svg(\\s|>|\\/)/i.test(s);' }],
    (mod) => {
      assert.equal(mod.looksLikeSvgRoot(HTML_WITH_SVG), true, 'the mutated gate lets a non-SVG-rooted file be stored as logo.svg');
    }
  );
});

// An internal DTD subset (entity declarations — the billion-laughs / XXE shape)
// makes the document fail the root gate, so no parser ever expands it.
test('a DOCTYPE carrying an internal entity subset is rejected outright', () => {
  const payload =
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "aaaa"><!ENTITY lol2 "&lol;&lol;&lol;">]>' +
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="&lol2;"/></svg>';
  assert.equal(looksLikeSvgRoot(payload), false);
  assert.equal(sanitizeSvg(payload), null);
});

test('a plain DOCTYPE, XML prolog, BOM and leading comments are still accepted', () => {
  const real = readAsset('public/icons/cursor-white.svg');
  assert.equal(looksLikeSvgRoot('﻿' + real), true, 'BOM');
  assert.equal(
    looksLikeSvgRoot(real.replace('<svg', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg')),
    true,
    'plain DOCTYPE'
  );
  assert.equal(looksLikeSvgRoot(''), false);
  assert.equal(looksLikeSvgRoot(null as unknown as string), false);
});

/* ------------------------------------------------------------------ *
 * 6. Robustness — an upload must never turn into a 500
 * ------------------------------------------------------------------ */

test('malformed / adversarial documents return null or a clean string, never throw', () => {
  const inputs = [
    '<svg',
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:</style><path class="a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>' + '.a{fill:#fff}'.repeat(5000) + '</style><path class="a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{' + 'x'.repeat(100000) + '}</style><path class="a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="' + 'fill:'.repeat(20000) + '"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@media{@media{@media{.a{fill:#fff}}}}</style><path class="a"/></svg>',
  ];
  for (const input of inputs) {
    const out = sanitizeSvg(input);
    assert.ok(out === null || typeof out === 'string', 'must return null or string');
    if (out) assert.doesNotMatch(out, /<style|style=/i);
  }
});

// The 64-character value cap bounds every value regex, so no crafted value can
// drive the alternation into pathological backtracking.
test('an oversized value is rejected and parsing stays fast', () => {
  const payload = 'rgb(' + ' '.repeat(5000) + 'x)';
  const started = Date.now();
  const out = sanitizeSvg(inStyleAttr(payload));
  assert.doesNotMatch(String(out), /fill=/i);
  assert.ok(Date.now() - started < 2000, 'value validation must not blow up on a long value');
});
