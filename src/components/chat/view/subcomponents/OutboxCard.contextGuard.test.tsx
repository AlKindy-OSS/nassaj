/**
 * T-2087 / ADR-223 — a turn refused because the pinned model cannot hold the
 * conversation: the outbox card explains it in the UI language from the
 * payload (never the server's English sentence), keeps the draft, and offers
 * "switch back" and "shrink the conversation".
 * RUNNER: vitest (jsdom), real i18n bundles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import i18n from '../../../../i18n/config.js';
import { resolveOutboxVerdict, type OutboxEntry } from '../../utils/messageOutbox';

import OutboxCard from './OutboxCard';

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { role: 'user' } }),
}));
vi.mock('../../../../contexts/PaletteOpsContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePaletteOps: () => ({ openFile: vi.fn(), openSettings: vi.fn(), refreshProjects: vi.fn() }),
}));
vi.mock('../../utils/messageOutbox', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readOutboxImages: async () => [],
}));

const SERVER_TEXT = 'The conversation is larger than the selected model can hold, so nothing was sent.';
const guard = {
  used: 312_000, budget: 180_000, model: 'claude-haiku-4-5', previousModel: 'claude-opus-4-6[1m]',
  canCompactOnPrevious: true,
};
const entry: OutboxEntry = {
  id: 'm1', projectId: 'p', sessionId: 'sess-1', text: 'راجع الملف التالي', createdAt: Date.now(),
  status: 'failed', reasonCode: 'context_guard_window_too_small', reasonDetail: null, imageNames: [], intent: {},
  contextGuard: guard,
};
const noop = vi.fn();

afterEach(cleanup);

type Handlers = { switchBack?: (model: string) => void; compact?: () => void };
function renderCard(over: Partial<OutboxEntry> = {}, handlers: Handlers = {}) {
  return render(
    <OutboxCard
      entry={{ ...entry, ...over }}
      onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop}
      onContextGuardSwitchBack={handlers.switchBack}
      onContextGuardCompact={handlers.compact}
    />,
  );
}

describe('OutboxCard: context_guard_window_too_small', () => {
  it('renders localized Arabic copy with both numbers and models, keeps the draft', async () => {
    await i18n.changeLanguage('ar');
    renderCard();
    const notice = screen.getByTestId('context-guard-refusal');
    const text = notice.textContent ?? '';
    expect(text).toMatch(/[؀-ۿ]/);
    for (const part of ['312K', '180K', 'claude-haiku-4-5', 'claude-opus-4-6[1m]']) expect(text).toContain(part);
    expect(notice.querySelectorAll('bdi').length).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).not.toContain(SERVER_TEXT);
    expect(screen.getByTestId('outbox-text').textContent).toBe('راجع الملف التالي');
    expect(screen.getByRole('button', { name: i18n.t('chat:outbox.tryAgain') })).toBeTruthy();
    expect(screen.getByRole('button', { name: i18n.t('chat:outbox.edit') })).toBeTruthy();
  });

  it('English UI shows English copy', async () => {
    await i18n.changeLanguage('en');
    renderCard({}, { switchBack: vi.fn(), compact: vi.fn() });
    const text = screen.getByTestId('context-guard-refusal').textContent ?? '';
    expect(text).not.toMatch(/[؀-ۿ]/);
    expect(text).toContain('312K');
    expect(screen.getByRole('button', { name: /Switch back to claude-opus-4-6\[1m\]/ })).toBeTruthy();
  });

  it('switch back restores the previous model; shrink inserts /compact', async () => {
    await i18n.changeLanguage('ar');
    const switchBack = vi.fn();
    const compact = vi.fn();
    renderCard({}, { switchBack, compact });
    fireEvent.click(screen.getByRole('button', { name: /claude-opus-4-6\[1m\]/ }));
    expect(switchBack).toHaveBeenCalledWith('claude-opus-4-6[1m]');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:contextGuard.actions.compact') }));
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('OpenCode-style refusal (compact not safe): no shrink action, switch-back stays', async () => {
    await i18n.changeLanguage('ar');
    renderCard({ contextGuard: { ...guard, canCompactOnPrevious: false } }, { switchBack: vi.fn(), compact: vi.fn() });
    expect(screen.queryByRole('button', { name: i18n.t('chat:contextGuard.actions.compact') })).toBeNull();
    expect(screen.getByRole('button', { name: /claude-opus-4-6\[1m\]/ })).toBeTruthy();
  });

  it.each([
    ['ar', /قلّص/],
    ['en', /shrink/i],
  ])('%s body mentions shrinking only when the shrink action is offered', async (lang, shrink) => {
    await i18n.changeLanguage(lang);
    const body = () => screen.getByTestId('context-guard-refusal').querySelector('p + p')?.textContent ?? '';
    for (const previousModel of ['claude-opus-4-6[1m]', null]) {
      renderCard({ contextGuard: { ...guard, previousModel, canCompactOnPrevious: true } });
      expect(body()).toMatch(shrink);
      cleanup();
      renderCard({ contextGuard: { ...guard, previousModel, canCompactOnPrevious: false } });
      expect(body()).not.toMatch(shrink);
      expect(body()).toContain('312K');
      cleanup();
    }
  });

  it('without a previous model there is no switch-back action', async () => {
    await i18n.changeLanguage('ar');
    renderCard({ contextGuard: { ...guard, previousModel: null } }, { switchBack: vi.fn(), compact: vi.fn() });
    expect(screen.getByTestId('context-guard-refusal').textContent).not.toContain('claude-opus');
    expect(screen.getAllByRole('button').some((b) => /ارجع/.test(b.textContent ?? ''))).toBe(false);
  });
});

describe('outbox verdict for the refusal frame', () => {
  it('carries the payload and drops the server sentence as detail', () => {
    const frame = {
      kind: 'complete', clientMsgId: 'm1', success: false, notStarted: true,
      code: 'context_guard_window_too_small', contextGuard: guard, error: SERVER_TEXT,
    };
    const verdict = resolveOutboxVerdict(frame, {
      isActiveViewSession: true,
      readErrorCode: (m) => (m as { code?: string }).code ?? null,
      readErrorDetail: () => null,
    });
    expect(verdict).toMatchObject({
      action: 'fail', code: 'context_guard_window_too_small', detail: null, contextGuard: guard,
    });
  });
});
