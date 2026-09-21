/**
 * prismRegistry.test.tsx — ما يراه المستخدم فعلاً عند كل مستوى.
 *
 * التسجيل في `refractor` عالميّ وتراكمي، فترتيب هذه الاختبارات مقصود: كل ما
 * يفحص «قبل الترقية» يسبق `ensureScope`. عزل vitest لكل ملف يمنع تسرّب هذا
 * التلوّث إلى بقيّة المجموعة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { codeHighlightTheme } from './codeHighlightTheme';
import { CodeHighlighter, ensureScope, getLoadedScope, getRegistryVersion } from './prismRegistry';

afterEach(cleanup);

function renderCode(language: string, code: string) {
  const { container } = render(
    <CodeHighlighter language={language} style={codeHighlightTheme}>
      {code}
    </CodeHighlighter>,
  );
  return {
    container,
    tokens: container.querySelectorAll('.token').length,
    text: container.textContent ?? '',
  };
}

const GO_SOURCE = 'package main\n\nfunc main() {}\n';
const HASKELL_SOURCE = 'main :: IO ()\nmain = putStrLn "hi"\n';

describe('core scope (statically bundled)', () => {
  it('highlights a core language', () => {
    const { tokens, text } = renderCode('bash', 'echo "hello" && exit 0\n');
    expect(tokens).toBeGreaterThan(0);
    expect(text).toContain('echo');
  });

  it('resolves an alias Prism does not ship (```sh```)', () => {
    // `shell` بديل أصيل لـbash، أما `sh` و`zsh` فيضيفهما جدولنا. بدونهما كانت
    // أشيع أسوار الصدفة في محادثاتنا تسقط إلى نصّ بلا تلوين.
    expect(renderCode('sh', 'ls -la /tmp\n').tokens).toBeGreaterThan(0);
    expect(renderCode('zsh', 'export PATH=/usr/bin\n').tokens).toBeGreaterThan(0);
  });

  it('renders an unregistered language as intact, selectable plain text', () => {
    // haskell ليست في المستويين الأول ولا الثاني — فتبقى نصّاً في الحالتين.
    const { tokens, text, container } = renderCode('haskell', HASKELL_SOURCE);
    expect(tokens).toBe(0);
    // لا خطأ ولا كتلة فارغة: المحتوى كامل حرفاً بحرف داخل <pre><code>.
    expect(text).toBe(HASKELL_SOURCE);
    expect(container.querySelector('pre code')).not.toBeNull();
  });

  it('leaves a tier-2 language as plain text before any upgrade', () => {
    const { tokens, text } = renderCode('go', GO_SOURCE);
    expect(tokens).toBe(0);
    expect(text).toBe(GO_SOURCE);
    expect(getLoadedScope()).toBe('core');
  });
});

describe('upgrading to the extended scope', () => {
  it('colours tier-2 languages and bumps the registry version', async () => {
    const before = getRegistryVersion();

    await ensureScope('extended');

    expect(getLoadedScope()).toBe('extended');
    expect(getRegistryVersion()).toBeGreaterThan(before);
    expect(renderCode('go', GO_SOURCE).tokens).toBeGreaterThan(0);
    expect(renderCode('sql', 'SELECT 1 FROM t;\n').tokens).toBeGreaterThan(0);
  });

  it('keeps core languages working after the upgrade', () => {
    expect(renderCode('bash', 'echo hi\n').tokens).toBeGreaterThan(0);
  });

  it('still degrades gracefully for languages beyond the scope', () => {
    const { tokens, text } = renderCode('haskell', HASKELL_SOURCE);
    expect(tokens).toBe(0);
    expect(text).toBe(HASKELL_SOURCE);
  });

  it('is idempotent — a second request neither refetches nor re-renders', async () => {
    const version = getRegistryVersion();
    await ensureScope('extended');
    await ensureScope('core');
    expect(getRegistryVersion()).toBe(version);
  });
});

describe('upgrading to the full scope', () => {
  it('registers the long tail without disturbing what already worked', async () => {
    await ensureScope('full');

    expect(getLoadedScope()).toBe('full');
    expect(renderCode('haskell', HASKELL_SOURCE).tokens).toBeGreaterThan(0);
    expect(renderCode('bash', 'echo hi\n').tokens).toBeGreaterThan(0);
    expect(renderCode('go', GO_SOURCE).tokens).toBeGreaterThan(0);
  });
});
