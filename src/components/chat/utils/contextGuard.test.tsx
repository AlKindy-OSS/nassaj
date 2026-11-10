/**
 * T-2087 / ADR-223 — the pre-switch context check and the refusal reader.
 * RUNNER: vitest (jsdom), real i18n bundles and the real dialog host, so the
 * copy asserted is what the user reads.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../../i18n/config.js';
import { DialogHost } from '../../../shared/dialogs/DialogHost';
import { confirmDialog, resetDialogsForTests } from '../../../shared/dialogs/dialogService';

import { guardModelSwitch, readContextGuardRefusal } from './contextGuard';

/** Model ids are shown with non-breaking hyphens so they never wrap mid-id. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/\u2011/g, '-');

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

/** Opus 1M session at ~312k switching to Haiku 200k (budget after the reply reserve). */
const TOO_SMALL = {
  success: true,
  data: { verdict: 'too_small', used: 312_000, budget: 180_000, window: 200_000,
    model: 'claude-haiku-4-5', previousModel: 'claude-opus-4-6[1m]' },
};

type FitFetcher = (url: string, options?: RequestInit) => Promise<Response>;
const run = (fetcher: FitFetcher, onUnknown: (line: string) => void = vi.fn()) => guardModelSwitch({
  fetcher, provider: 'claude', sessionId: 'sess-1', model: 'claude-haiku-4-5',
  t: i18n.getFixedT(i18n.language, 'chat'), confirm: confirmDialog, onUnknown,
});

afterEach(() => {
  act(() => resetDialogsForTests());
  cleanup();
});

describe('guardModelSwitch', () => {
  it('A1: Arabic warning with both numbers before pinning; cancel keeps the model and posts nothing', async () => {
    await i18n.changeLanguage('ar');
    const fetcher = vi.fn<FitFetcher>(async () => reply(200, TOO_SMALL));
    render(<DialogHost />);
    let decision!: Promise<boolean>;
    act(() => { decision = run(fetcher); });

    const dialog = await screen.findByRole('alertdialog');
    const text = plain(dialog.textContent);
    expect(text).toMatch(/[؀-ۿ]/);
    expect(text).toContain('312K');
    expect(text).toContain('180K');
    expect(text).toContain('claude-haiku-4-5');
    expect(text).toContain('/compact');

    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:contextGuard.preflight.cancel') }));
    await expect(decision).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options = {}] = fetcher.mock.calls[0];
    expect(url).toBe('/api/providers/claude/sessions/sess-1/context-fit?model=claude-haiku-4-5');
    expect(options.method).toBe('GET');
  });

  it('A1: "switch anyway" lets the switch go ahead', async () => {
    await i18n.changeLanguage('ar');
    render(<DialogHost />);
    let decision!: Promise<boolean>;
    act(() => { decision = run(async () => reply(200, TOO_SMALL)); });
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:contextGuard.preflight.switchAnyway') }));
    await expect(decision).resolves.toBe(true);
  });

  it('A8: English UI shows English copy', async () => {
    await i18n.changeLanguage('en');
    render(<DialogHost />);
    act(() => { void run(async () => reply(200, TOO_SMALL)); });
    const text = (await screen.findByRole('alertdialog')).textContent ?? '';
    expect(text).not.toMatch(/[؀-ۿ]/);
    expect(text).toContain('312K');
    expect(text).toContain('180K');
    expect(text).toMatch(/compact/i);
    expect(screen.getByRole('button', { name: 'Switch anyway' })).toBeTruthy();
  });

  it('unknown: one neutral line, never blocks', async () => {
    await i18n.changeLanguage('ar');
    const onUnknown = vi.fn<(line: string) => void>();
    const fetcher = vi.fn<FitFetcher>(async () => reply(200, { success: true, data: { verdict: 'unknown', used: null } }));
    await expect(run(fetcher, onUnknown)).resolves.toBe(true);
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown.mock.calls[0][0]).toMatch(/[؀-ۿ]/);
    expect(plain(onUnknown.mock.calls[0][0])).toContain('claude-haiku-4-5');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    ['fits', async () => reply(200, { success: true, data: { verdict: 'fits', used: 1, budget: 9 } })],
    ['429', async () => reply(429, { success: false })],
    ['404', async () => reply(404, { success: false })],
    ['network error', async () => { throw new TypeError('Failed to fetch'); }],
    ['malformed body', async () => reply(200, { success: true, data: { verdict: 'maybe' } })],
  ] as Array<[string, FitFetcher]>)('%s: proceeds silently', async (_label, impl) => {
    const onUnknown = vi.fn<(line: string) => void>();
    await expect(run(impl, onUnknown)).resolves.toBe(true);
    expect(onUnknown).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('readContextGuardRefusal', () => {
  const frame = {
    kind: 'complete', success: false, notStarted: true, code: 'context_guard_window_too_small',
    contextGuard: {
      used: 312_000, budget: 180_000, model: 'claude-haiku-4-5', previousModel: 'claude-opus-4-6[1m]',
      canCompactOnPrevious: true,
    },
    error: 'The conversation is larger than the selected model can hold, so nothing was sent.',
  };

  it('reads the payload fields', () => {
    expect(readContextGuardRefusal(frame)).toEqual({
      used: 312_000, budget: 180_000, model: 'claude-haiku-4-5', previousModel: 'claude-opus-4-6[1m]',
      canCompactOnPrevious: true,
    });
  });

  it('compact is safe only when the server says so (missing or non-true → false)', () => {
    const { canCompactOnPrevious: _omit, ...withoutFlag } = frame.contextGuard;
    expect(readContextGuardRefusal({ ...frame, contextGuard: withoutFlag })?.canCompactOnPrevious).toBe(false);
    expect(readContextGuardRefusal({ ...frame, contextGuard: { ...withoutFlag, canCompactOnPrevious: 'true' } })
      ?.canCompactOnPrevious).toBe(false);
  });

  it('rejects another code, a missing payload, or unsafe fields', () => {
    expect(readContextGuardRefusal({ ...frame, code: 'run_failed' })).toBeNull();
    expect(readContextGuardRefusal({ ...frame, contextGuard: undefined })).toBeNull();
    expect(readContextGuardRefusal({ ...frame, contextGuard: { ...frame.contextGuard, used: -1 } })).toBeNull();
    expect(readContextGuardRefusal({ ...frame, contextGuard: { ...frame.contextGuard, model: '<img>' } })).toBeNull();
    expect(readContextGuardRefusal({ ...frame, contextGuard: { ...frame.contextGuard, previousModel: 7 } })?.previousModel)
      .toBeNull();
  });
});

describe('ChatInterface wiring (source contract: the component is too large to mount)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/chat/view/ChatInterface.tsx'), 'utf8');
  const start = source.indexOf('const handleChangeSessionModel = useCallback(');
  const body = source.slice(start, source.indexOf('}, [', start));

  it('skips the fit check when the engine axis moves (no misleading "couldn\'t verify" line)', () => {
    const declared = body.indexOf('const engineAxisMoves');
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(body.indexOf('guardModelSwitch('));
    expect(body).toMatch(/if \(sid && !engineAxisMoves && model !== previousModel\) \{\s*const proceed = await guardModelSwitch\(/);
  });

  it('checks the fit before the optimistic update and before any POST', () => {
    const guard = body.indexOf('guardModelSwitch(');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf('setSessionCurrentModel(model)'));
    expect(guard).toBeLessThan(body.indexOf('restampSessionEngine('));
    expect(guard).toBeLessThan(body.indexOf('selectProviderModel('));
  });
});
