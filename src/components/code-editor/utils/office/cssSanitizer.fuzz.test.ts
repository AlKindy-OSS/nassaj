/**
 * RUNNER: vitest (`npm run test:client`) — jsdom (no constructable CSSOM, so
 * only the tokenizer path runs).
 * H1 regressions (`\<url(` and `\<image-set(` turning into a real url() after
 * `<` escaping) and a seeded property test: sanitizing is idempotent and the
 * output, read by an INDEPENDENT reference tokenizer, references no resource
 * other than data: images/fonts or #fragments.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeCssText, sanitizeStyleAttribute, sanitizeStylesheet } from './cssSanitizer';
import { sanitizeDocumentHtml } from './sanitizeDocumentHtml';

/**
 * Minimal reference CSS tokenizer (CSS Syntax 3 §4.3), written separately
 * from the production one: returns every function name (lower-cased, escapes
 * decoded), url-token value and at-keyword in the text.
 */
function referenceScan(input: string): { functions: string[]; urls: string[]; atRules: string[] } {
  const css = input.replace(/\r\n?|\f/g, '\n');
  const functions: string[] = [];
  const urls: string[] = [];
  const atRules: string[] = [];
  let i = 0;
  const hex = (c?: string) => c !== undefined && /[0-9a-fA-F]/.test(c);
  const nameStart = (c?: string) => c !== undefined && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80);
  const nameChar = (c?: string) => nameStart(c) || (c !== undefined && /[0-9-]/.test(c));
  const validEscape = (at: number) => css[at] === '\\' && css[at + 1] !== '\n';
  const identStart = (at: number) => (css[at] === '-'
    ? nameStart(css[at + 1]) || css[at + 1] === '-' || validEscape(at + 1)
    : nameStart(css[at]) || validEscape(at));
  const escape = (): string => {
    if (i >= css.length) return '\uFFFD';
    if (!hex(css[i])) return css[i++];
    let h = '';
    while (h.length < 6 && hex(css[i])) h += css[i++];
    if (css[i] === ' ' || css[i] === '\t' || css[i] === '\n') i += 1;
    const v = parseInt(h, 16);
    return v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(v);
  };
  const name = (): string => {
    let out = '';
    for (;;) {
      if (nameChar(css[i])) out += css[i++];
      else if (validEscape(i)) { i += 1; out += escape(); } else return out;
    }
  };
  const string = (quote: string) => {
    i += 1;
    while (i < css.length && css[i] !== quote && css[i] !== '\n') {
      if (css[i] === '\\') { i += 1; if (css[i] === '\n') i += 1; else if (i < css.length) escape(); } else i += 1;
    }
    if (css[i] === quote) i += 1;
  };
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else if (c === '"' || c === "'") string(c);
    else if (c === '@' && identStart(i + 1)) { i += 1; atRules.push(name().toLowerCase()); } else if (identStart(i)) {
      const n = name().toLowerCase();
      if (css[i] !== '(') continue;
      i += 1;
      if (n === 'url') {
        while (/[ \t\n]/.test(css[i] ?? '')) i += 1;
        if (css[i] === '"' || css[i] === "'") { functions.push('url'); continue; }
        let v = '';
        while (i < css.length && css[i] !== ')') { if (validEscape(i)) { i += 1; v += escape(); } else v += css[i++]; }
        i += 1;
        urls.push(v.trim());
      } else functions.push(n);
    } else i += 1;
  }
  return { functions, urls, atRules };
}

const QUOTED_URL = /url\(\s*"([^"\\]*)"\s*\)/gi;

/** Fails when the output references anything but data: images/fonts or #fragments. */
function expectNoExternalReference(output: string): void {
  const { functions, urls, atRules } = referenceScan(output);
  expect(atRules.filter((rule) => rule.includes('import'))).toEqual([]);
  expect(functions.filter((fn) => /image|cross-fade|element|^src$/.test(fn))).toEqual([]);
  for (const url of urls) expect(url).toMatch(/^(data:(image|font)\/|#)/);
  // Quoted url("…") functions: our serializer only ever writes safe ones.
  const quoted = [...output.matchAll(QUOTED_URL)].map((match) => match[1]);
  expect(functions.filter((fn) => fn === 'url').length).toBe(quoted.length);
  for (const url of quoted) expect(url).toMatch(/^(data:(image|font)\/|#)/);
  expect(output).not.toContain('<');
}

describe('H1: escaped "<" before a resource function', () => {
  it.each([
    'list-style: \\<url(http://evil.example/x)',
    'background: \\<image-set("http://evil.example/x" 1x)',
    'background: \\<\\75rl(http://evil.example/x)',
    'background: a\\<url(http://evil.example/x)',
    'background: \\\\<url(http://evil.example/x)',
    'background: \\3c url(http://evil.example/x)',
    'background: \\<-webkit-image-set(url(//evil.example/a) 1x)',
  ])('style attribute %s', (style) => {
    const clean = sanitizeStyleAttribute(style) ?? '';
    expect(clean).not.toContain('evil.example');
    expectNoExternalReference(clean);
    const html = sanitizeDocumentHtml(`<ul><li style="${style.replace(/"/g, '&quot;')}">x</li></ul>`);
    expect(html).not.toContain('evil.example');
  });

  it.each([
    '.a{list-style:\\<url(http://evil.example/x)}',
    '.a{background:\\<image-set("http://evil.example/x" 1x)}',
    '@\\<import "http://evil.example/a.css"; .b{color:red}',
  ])('stylesheet %s', (css) => {
    const clean = sanitizeStylesheet(css);
    expect(clean).not.toContain('evil.example');
    expectNoExternalReference(clean);
  });
});

/** Deterministic PRNG (mulberry32) so failures are reproducible by seed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  '\\', '\\\\', '<', '"', "'", '(', ')', '/*', '*/', ' ', '\n', ';', ':', '{', '}', '@', '#', '-', ',',
  'url(', 'URL(', 'image-set(', '-webkit-image-set(', 'src(', 'cross-fade(', 'element(', 'import ',
  '\\75 ', '\\75rl(', '\\<', '\\3c ', '\\000075', 'u', 'r', 'l', 'x', '3c', '7', '5',
  'http://evil.example/', 'data:image/png;base64,iVBORw0KGgo=', '#frag', 'a', 'color', 'red',
];

describe('property: sanitized CSS is a safe fixpoint', () => {
  it('holds for 5000 random hostile inputs', () => {
    const next = random(20261015);
    for (let run = 0; run < 5000; run += 1) {
      const length = 1 + Math.floor(next() * 24);
      let input = '';
      for (let index = 0; index < length; index += 1) input += PIECES[Math.floor(next() * PIECES.length)];
      const once = sanitizeCssText(input);
      try {
        expect(sanitizeCssText(once)).toBe(once);
        expectNoExternalReference(once);
      } catch (error) {
        throw new Error(`seed run ${run}: input ${JSON.stringify(input)} → ${JSON.stringify(once)}\n${String(error)}`);
      }
    }
  });
});
