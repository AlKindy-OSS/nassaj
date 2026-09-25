/**
 * permissionModes.test.tsx — منتقي وضع الأذونات، مقروءاً كما يراه المستخدم.
 *
 * **لماذا وُجد.** الجولة الأولى من T-1172 شحنت أوضاع Codex في مصفوفة
 * وضعت الأسماء في رؤوس الأعمدة وتركت الخلايا صامتة، فخرجت على الشاشة اثني عشر
 * مربّعاً فارغاً — والاسم كان في `aria-label` وحده، أي أن قارئ الشاشة كان يعرف
 * ما لا تعرفه العين. لم يسقط اختبارٌ واحد وقتها، لأن كل ما كان مُختبَراً هو أن
 * الخلية موجودة وقابلة للنقر.
 *
 * فهذه الاختبارات تؤكّد ما **يُقرأ**: أن كل خيار يحمل نصّه داخله، وأن الخيار
 * الذي يرفع الحاجز الأمني وحده هو المصبوغ بـ`bg-destructive`، وأن وصف الوضع
 * المحدَّد ظاهرٌ في الصفحة لا مدفوناً في `title`.
 *
 * ‏`t` يُحلّ على ملفات `en` الحقيقية (‏`settings` ثم `chat`، وهو ترتيب
 * `useTranslation(['settings','chat'])` نفسه): مفتاحٌ ناقص يسقط هنا بدل أن يظهر
 * إنجليزياً في كل اللغات.
 *
 * RUNNER: vitest (`NODE_ENV=test npx vitest run src/components/settings`).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import enChat from '../../../../../i18n/locales/en/chat.json';
import enSettings from '../../../../../i18n/locales/en/settings.json';

function lookup(key: string): string | undefined {
  for (const root of [enSettings, enChat]) {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      root,
    );
    if (typeof value === 'string') return value;
  }
  return undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      lookup(key) ?? (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

import PermissionsContent from './sections/content/PermissionsContent';

afterEach(cleanup);

describe('no option is known by its position', () => {
  it("Codex's three modes each carry their own visible label, in escalating order", () => {
    render(
      <PermissionsContent agent="codex" permissionMode="default" onPermissionModeChange={() => {}} />,
    );

    const options = screen.getAllByRole('radio');
    // الترتيب هو التصعيد الأمني: الموثوقة ← مساحة العمل ← تجاوز.
    expect(options.map((option) => option.textContent)).toEqual(['Trusted', 'Workspace', 'Bypass']);
    expect(options.every((option) => (option.textContent ?? '').trim().length > 0)).toBe(true);
    expect(options[0].getAttribute('aria-checked')).toBe('true');
    // وصف الوضع المحدَّد مكتوبٌ في الصفحة، لا في `title` يحتاج فأرة.
    expect(screen.getByText(lookup('permissions.codex.modes.default.description')!)).toBeTruthy();
  });

  it('the Claude panel keeps its two switches and its pattern list', () => {
    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={() => {}}
        allowedTools={['Read']}
        onAllowedToolsChange={() => {}}
        disallowedTools={[]}
        onDisallowedToolsChange={() => {}}
        allowVendorDelegation={false}
        onAllowVendorDelegationChange={() => {}}
      />,
    );

    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.getAllByText('Read').length).toBeGreaterThan(0);
  });

  it('the Antigravity panel states both of its facts as readable rows', () => {
    render(<PermissionsContent agent="antigravity" />);

    expect(screen.getByText(lookup('permissions.antigravity.skipPermissions.label')!)).toBeTruthy();
    expect(screen.getByText(lookup('permissions.antigravity.cliNote.title')!)).toBeTruthy();
  });
});
