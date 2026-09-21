/**
 * governanceToneNeutrality.test.tsx — **«لا قناة أصلاً» لا تُصبغ إنذاراً، في أي
 * سطح** (‏B-415).
 *
 * الشارة كانت تتفرّع على `status` وحده، والخادم يُجيب لـ`cursor`/`hermes` وأخواتِها
 * `{status:'ungoverned', mechanism:'none'}` — أي «لا قناة تعليمات لهذا المحرّك
 * أصلاً» — فخرج مثلثٌ كهرماني يَعِد بإصلاحٍ لا وجود له. وتبويب «التعليمات»،
 * المبنيّ على **الواصف نفسه**، يحرّم ذلك بالنصّ: «غيابُ القناة ليس عطلاً ولا
 * خطراً… فصبغُه إنذاراً يعِد بإصلاحٍ لا وجود له». سطحان من مصدرٍ واحد يقولان
 * نقيضين.
 *
 * فالحارس **مشتركٌ بين السطحين** عمداً: يفحص القاعدة لا موضعَها، فلا يُصلَح أحدهما
 * ويُترك الآخر — وهو نمط السقوط المرصود في هذا الملف مرّتين.
 *
 * RUNNER: vitest (jsdom). ‏`NODE_ENV=test` إلزامي في هذا الريبو.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
}));

let payload: Record<string, unknown> = {};

vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data: payload }),
  })),
}));

import GovernanceBadge from '../../../../../shared/view/GovernanceBadge';
import type { GovernanceMechanism } from '../../../../chat/hooks/useProviderGovernance';

import InstructionSourcesContent from './sections/content/InstructionSourcesContent';

/** الصفات التي تحمل النبرة التحذيرية/الخطرة في هذا النظام (رموز لا ألوان خام). */
const ALARM_CLASS = /\b(text|bg|border)-(warning|danger|destructive)\b|amber/;

const noMechanismChannel = {
  id: 'none',
  scope: 'user',
  path: null,
  link: null,
  mechanism: 'none',
  verification: 'none',
  enforcement: 'none',
  status: 'ungoverned',
  reason: 'no_mechanism',
  linkable: false,
  linkScope: null,
  linkRefusal: 'no_mechanism',
};

beforeEach(() => {
  payload = {};
});

afterEach(cleanup);

describe('نبرة الحوكمة: `mechanism:none` حالةٌ محايدة (B-415)', () => {
  it('الشارة تختفي حين لا قناة — وهو جواب الخادم لـcursor/hermes حرفياً', async () => {
    payload = {
      provider: 'hermes',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
      sources: [noMechanismChannel],
    };
    const { container } = render(<GovernanceBadge provider="hermes" />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('وتبقى حين توجد قناةٌ حاجزُها مرفوع — الحارس ليس إخفاءً شاملاً', async () => {
    // بلا هذه الحالة يمرّ «احذف الشارة» بوصفه إصلاحاً، وهي الحالة الوحيدة التي
    // وُجدت الشارة لأجلها: قناةٌ قائمة ولم تُفرَض.
    payload = { provider: 'claude', status: 'ungoverned', enforced: false, mechanism: 'claude-md' };
    const { container } = render(<GovernanceBadge provider="claude" />);
    await waitFor(() => expect(container.innerHTML).not.toBe(''));
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });

  it('لا سطحَ يُنذر على غياب القناة — الشارة ولوح التعليمات معاً', async () => {
    payload = {
      provider: 'hermes',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
      sources: [noMechanismChannel],
    };

    const badge = render(<GovernanceBadge provider="hermes" />);
    await waitFor(() => expect(badge.container.innerHTML).toBe(''));

    const panel = render(<InstructionSourcesContent agent="hermes" standalone />);
    await waitFor(() =>
      expect((panel.container.textContent ?? '').trim().length).toBeGreaterThan(0),
    );
    expect(
      ALARM_CLASS.test(panel.container.innerHTML),
      'لوح التعليمات يصبغ «لا قناة» بنبرة إنذار',
    ).toBe(false);
  });

  it('الشارة تظهر ⟺ للواصف آليةٌ قائمة — مسحاً على الاتحاد كلّه', async () => {
    const mechanisms: GovernanceMechanism[] = [
      'codex-fingerprint', 'claude-md', 'opencode-agents', 'kimi-agents',
      'gemini-md', 'nassaj-project-md', 'none',
    ];
    for (const mechanism of mechanisms) {
      payload = { provider: 'claude', status: 'ungoverned', enforced: false, mechanism };
      const { container, unmount } = render(<GovernanceBadge provider="claude" />);
      await waitFor(() =>
        expect(
          container.innerHTML !== '',
          `الآلية «${mechanism}»: ظهور الشارة لا يطابق وجود القناة`,
        ).toBe(mechanism !== 'none'),
      );
      unmount();
    }
  });
});
