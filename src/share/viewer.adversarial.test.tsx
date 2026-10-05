import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { pickLocale } from './i18n';
import { ShareTranscript } from './ShareTranscript';
import { parseTranscript } from './types';

/**
 * ADR-196 / T-1970 stage 7: the wire JSON is untrusted too (a compromised or buggy server, a
 * proxy). Fields the markdown path never touches - title, provider label, dates, redaction
 * text, unknown keys - must still reach the DOM as inert text.
 */
const MARKUP = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
const html = (raw: unknown) => {
  const data = parseTranscript(raw);
  if (!data) throw new Error('rejected');
  return renderToStaticMarkup(<ShareTranscript transcript={data} strings={pickLocale('en-US')} />);
};
const base = (over: Record<string, unknown> = {}) => ({
  v: 1, title: 'T', toolCount: 0,
  messages: [{ role: 'user', author: 'owner', parts: [{ t: 'text', text: 'hello' }] }], ...over,
});

describe('hostile wire data renders inert', () => {
  it('escapes markup in title, provider label and dates', () => {
    const out = html(base({ title: MARKUP, providerLabel: MARKUP, createdAt: MARKUP, expiresAt: MARKUP }));
    expect(out).not.toMatch(/<img|<script/i);
    expect(out).not.toContain('onerror="');
  });

  it('escapes markup in a path redaction label and in unknown categories', () => {
    const out = html(base({ messages: [{ role: 'assistant', parts: [
      { t: 'redacted', cat: 'path', text: MARKUP }, { t: 'redacted', cat: '"><script>x</script>', text: MARKUP },
    ] }] }));
    expect(out).not.toMatch(/<img|<script/i);
    expect(out).not.toContain('data-cat="&quot;&gt;');
  });

  it('ignores unknown keys, prototype keys and an unknown author', () => {
    const raw = JSON.parse(`{"v":1,"title":"T","toolCount":1,"__proto__":{"polluted":1},"constructor":{"x":1},
      "messages":[{"role":"user","author":"root","extra":"x","__proto__":{"admin":true},"parts":[{"t":"text","text":"a","html":"<b>"}]}]}`);
    const out = html(raw);
    expect(out).toContain('a');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out).not.toContain('<b>');
  });

  it('rejects structurally wrong payloads instead of rendering them', () => {
    for (const bad of [null, [], 'x', 1, { v: 2, title: 'T', messages: [] }, { v: 1, title: 5, messages: [] },
      { v: 1, title: 'T', messages: {} }, base({ messages: [{ role: 'user', parts: [{ t: 'html', text: 'x' }] }] }),
      base({ messages: [{ role: 'user', parts: 'x' }] }), base({ messages: [null] })]) {
      expect(parseTranscript(bad)).toBeNull();
    }
  });

  it('renders ten thousand messages without throwing', () => {
    const messages = Array.from({ length: 10_000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', parts: [{ t: 'text', text: `m${i}` }] }));
    expect(html(base({ messages })).match(/<article/g)).toHaveLength(10_000);
  });
});
