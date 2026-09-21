import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
}));

import { nativeSnapshot } from '../../hooks/contextUsagePresentation.fixtures';

import TokenUsageSummary, { operatorAlertsFor } from './TokenUsageSummary';

afterEach(cleanup);

const usage = (used: number) => ({ contextSnapshot: nativeSnapshot({ provider: 'claude', usedTokens: used, windowTokens: 1_000_000 }) });
const trigger = () => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded')) as HTMLElement;

describe('operator alerts — carrier thresholds and age', () => {

  it('never applies Claude absolute thresholds to another carrier', () => {
    expect(operatorAlertsFor(200_000, null, 'codex')).toEqual([]);
    expect(operatorAlertsFor(120_000, null, 'codex', 120_000)).toEqual(['pressure']);
    expect(operatorAlertsFor(119_999, null, 'codex', 120_000)).toEqual([]);
    expect(operatorAlertsFor(null, null, 'claude')).toEqual([]);
    expect(operatorAlertsFor(NaN, null, 'claude')).toEqual([]);
  });
  it('classifies 150K as compact, 250K as close, and one hour as hour', () => {
    expect(operatorAlertsFor(149_999, 0, 'claude')).toEqual([]);
    expect(operatorAlertsFor(150_000, 0, 'claude')).toEqual(['compact']);
    expect(operatorAlertsFor(200_000, 0, 'claude')).toEqual(['compact']);
    expect(operatorAlertsFor(249_999, 0, 'claude')).toEqual(['compact']);
    expect(operatorAlertsFor(250_000, 0, 'claude')).toEqual(['close']);
    expect(operatorAlertsFor(10, 60 * 60 * 1000, 'claude')).toEqual(['hour']);
    expect(operatorAlertsFor(250_000, 2 * 60 * 60 * 1000, 'claude')).toEqual(['close', 'hour']);
    expect(operatorAlertsFor(10, null, 'claude')).toEqual([]);
  });

  it('blinks the ring and opens the card once at 150K even though the window is far from full', () => {
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(150_000)} sessionId="s1" />);
    const t = trigger();
    expect(t.getAttribute('aria-label')).toContain('Over 150K tokens');
    expect(t.querySelector('.animate-pulse')).not.toBeNull();
    expect(t.querySelector('svg')?.getAttribute('class')).toContain('text-danger');
    expect(screen.getByRole('dialog').textContent).toContain('/compact');
  });

  it('escalates to close at 250K', () => {
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(250_000)} sessionId="s1" />);
    expect(trigger().getAttribute('aria-label')).toContain('At 250K tokens');
    expect(screen.getByRole('dialog').textContent).toContain('new conversation');
  });

  it('flags a session older than one hour even before any tokens are counted', () => {
    const startedAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={null} sessionId="s1" sessionStartedAt={startedAt} />);
    expect(trigger().getAttribute('aria-label')).toContain('over an hour old');
    expect(trigger().querySelector('.animate-pulse')).not.toBeNull();
  });

  it('renders nothing for counter-less providers until an alert applies, then shows the hour alert', () => {
    const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { unmount } = render(<TokenUsageSummary provider="claude" modelId="m1" usage={null} sessionId="s1" sessionStartedAt={fresh} onlyWhenAlerting />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    const old = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={null} sessionId="s1" sessionStartedAt={old} onlyWhenAlerting />);
    expect(trigger().getAttribute('aria-label')).toContain('over an hour old');
  });

  it('stays quiet below the thresholds', () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(120_000)} sessionId="s1" sessionStartedAt={startedAt} />);
    expect(trigger().querySelector('.animate-pulse')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
