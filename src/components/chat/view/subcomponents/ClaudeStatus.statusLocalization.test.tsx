import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

const translations: Record<string, string> = {
  'claudeStatus.actions.thinking': 'T:thinking',
  'claudeStatus.actions.processing': 'T:processing',
  'claudeStatus.actions.analyzing': 'T:analyzing',
  'claudeStatus.actions.working': 'T:working',
  'claudeStatus.actions.computing': 'T:computing',
  'claudeStatus.actions.reasoning': 'T:reasoning',
  'claudeStatus.actions.waitingPermission': 'T:permission',
  'claudeStatus.frozen': 'T:frozen',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      translations[key] ?? options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

import ClaudeStatus from './ClaudeStatus';

afterEach(cleanup);

function statusLabel(text: string, frozen = false): string {
  const { container } = render(
    <ClaudeStatus
      status={{ text, can_interrupt: false }}
      isLoading
      frozen={frozen}
      provider="claude"
    />,
  );

  return container.querySelector('p')?.textContent?.trim() ?? '';
}

describe('ترجمة نص حالة المزوّد', () => {
  it.each([
    ['Thinking', 'T:thinking'],
    ['Processing', 'T:processing'],
    ['Analyzing', 'T:analyzing'],
    ['Working', 'T:working'],
    ['Computing', 'T:computing'],
    ['Reasoning', 'T:reasoning'],
  ])('يترجم كلمة الحالة %s', (rawStatus, expected) => {
    assert.equal(statusLabel(rawStatus), expected);
  });

  it('يترجم انتظار الإذن مع اختلاف حالة الأحرف', () => {
    assert.equal(statusLabel('WAITING FOR PERMISSION'), 'T:permission');
  });

  it.each(['Working...', 'Working…'])('يتجاهل علامة الحذف في %s', (rawStatus) => {
    assert.equal(statusLabel(rawStatus), 'T:working');
  });

  it('يمرّر الحالة غير المعروفة كما هي', () => {
    assert.equal(statusLabel('Indexing repository'), 'Indexing repository');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'لا يعامل خاصية الكائن الموروثة %s كمفتاح ترجمة',
    (rawStatus) => {
      assert.equal(statusLabel(rawStatus), rawStatus);
    },
  );

  it('يعرض الحالة المجمدة بدلاً من حالة المزوّد', () => {
    assert.equal(statusLabel('Working', true), 'T:frozen');
  });
});
