/**
 * اختبارات T-900 — GovernanceBadge (بعد قلب المنطق)
 *
 * يغطّي:
 *   - null ⇒ لا عرض (fail-HIDDEN)
 *   - governed+enforced ⇒ لا عرض (الحوكمة افتراض لا مزية)
 *   - governed+unenforced ⇒ لا عرض
 *   - ungoverned ⇒ تحذير ناعم: أيقونة + نص + tooltip
 *   - aria-label يضمّ النص والـtooltip معاً عند ungoverned
 *
 * الـhook مُحاكى (مُغلَّف) — سلوكه مختبَر بشكل مستقل
 * في useProviderGovernance.test.ts.
 *
 * Run: npm run test:client -- src/shared/view/GovernanceBadge.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// i18n stub — يُرجع المفتاح كاملاً لتسهيل التحقق.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Hook مُحاكى — لا نريد اختبار fetch هنا.
vi.mock('../../components/chat/hooks/useProviderGovernance', () => ({
  useProviderGovernance: vi.fn(),
}));

import { useProviderGovernance } from '../../components/chat/hooks/useProviderGovernance';
import type { GovernanceDescriptor } from '../../components/chat/hooks/useProviderGovernance';
import GovernanceBadge from './GovernanceBadge';

const mockHook = vi.mocked(useProviderGovernance);

afterEach(() => {
  cleanup();
  mockHook.mockReset();
});

// ---------------------------------------------------------------------------

describe('GovernanceBadge', () => {
  it('renders nothing when descriptor is null (unknown / absent endpoint)', () => {
    mockHook.mockReturnValue(null);
    const { container } = render(<GovernanceBadge provider="claude" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing for governed+enforced (governance is the expected default)', () => {
    const desc: GovernanceDescriptor = {
      provider: 'codex',
      status: 'governed',
      enforced: true,
      mechanism: 'codex-fingerprint',
    };
    mockHook.mockReturnValue(desc);
    const { container } = render(<GovernanceBadge provider="codex" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing for governed+unenforced (governance is the expected default)', () => {
    const desc: GovernanceDescriptor = {
      provider: 'claude',
      status: 'governed',
      enforced: false,
      mechanism: 'claude-md',
    };
    mockHook.mockReturnValue(desc);
    const { container } = render(<GovernanceBadge provider="claude" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders soft warning for ungoverned with correct label and tooltip', () => {
    const desc: GovernanceDescriptor = {
      provider: 'hermes',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="hermes" />);

    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.textContent).toContain('governanceBadge.ungoverned');
    expect(badge.getAttribute('title')).toBe('governanceBadge.tooltip.none');
  });

  it('aria-label contains both label and tooltip text for ungoverned', () => {
    const desc: GovernanceDescriptor = {
      provider: 'hermes',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="hermes" />);

    const badge = screen.getByRole('status');
    const ariaLabel = badge.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('governanceBadge.ungoverned');
    expect(ariaLabel).toContain('governanceBadge.tooltip.none');
  });

  it('renders nothing for undefined provider (no fetch)', () => {
    mockHook.mockReturnValue(null);
    const { container } = render(<GovernanceBadge provider={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  // --- ADR-062 GL-7 / KM-4: the two new-relevant verdicts render HONESTLY ---

  it('opencode governed+enforced:true (GL-7 carrier) renders nothing (governance is the default)', () => {
    const desc: GovernanceDescriptor = {
      provider: 'opencode',
      status: 'governed',
      enforced: true,
      mechanism: 'opencode-agents',
    };
    mockHook.mockReturnValue(desc);
    const { container } = render(<GovernanceBadge provider="opencode" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('kimi ungoverned/none (honest soft governance — KM-4) shows the quiet warning, like gemini', () => {
    const desc: GovernanceDescriptor = {
      provider: 'kimi',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
    };
    mockHook.mockReturnValue(desc);
    render(<GovernanceBadge provider="kimi" />);

    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('governanceBadge.ungoverned');
    expect(badge.getAttribute('title')).toBe('governanceBadge.tooltip.none');
  });
});
