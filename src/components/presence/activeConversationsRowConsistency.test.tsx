/**
 * activeConversationsRowConsistency.test.tsx (B-861)
 *
 * الشكوى: «‏4 active» بجوار ONLINE NOW ولا صفَّ واحد يحمل علامة.
 *
 * العدّاد والمؤشّر يخرجان من نفس اللقطة الخادمية: `activeConversations.total`
 * للعدّ، و`runningSessions` لكل صفّ. هذه الاختبارات تثبّت الأربع الحالات التي
 * ينهار عندها التطابق:
 *
 *   1. جلسة نشطة **موثوقة** → مؤشّر أخضر على صفّها.
 *   2. جلسة نشطة **غير موثوقة** (لقطة مقبس بائتة) → لا مؤشّر، عمداً.
 *   3. جلسة **محسوبة بلا صفّ مرئي** → لا مؤشّر، لكن الواجهة **تشرح** الفارق
 *      بدل أن يبدو العدّاد كاذباً.
 *   4. صفر نشِط → لا مؤشّر ولا سطر شرح.
 *
 * RUNNER: vitest — jsdom.
 */
import arPresence from '../../i18n/locales/ar/presence.json';
import enPresence from '../../i18n/locales/en/presence.json';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key),
    i18n: { language: 'ar' },
  }),
}));

const {
  beginSessionProcessConnectionEpoch,
  getSessionProcessState,
  isSessionProcessStateAuthoritative,
  reconcilePresenceProcessStates,
  resetSessionProcessStates,
  setSessionProcessState,
} = await import('../../stores/sessionProcessStateStore');
const { deriveSessionRowIndicatorState } = await import(
  '../sidebar/view/subcomponents/sessionRowIndicatorState'
);
const { ActiveConversationsMenu } = await import('./ActiveConversationsMenu');

/** Exactly what a sidebar row computes for itself. */
function indicatorFor(sessionId: string) {
  return deriveSessionRowIndicatorState(
    isSessionProcessStateAuthoritative(sessionId) ? getSessionProcessState(sessionId) : null,
    null,
    false,
    false,
  );
}

const ELSEWHERE_HINT = 'In conversations you cannot see, so no row is marked.';

afterEach(cleanup);
beforeEach(() => {
  resetSessionProcessStates();
  beginSessionProcessConnectionEpoch();
});

describe('active count ↔ row indicator', () => {
  it('marks a running conversation the presence snapshot names', () => {
    reconcilePresenceProcessStates([{ sessionId: 's-running', state: 'running' }]);

    expect(isSessionProcessStateAuthoritative('s-running')).toBe(true);
    expect(indicatorFor('s-running')).toBe('running');
  });

  it('paints nothing while the verdict is not authoritative', () => {
    // A tentative hint (seeded, never confirmed by this socket attempt).
    setSessionProcessState('s-tentative', 'running', { authoritative: false });

    expect(getSessionProcessState('s-tentative')).toBe('running');
    expect(isSessionProcessStateAuthoritative('s-tentative')).toBe(false);
    expect(indicatorFor('s-tentative')).toBeNull();
  });

  it('explains a counted conversation that reaches no row', async () => {
    // 4 running, only one of them surfaced to this viewer.
    reconcilePresenceProcessStates([{ sessionId: 's-running', state: 'running' }]);
    expect(indicatorFor('s-running')).toBe('running');
    expect(indicatorFor('s-hidden')).toBeNull();

    render(
      <ActiveConversationsMenu
        activeConversations={{
          total: 4,
          byProject: [{ projectPath: '/workspace/repo', count: 1 }],
          hiddenCount: 3,
        }}
        placement="bottom"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText(ELSEWHERE_HINT)).toBeTruthy();
  });

  it('says nothing extra when nothing is running', () => {
    reconcilePresenceProcessStates([]);
    expect(indicatorFor('s-running')).toBeNull();

    render(
      <ActiveConversationsMenu
        activeConversations={{ total: 0, byProject: [], hiddenCount: 0 }}
        placement="bottom"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText(ELSEWHERE_HINT)).toBeNull();
  });
});

describe('the explanation is translated, not hard-coded English', () => {
  // The bundles are imported, not read off disk: this suite runs in jsdom,
  // where `node:fs` is externalised and the whole file fails to load.
  it.each([
    ['ar', arPresence as Record<string, string>],
    ['en', enPresence as Record<string, string>],
  ])('%s carries activeConversationsElsewhereHint', (_language, bundle) => {
    expect(typeof bundle.activeConversationsElsewhereHint).toBe('string');
    expect(bundle.activeConversationsElsewhereHint.length).toBeGreaterThan(0);
  });
});

describe('active conversations popover positioning', () => {
  const activeConversations = {
    total: 1,
    byProject: [{ projectPath: '/workspace/repo', count: 1 }],
    hiddenCount: 0,
  };

  async function openAt(placement: 'bottom' | 'inline-end', dir: 'ltr' | 'rtl') {
    document.documentElement.dir = dir;
    const { container } = render(<ActiveConversationsMenu activeConversations={activeConversations} placement={placement} />);
    const trigger = container.querySelector('button')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 900, y: 100, width: 40, height: 20, top: 100, right: 940, bottom: 120, left: 900,
      toJSON: () => ({}),
    });
    fireEvent.click(trigger);
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    return screen.getByRole('group');
  }

  afterEach(() => { document.documentElement.dir = ''; vi.restoreAllMocks(); });

  it('aligns a bottom popover to the trigger inline-start in LTR and RTL', async () => {
    expect((await openAt('bottom', 'ltr')).style.left).toBe('728px');
    cleanup();
    expect((await openAt('bottom', 'rtl')).style.left).toBe('652px');
  });

  it('opens an inline-end popover on the logical end side in RTL', async () => {
    expect((await openAt('inline-end', 'rtl')).style.left).toBe('604px');
  });
});
