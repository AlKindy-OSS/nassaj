/**
 * B-1674 — prose fences resolve bidi per line; code fences stay strict LTR.
 *
 * jsdom has no bidi layout, so this pins the contract the browser measurement
 * (scripts/bidi-measure/measure-prose-fence.mjs) proves on real layout:
 * which languages count as prose, how the body splits into line blocks, which
 * renderer the chat Markdown picks, and that the CSS targets prose lines only.
 *
 * Run: NODE_ENV=test npx vitest run src/syntax/proseFence.test.tsx
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../components/chat/view/subcomponents/Markdown';

import { MAX_HIGHLIGHT_CHARS } from './highlightBudget';
import { ProseFenceBlock } from './ProseFenceBlock';
import { isProseFenceLanguage, proseFenceLines } from './proseFence';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
  }),
}));

vi.mock('../components/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

afterEach(cleanup);

describe('isProseFenceLanguage', () => {
  it.each([undefined, null, '', 'text', 'plaintext', 'markdown', 'md', 'Markdown', 'TEXT'])(
    'treats %p as prose',
    (language) => expect(isProseFenceLanguage(language)).toBe(true),
  );

  it.each(['js', 'javascript', 'ts', 'python', 'py', 'bash', 'sh', 'diff', 'json', 'yaml', 'sql'])(
    'treats %p as code',
    (language) => expect(isProseFenceLanguage(language)).toBe(false),
  );
});

describe('proseFenceLines', () => {
  it('drops one trailing newline, keeps inner empty lines and normalises CRLF', () => {
    expect(proseFenceLines('أ\r\n\nb\n')).toEqual(['أ', '', 'b']);
  });
});

describe('ProseFenceBlock', () => {
  it('renders one line block per source line inside a marked <pre>', () => {
    const { container } = render(<ProseFenceBlock>{'استخدم npm install ثم شغّل\nsecond\n'}</ProseFenceBlock>);
    const pre = container.querySelector('pre[data-prose-fence="true"]')!;
    const lines = [...pre.querySelectorAll('code > span.nassaj-prose-line')];
    expect(lines.map((l) => l.textContent)).toEqual(['استخدم npm install ثم شغّل\n', 'second']);
    expect(lines.every((l) => !l.hasAttribute('dir'))).toBe(true);
  });

  it.each([
    'a\n\nb\n\n\nend\n',
    'أ\r\n\r\nb',
    '\n\nفقرة\n',
    'single',
  ])('code text equals the source with blank lines kept (%j)', (source) => {
    const { container } = render(<ProseFenceBlock>{source}</ProseFenceBlock>);
    const expected = source.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    expect(container.querySelector('pre code')!.textContent).toBe(expected);
  });
});

describe('chat Markdown picks the renderer by fence language', () => {
  const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\`\n`;

  it.each(['', 'text', 'plaintext', 'markdown', 'md'])('fence "%s" renders as prose', (lang) => {
    const { container } = render(<Markdown>{fence(lang, 'استخدم npm install ثم شغّل')}</Markdown>);
    expect(container.querySelector('pre[data-prose-fence]')).not.toBeNull();
    expect(container.querySelectorAll('.nassaj-prose-line')).toHaveLength(1);
  });

  it('a prose fence over the highlight budget falls back to the plain block', () => {
    const big = 'سطر line\n'.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 9) + 10);
    const { container } = render(<Markdown>{fence('text', big)}</Markdown>);
    expect(container.querySelector('pre[data-plain-code]')).not.toBeNull();
    expect(container.querySelector('pre[data-prose-fence]')).toBeNull();
    expect(container.querySelector('.nassaj-prose-line')).toBeNull();
  });

  it.each(['js', 'python', 'diff', 'bash'])('fence "%s" stays code', (lang) => {
    const { container } = render(<Markdown>{fence(lang, '    // احسب المجموع\n+ نص')}</Markdown>);
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('pre[data-prose-fence]')).toBeNull();
    expect(container.querySelector('.nassaj-prose-line')).toBeNull();
  });
});

describe('CSS contract in src/index.css', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = postcss.parse(readFileSync(resolve(here, '../index.css'), 'utf8'));

  it('plaintext is applied only to prose-fence line blocks', () => {
    const plaintext: string[] = [];
    root.walkDecls('unicode-bidi', (decl) => {
      if (decl.value === 'plaintext') plaintext.push((decl.parent as postcss.Rule).selector.trim());
    });
    expect(plaintext).toEqual(['.nassaj-md pre[data-prose-fence] .nassaj-prose-line']);
  });

  it('every pre/code isolate rule is kept (code fences stay LTR boxes)', () => {
    const isolated = new Set<string>();
    root.walkRules((rule) => rule.walkDecls('unicode-bidi', (decl) => {
      if (decl.value === 'isolate') rule.selectors.forEach((s) => isolated.add(s.trim()));
    }));
    for (const s of [':root[dir="rtl"] [dir="ltr"]', ':root[dir="rtl"] pre', ':root[dir="rtl"] code', '.nassaj-md pre', '.nassaj-md code']) {
      expect(isolated.has(s), s).toBe(true);
    }
  });
});
