import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      ((options?.defaultValue as string) ?? key).replace('{{value}}', String(options?.value ?? '')),
    i18n: { language: 'en' },
  }),
}));

import { claudeAlertThresholds } from '../../hooks/contextUsagePresentation';
import { nativeSnapshot } from '../../hooks/contextUsagePresentation.fixtures';

import TokenUsageSummary, { operatorAlertsFor } from './TokenUsageSummary';

afterEach(cleanup);

const usage = (used: number, windowTokens = 1_000_000) => ({
  contextSnapshot: nativeSnapshot({ provider: 'claude', usedTokens: used, windowTokens }),
});
const trigger = () => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded')) as HTMLElement;

describe('operator alerts — carrier thresholds and age', () => {

  it('never applies Claude absolute thresholds to another carrier', () => {
    expect(operatorAlertsFor(200_000, null, 'codex')).toEqual([]);
    expect(operatorAlertsFor(120_000, null, 'codex', 120_000)).toEqual(['pressure']);
    expect(operatorAlertsFor(119_999, null, 'codex', 120_000)).toEqual([]);
    expect(operatorAlertsFor(null, null, 'claude')).toEqual([]);
    expect(operatorAlertsFor(NaN, null, 'claude')).toEqual([]);
  });
  it('uses the fixed 400K/600K counts when the window is unknown', () => {
    expect(operatorAlertsFor(399_999, 0, 'claude')).toEqual([]);
    expect(operatorAlertsFor(400_000, 0, 'claude')).toEqual(['compact']);
    expect(operatorAlertsFor(599_999, 0, 'claude')).toEqual(['compact']);
    expect(operatorAlertsFor(600_000, 0, 'claude')).toEqual(['close']);
    expect(operatorAlertsFor(10, 60 * 60 * 1000, 'claude')).toEqual(['hour']);
    expect(operatorAlertsFor(600_000, 2 * 60 * 60 * 1000, 'claude')).toEqual(['close', 'hour']);
    expect(operatorAlertsFor(10, null, 'claude')).toEqual([]);
  });
  it('keeps the fixed counts on a 1M window', () => {
    expect(operatorAlertsFor(399_999, 0, 'claude', null, 1_000_000)).toEqual([]);
    expect(operatorAlertsFor(400_000, 0, 'claude', null, 1_000_000)).toEqual(['compact']);
    expect(operatorAlertsFor(600_000, 0, 'claude', null, 1_000_000)).toEqual(['close']);
  });
  it('caps thresholds to 75%/90% of a smaller known window', () => {
    expect(operatorAlertsFor(149_999, 0, 'claude', null, 200_000)).toEqual([]);
    expect(operatorAlertsFor(150_000, 0, 'claude', null, 200_000)).toEqual(['compact']);
    expect(operatorAlertsFor(179_999, 0, 'claude', null, 200_000)).toEqual(['compact']);
    expect(operatorAlertsFor(180_000, 0, 'claude', null, 200_000)).toEqual(['close']);
  });
  it('treats an invalid window as unknown', () => {
    expect(claudeAlertThresholds(null)).toEqual({ compact: 400_000, close: 600_000 });
    expect(claudeAlertThresholds(0)).toEqual({ compact: 400_000, close: 600_000 });
    expect(claudeAlertThresholds(NaN)).toEqual({ compact: 400_000, close: 600_000 });
  });

  it('stays neutral at 399,999 on a 1M window: safe tint, no pulse, no auto-open', () => {
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(399_999)} sessionId="s1" />);
    const t = trigger();
    expect(t.querySelector('.animate-pulse')).toBeNull();
    expect(t.querySelector('svg')?.getAttribute('class')).toContain('text-success');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('blinks the ring and opens the card once at 400K on a 1M window', () => {
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(400_000)} sessionId="s1" />);
    const t = trigger();
    expect(t.getAttribute('aria-label')).toContain('At 400K tokens');
    expect(t.querySelector('.animate-pulse')).not.toBeNull();
    expect(t.querySelector('svg')?.getAttribute('class')).toContain('text-danger');
    expect(screen.getByRole('dialog').textContent).toContain('/compact');
  });

  it('escalates to close at 600K', () => {
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(600_000)} sessionId="s1" />);
    expect(trigger().getAttribute('aria-label')).toContain('At 600K tokens');
    expect(screen.getByRole('dialog').textContent).toContain('new conversation');
  });

  it('names the capped threshold on a 200K window', () => {
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(180_000, 200_000)} sessionId="s1" />);
    expect(trigger().getAttribute('aria-label')).toContain('At 180K tokens');
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
    render(<TokenUsageSummary provider="claude" modelId="m1" usage={usage(399_999)} sessionId="s1" sessionStartedAt={startedAt} />);
    expect(trigger().querySelector('.animate-pulse')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
