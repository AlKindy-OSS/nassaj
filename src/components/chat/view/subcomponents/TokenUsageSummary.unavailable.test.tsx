import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mirrors i18next: a key with no translation falls back to `defaultValue`.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'contextRot.empty') return 'No token usage yet';
      if (key === 'contextRot.percentUsed') return `${options?.percent} of real window`;
      if (key === 'contextRot.staleEstimate') return 'estimate';
      return (options?.defaultValue as string) ?? key;
    },
    i18n: { language: 'en' },
  }),
}));

import { newestContextUsage } from '../../hooks/contextUsagePresentation';
import { nativeSnapshot } from '../../hooks/contextUsagePresentation.fixtures';

import TokenUsageSummary from './TokenUsageSummary';

afterEach(cleanup);

/**
 * B-823: a failed usage lookup and a brand-new session both arrive without a
 * context window, but they mean opposite things. Rendering the failure as "No
 * token usage yet" is what hid a server-side 404 for weeks.
 */
describe('Context usage — failed lookup vs. genuine zero', () => {
  it('says usage is unavailable when the lookup failed', () => {
    render(<TokenUsageSummary usage={{ unavailable: true, reason: 'transcript_unavailable', status: 404 }} />);

    const trigger = screen.getByRole('button', { name: 'Context usage unavailable' });
    expect(trigger.textContent).toContain('?');
    expect(trigger.textContent).not.toContain('—');
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('text-warning');
  });

  it('still says "no token usage yet" for a session that has simply not run', () => {
    render(<TokenUsageSummary usage={null} />);

    const trigger = screen.getByRole('button', { name: 'No token usage yet' });
    expect(trigger.textContent).toContain('—');
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('text-success');
  });
});

describe('Claude turn in progress (B-1803)', () => {
  const resultReading = { contextSnapshot: nativeSnapshot({ provider: 'claude', modelId: 'opus[1m]', windowTokens: 1_000_000, usedTokens: 200_000 }) };
  const assistantEvent = (usedTokens: number) => ({ used: null, total: null, contextSnapshot: nativeSnapshot({
    provider: 'claude', modelId: 'claude-opus-5-5', usageKind: 'last_request_input', usedTokens, windowTokens: null,
    source: 'claude.message.usage', observedAt: '2026-09-13T12:00:01Z', nativeCompactTokens: null, proposedCompactTokens: null }) });
  const renderClaude = (usage: Record<string, unknown> | null) =>
    render(<TokenUsageSummary provider="claude" sessionId="s1" modelId="opus[1m]" usage={usage} />);

  it('result then assistant message does not render ?', () => {
    renderClaude(newestContextUsage(resultReading, assistantEvent(180_000)));
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('20');
    const trigger = screen.getByRole('button');
    expect(trigger.textContent).not.toContain('?');
    expect(trigger.getAttribute('aria-label')).toContain('estimate');
  });
  it('a stale estimate shows the larger value', () => {
    renderClaude(newestContextUsage(resultReading, assistantEvent(300_000)));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
  });
  it('a session with no successful reading still renders ?', () => {
    renderClaude(newestContextUsage(null, assistantEvent(300_000)));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Context usage unavailable' }).textContent).toContain('?');
  });
  it('a current native reading carries no estimate label', () => {
    renderClaude(resultReading);
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('estimate');
  });
});
