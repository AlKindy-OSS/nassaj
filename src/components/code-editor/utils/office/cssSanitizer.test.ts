/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * Untrusted CSS: no <style> breakout (C1), no network-capable reference via
 * escapes or image-set (C2), linear time on hostile input (C2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CSS_CHARS,
  MAX_STYLE_ATTRIBUTE_CHARS,
  referencesExternalResource,
  sanitizeCssText,
  sanitizeStyleAttribute,
  sanitizeStylesheet,
} from './cssSanitizer';
import { PNG_1X1_BASE64 } from './testing/officeFixtures';

const TTF_BASE64 = btoa(String.fromCharCode(0, 1, 0, 0, 0, 10, 0, 128, 0, 3, 0, 32));
const EVIL = 'evil.test';

/** No url()/src()/@import survives except data: or #fragment references. */
const onlySafeUrls = (css: string): boolean => !/url\((?!"data:(image|font)\/|"#)/i.test(css) && !/@import/i.test(css);

describe('sanitizeCssText — C1 style-element breakout', () => {
  it.each([
    '</style><script>alert(1)</script>',
    '</</stylestyle><script>alert(1)</script>',
    '<</style/style><img src=x onerror=alert(1)>',
    '.a{content:"</style><script>alert(1)</script>"}',
    "@font-face{font-family:'x</style><svg onload=alert(1)>'}",
  ])('leaves no "<" at all in %s', (payload) => {
    const out = sanitizeCssText(payload);
    expect(out).not.toContain('<');
    expect(out.toLowerCase()).not.toContain('</style');
  });

  it('keeps the meaning of "<" in strings via the \\3c escape', () => {
    expect(sanitizeCssText('.a::before{content:"a<b"}')).toBe('.a::before{content:"a\\3c b"}');
  });
});

describe('sanitizeCssText — C2 resource references', () => {
  it.each([
    [`.a{background:url(http://${EVIL}/x)}`],
    [`.a{background:URL( "http://${EVIL}/x" )}`],
    [`.a{background:\\75rl(http://${EVIL}/x)}`],
    [`.a{background:u\\72 l(http://${EVIL}/x)}`],
    [`.a{background:\\000075\\72l('//${EVIL}/x')}`],
    [`.a{background-image:image-set("http://${EVIL}/a.png" 1x)}`],
    [`.a{background-image:-webkit-image-set(url(//${EVIL}/a.png) 1x)}`],
    [`.a{background:src("http://${EVIL}/x")}`],
    [`.a{background:cross-fade(url(http://${EVIL}/a) 50%, red)}`],
    [`.a{cursor:url(http://${EVIL}/c.cur),auto}`],
    [`@font-face{src:url(https://${EVIL}/f.woff2)}`],
    [`.a{background:url(data:text/html;base64,PHNjcmlwdD4=)}`],
    [`.a{background:url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)}`],
    [`.a{background:url(javascript:alert(1))}`],
  ])('neutralizes %s', (css) => {
    const out = sanitizeCssText(css);
    expect(onlySafeUrls(out)).toBe(true);
    expect(out).not.toMatch(/image-set|cross-fade|src\(/i);
    expect(referencesExternalResource(out)).toBe(false);
  });

  it.each([
    [`@import url("http://${EVIL}/a.css"); .b{color:red}`],
    [`@\\69mport "http://${EVIL}/a.css"; .b{color:red}`],
    [`@IMPORT url(//${EVIL}/a.css) screen; .b{color:red}`],
    [`@media screen{@import "//${EVIL}/a.css";.b{color:red}}`],
  ])('drops the @import statement in %s', (css) => {
    const out = sanitizeCssText(css);
    expect(out).not.toMatch(/import/i);
    expect(out).not.toContain(EVIL);
    expect(out).toContain('.b{color:red}');
  });

  it('does not invent a url() from tokens split by a comment', () => {
    const out = sanitizeCssText(`.a{background:u/**/rl(http://${EVIL}/x)}`);
    expect(out).toContain('u/**/rl(');
    expect(referencesExternalResource(out)).toBe(false);
  });

  it('keeps data: images and fonts, re-tagged by their magic bytes', () => {
    const font = sanitizeCssText(
      `@font-face{font-family:F;src:url(data:application/vnd.openxmlformats-officedocument.obfuscatedFont;base64,${TTF_BASE64})}`,
    );
    expect(font).toContain(`url("data:font/ttf;base64,${TTF_BASE64}")`);
    const image = sanitizeCssText(`.a{background:url('data:application/octet-stream;base64,${PNG_1X1_BASE64}')}`);
    expect(image).toContain(`url("data:image/png;base64,${PNG_1X1_BASE64}")`);
  });

  it('keeps in-document #fragment references', () => {
    expect(sanitizeCssText('.a{filter:url(#blur)}')).toBe('.a{filter:url("#blur")}');
  });

  it('passes ordinary docx-preview CSS through unchanged', () => {
    const css = ".docx-wrapper { background: gray; padding: 30px; }\n.docx p { font-family: 'Times New Roman', serif; margin: 0pt 10.5pt; }\n"
      + '.docx_heading1 { color: #2F5496; } @media print { .docx { box-shadow: none; } }';
    // Strings are re-serialized canonically with double quotes.
    expect(sanitizeCssText(css)).toBe(css.replace("'Times New Roman'", '"Times New Roman"'));
  });

  it('is idempotent on hostile input', () => {
    const once = sanitizeCssText(`.a{x:\\75rl(//${EVIL})} </style> @\\69mport "x"; .b{y:"<"}`);
    expect(sanitizeCssText(once)).toBe(once);
  });
});

describe('sanitizeCssText — C2 linear time', () => {
  it.each([
    ['1 MB of "url("', 'url('.repeat(256 * 1024)],
    ['160 KB of "url(\'"', "url('".repeat(32 * 1024)],
    ['unterminated quoted url per rule', ".a{b:url('x".repeat(40 * 1024)],
  ])('handles %s in under 200 ms', (_label, css) => {
    const started = performance.now();
    sanitizeCssText(css);
    expect(performance.now() - started).toBeLessThan(200);
  });

  // Escape decoding does more work per character; still linear, looser bound.
  it.each([
    ['1 MB of escapes', '\\75'.repeat(340 * 1024)],
    ['1 MB of open comments and strings', '/*"'.repeat(340 * 1024)],
  ])('handles %s in under 400 ms', (_label, css) => {
    const started = performance.now();
    sanitizeCssText(css);
    expect(performance.now() - started).toBeLessThan(400);
  });
});

describe('sanitizeStylesheet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops stylesheets over the size cap', () => {
    expect(sanitizeStylesheet(`.a{}${' '.repeat(MAX_CSS_CHARS)}`)).toBe('');
  });

  it('runs a second tokenizer pass over the CSSOM serialization when available', () => {
    const received: string[] = [];
    class FakeSheet {
      cssRules: { cssText: string }[] = [];

      replaceSync(text: string) {
        received.push(text);
        // A hostile or buggy serializer must still not get through.
        this.cssRules = [{ cssText: `.x { background: url("http://${EVIL}/y"); }` }, { cssText: '.y { content: "</style>"; }' }];
      }
    }
    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    const out = sanitizeStylesheet(`.a{background:\\75rl(//${EVIL})}`);
    expect(received[0]).not.toContain(EVIL);
    expect(out).not.toContain(EVIL);
    expect(out).not.toContain('<');
  });

  it('falls back to the tokenizer output when the CSSOM rejects the text', () => {
    class ThrowingSheet {
      cssRules = [];

      replaceSync() {
        throw new Error('nope');
      }
    }
    vi.stubGlobal('CSSStyleSheet', ThrowingSheet);
    expect(sanitizeStylesheet('.a{color:red}')).toBe('.a{color:red}');
  });
});

describe('sanitizeStyleAttribute', () => {
  it('cleans declarations and removes empty or oversized values', () => {
    expect(sanitizeStyleAttribute(`color:red;background:url(http://${EVIL}/b)`)).toBe('color:red;background:none');
    expect(sanitizeStyleAttribute('  ')).toBeNull();
    expect(sanitizeStyleAttribute(`color:${'r'.repeat(MAX_STYLE_ATTRIBUTE_CHARS)}`)).toBeNull();
  });
});

describe('referencesExternalResource', () => {
  it('flags any resource reference but not fragments or plain values', () => {
    expect(referencesExternalResource(`url(http://${EVIL}/a)`)).toBe(true);
    expect(referencesExternalResource('\\75rl(x)')).toBe(true);
    expect(referencesExternalResource(`url(data:image/png;base64,${PNG_1X1_BASE64})`)).toBe(true);
    expect(referencesExternalResource('url(#grad)')).toBe(false);
    expect(referencesExternalResource('red')).toBe(false);
    expect(referencesExternalResource('rgb(1, 2, 3)')).toBe(false);
  });
});
