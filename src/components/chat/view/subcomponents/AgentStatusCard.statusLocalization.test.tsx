/**
 * B-1695 — the agents-bar header localizes the provider's raw English status word
 * ("Processing") instead of rendering it verbatim in the Arabic UI.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import arChat from '../../../../i18n/locales/ar/chat.json';
import enChat from '../../../../i18n/locales/en/chat.json';

const locale = vi.hoisted(() => ({ value: 'en' }));

function lookup(tree: unknown, key: string): string | undefined {
  const found = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof found === 'string' ? found : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      lookup(locale.value === 'ar' ? arChat : enChat, key) ?? opts?.defaultValue ?? key,
    i18n: { get language() { return locale.value; } },
  }),
}));

import type { RunAgent } from '../../hooks/useRunProgress';

import AgentStatusCard from './AgentStatusCard';

afterEach(() => {
  locale.value = 'en';
  cleanup();
  localStorage.clear();
});

const runningAgent: RunAgent = {
  id: 'toolu_1',
  type: 'frontend-dev',
  description: 'إصلاح البطاقة',
  status: 'running',
  callCount: 0,
  startedAt: Date.now(),
} as RunAgent;

function headerText(text: string, lang: 'ar' | 'en'): string {
  locale.value = lang;
  const live = render(
    <AgentStatusCard
      agents={[runningAgent]}
      status={{ text, can_interrupt: false }}
      isLoading
      provider="claude"
      runStartedAt={null}
      progress={null}
    />,
  );
  return live.container.textContent ?? '';
}

describe('ترجمة حالة التشغيل في رأس شريط الوكلاء', () => {
  it('يعرض «يعالج» بالعربية بدل Processing', () => {
    const text = headerText('Processing', 'ar');
    expect(text).toContain('يعالج');
    expect(text).not.toContain('Processing');
  });

  it.each(['Working...', 'Working…'])('يحذف علامة الحذف ويترجم %s', (raw) => {
    const text = headerText(raw, 'ar');
    expect(text).toContain('يعمل');
    expect(text).not.toMatch(/Working|…/);
  });

  it('يبقى الإنجليزي كما هو', () => {
    expect(headerText('Processing', 'en')).toContain('Processing');
  });

  it('النص المجهول يمرّ بلا تغيير', () => {
    expect(headerText('Compacting context', 'ar')).toContain('Compacting context');
  });
});
