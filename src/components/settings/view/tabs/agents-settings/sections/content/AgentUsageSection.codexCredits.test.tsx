import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const quota = vi.hoisted(() => ({
  current: {
    status: 'success',
    data: {
      provider: 'codex',
      plan: null,
      windows: [],
      extraUsageCredits: { balance: 42, unlimited: false },
    },
    windows: [],
    plan: null,
    refetch: () => {},
    isAnthropic: false,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'agentUsage.codexExtraCredits') return 'Extra Codex credits';
      if (key === 'agentUsage.unlimited') return 'Unlimited';
      if (key === 'agentUsage.creditUnits') return `${options?.formattedCount} credit units`;
      if (key === 'agentUsage.noData') return 'No usage data';
      return key;
    },
  }),
}));

vi.mock('../../../../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../../../../quick-settings-panel/hooks/useClaudeUsageShared', () => ({
  useClaudeUsageShared: () => ({ status: 'idle' }),
}));

vi.mock('../../../../../../quick-settings-panel/hooks/useProviderQuota', () => ({
  useProviderQuota: () => quota.current,
}));

import AgentUsageSection, { hasDisplayableCodexCredits } from './AgentUsageSection';

afterEach(cleanup);

describe('رصيد Codex الإضافي', () => {
  it('يعرض الرصيد بوحدات كريديت، بلا عملة مفترضة', () => {
    quota.current = {
      ...quota.current,
      data: { ...quota.current.data, extraUsageCredits: { balance: 42, unlimited: false } },
    };

    render(<AgentUsageSection agent="codex" />);

    expect(screen.getByText('Extra Codex credits')).toBeTruthy();
    expect(screen.getByText('42 credit units')).toBeTruthy();
  });

  it('يعرض غير محدود بدلاً من رقم الرصيد عندما يعلنه المزوّد', () => {
    quota.current = {
      ...quota.current,
      data: { ...quota.current.data, extraUsageCredits: { balance: 42, unlimited: true } },
    };

    render(<AgentUsageSection agent="codex" />);

    expect(screen.getByText('Unlimited')).toBeTruthy();
    expect(screen.queryByText('42 credit units')).toBeNull();
  });

  it('يقبل الصفر الحقيقي ويرفض الرصيد السالب أو غير الصالح', () => {
    expect(hasDisplayableCodexCredits({ balance: 0, unlimited: false })).toBe(true);
    expect(hasDisplayableCodexCredits({ balance: -1, unlimited: false })).toBe(false);
    expect(hasDisplayableCodexCredits(undefined)).toBe(false);
  });
});
