import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { detectDirection } from './direction';
import { SafeMarkdown } from './safeMarkdown';
import { safeExternalHref } from './safeUrl';
import { parseTranscript } from './types';

const render = (text: string, selfHost = 'nassaj.example') =>
  renderToStaticMarkup(<SafeMarkdown text={text} selfHost={selfHost} />);

describe('safeExternalHref', () => {
  it('accepts http and https only', () => {
    expect(safeExternalHref('https://example.com/a?b=1#c', 'nassaj.example')).toBe('https://example.com/a?b=1#c');
    expect(safeExternalHref('http://example.com', 'nassaj.example')).toBe('http://example.com/');
  });

  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>',
    'vbscript:msgbox(1)', 'file:///etc/passwd', 'blob:https://example.com/x', 'ftp://example.com',
    'mailto:a@b.c', '//example.com', '/relative', 'relative', '', '#frag',
  ])('rejects %j', (href) => {
    expect(safeExternalHref(href, 'nassaj.example')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(safeExternalHref(undefined, 'x')).toBeNull();
    expect(safeExternalHref(42, 'x')).toBeNull();
  });

  it('treats the app host as text regardless of port, scheme or case', () => {
    expect(safeExternalHref('https://nassaj.example/s/abc', 'nassaj.example')).toBeNull();
    expect(safeExternalHref('http://NASSAJ.example:8080/', 'nassaj.example')).toBeNull();
    expect(safeExternalHref('https://other.example/', 'nassaj.example')).not.toBeNull();
  });
});

describe('SafeMarkdown', () => {
  it('renders ordinary markdown', () => {
    const html = render('**bold** and `code`\n\n- one\n- two');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders GFM tables', () => {
    expect(render('|a|b|\n|-|-|\n|1|2|')).toContain('<table>');
  });

  it('never emits raw html elements or handlers', () => {
    const html = render('<script>alert(1)</script><img src=x onerror=alert(1)><svg onload=alert(1)></svg><iframe src="https://e.com"></iframe>');
    expect(html).not.toMatch(/<(script|img|svg|iframe)/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('adds safe attributes to external links', () => {
    const html = render('[x](https://example.com/p)');
    expect(html).toContain('href="https://example.com/p"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it.each([
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](java&#115;cript:alert(1))',
    '[x](data:text/html,hi)', '[x](vbscript:1)', '[x][1]\n\n[1]: javascript:alert(1)', '<javascript:alert(1)>',
  ])('renders %j without a link', (markdown) => {
    const html = render(markdown);
    expect(html).not.toContain('<a');
    expect(html).not.toMatch(/href=/i);
  });

  it('keeps the label of a rejected link as text', () => {
    expect(render('[click me](javascript:alert(1))')).toContain('click me');
  });

  it('renders a valid reference-style link', () => {
    expect(render('[x][1]\n\n[1]: https://example.com/ref')).toContain('href="https://example.com/ref"');
  });

  it('renders links to the app host as plain text', () => {
    const html = render('[home](https://nassaj.example/) and https://nassaj.example/api/x');
    expect(html).not.toContain('<a');
    expect(html).toContain('home');
  });

  it('autolinks bare external urls via GFM', () => {
    expect(render('see https://example.com/page')).toContain('href="https://example.com/page"');
  });

  it('renders images as their alt text and never as <img>', () => {
    const html = render('![a cat](https://example.com/cat.png) ![](https://example.com/x.png) ![x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('example.com/cat.png');
    expect(html).toContain('a cat');
    expect(html).toContain('صورة');
  });

  it('does not decode-and-execute entity tricks inside text', () => {
    expect(render('&lt;script&gt;alert(1)&lt;/script&gt;')).not.toContain('<script');
  });
});

describe('detectDirection', () => {
  it('follows the first strong character', () => {
    expect(detectDirection('مرحبا hello')).toBe('rtl');
    expect(detectDirection('hello مرحبا')).toBe('ltr');
    expect(detectDirection('123 - مرحبا')).toBe('rtl');
    expect(detectDirection('שלום')).toBe('rtl');
  });

  it('defaults to rtl when there is no strong character', () => {
    expect(detectDirection('')).toBe('rtl');
    expect(detectDirection('123 !?')).toBe('rtl');
  });
});

describe('parseTranscript', () => {
  const valid = {
    v: 1, title: 't', createdAt: '2026-01-01T00:00:00Z', providerLabel: 'p',
    messages: [{ role: 'user', author: 'a', at: '2026-01-01T00:00:00Z', parts: [{ t: 'text', text: 'hi' }, { t: 'redacted', cat: 'secret' }] }],
  };

  it('accepts the v1 shape', () => {
    expect(parseTranscript(valid)?.messages[0].parts).toHaveLength(2);
  });

  it.each([
    null, 'x', 42, {}, { ...valid, v: 2 }, { ...valid, title: 5 }, { ...valid, messages: 'no' },
    { ...valid, messages: [{ role: 'root', parts: [] }] },
    { ...valid, messages: [{ role: 'user', parts: [{ t: 'html', text: '<b>' }] }] },
    { ...valid, messages: [{ role: 'user', parts: [{ t: 'text' }] }] },
  ])('rejects malformed input %#', (input) => {
    expect(parseTranscript(input)).toBeNull();
  });

  it('drops unknown fields', () => {
    const parsed = parseTranscript({ ...valid, extra: 'x', messages: [{ ...valid.messages[0], secret: 'x' }] });
    expect(parsed && 'extra' in parsed).toBe(false);
  });
});
