import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'contextRot.coordinatorTotal') return `coordinator:${options?.value}`;
      if (key === 'contextRot.unavailable') return 'Context usage unavailable';
      if (key === 'contextRot.percentUsed') return String(options?.percent);
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

import { newestContextUsage } from '../../hooks/contextUsagePresentation';
import { nativeSnapshot } from '../../hooks/contextUsagePresentation.fixtures';

import TokenUsageSummary from './TokenUsageSummary';

afterEach(cleanup);

describe('Codex context-window usage', () => {
  it('shows cumulative usage without inventing occupancy or alerting', () => {
    render(<TokenUsageSummary provider="codex" sessionId="s1" modelId="m1" usage={{ contextSnapshot: nativeSnapshot({ usageKind: 'last_request_input', usedTokens: 220_000 }), cumulativeUsed: 20_000_000 }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Context usage unavailable' }));
    expect(screen.getByRole('dialog').textContent).toContain('coordinator:20,000,000');
  });
  it('removes occupancy and alerts when a native compact boundary invalidates the snapshot', () => {
    const live = { contextSnapshot: nativeSnapshot({ provider: 'claude', usedTokens: 160_000 }) };
    const { rerender } = render(<TokenUsageSummary provider="claude" sessionId="s1" modelId="m1" usage={live} />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    const boundary = { used: null, total: null, contextSnapshot: nativeSnapshot({ provider: 'claude', modelId: null, usedTokens: null, windowTokens: null, usageKind: 'unknown', source: 'claude.message.usage', observedAt: '2026-09-13T13:00:00Z', nativeCompactTokens: null, proposedCompactTokens: null, newSessionTokens: null }) };
    const invalidated = newestContextUsage(live, boundary);
    rerender(<TokenUsageSummary provider="claude" sessionId="s1" modelId="m1" usage={invalidated} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Context usage unavailable' }).querySelector('.animate-pulse')).toBeNull();
  });
  it('clears occupancy on model or session changes until a matching reading arrives', () => {
    const usage = { contextSnapshot: nativeSnapshot({ usedTokens: 20_000 }) };
    const { rerender } = render(<TokenUsageSummary provider="codex" sessionId="s1" modelId="m1" usage={usage} />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    rerender(<TokenUsageSummary provider="codex" sessionId="s2" modelId="m1" usage={usage} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    rerender(<TokenUsageSummary provider="codex" sessionId="s1" modelId="m2" usage={usage} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('uses latest context occupancy and keeps the cumulative coordinator total in details', () => {
    render(
      <TokenUsageSummary provider="codex" sessionId="s1" modelId="m1"
        usage={{
          contextSnapshot: nativeSnapshot({ nativeCompactTokens: null, proposedCompactTokens: null }),
          used: 120_000,
          total: 240_000,
          cumulativeUsed: 24_000_000,
          inputTokens: 110_000,
          outputTokens: 10_000,
        }}
      />,
    );

    // الاسم المتاح يحمل النسبة كاملة، وداخل الحلقة الرقم وحده (الحلقة تقول
    // إن الوحدة نسبة، والعلامة «٪» تضيّق على الرقم في 26px).
    const trigger = screen.getByRole('button', { name: '50%' });
    expect(trigger.textContent).toContain('50');
    expect(trigger.textContent).not.toContain('24M');

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog').textContent).toContain('coordinator:24,000,000');
  });
});
