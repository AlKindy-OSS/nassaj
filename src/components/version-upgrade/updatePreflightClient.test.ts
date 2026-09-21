import { describe, expect, it } from 'vitest';

import { interpretPreflightResponse, localizeBlocker } from './updatePreflightClient';

const blockerBody = {
  ok: false,
  blocker: {
    code: 'active_sessions',
    ar: 'توجد جلسات نشطة.',
    en: 'Active sessions are running.',
    action: { ar: 'أنهِ الجلسات.', en: 'End the sessions.', command: null },
  },
};

describe('interpretPreflightResponse', () => {
  it('is clear only for an explicit ok body without a blocker', () => {
    expect(interpretPreflightResponse(200, { ok: true, blocker: null })).toEqual({ status: 'clear' });
  });

  it('fails closed on a 200 whose body cannot be read', () => {
    expect(interpretPreflightResponse(200, {})).toEqual({ status: 'error', reason: 'unavailable', code: null });
    expect(interpretPreflightResponse(200, { ok: false })).toEqual({ status: 'error', reason: 'unavailable', code: null });
  });

  it('reports one blocker with its single cause and single action', () => {
    const outcome = interpretPreflightResponse(200, blockerBody);
    expect(outcome).toEqual({
      status: 'blocked',
      blocker: {
        code: 'active_sessions',
        reasonAr: 'توجد جلسات نشطة.',
        reasonEn: 'Active sessions are running.',
        actionAr: 'أنهِ الجلسات.',
        actionEn: 'End the sessions.',
        command: null,
      },
    });
  });

  it('keeps the operator command verbatim', () => {
    const outcome = interpretPreflightResponse(200, {
      ok: false,
      blocker: { code: 'dirty_worktree', en: 'Dirty.', action: { en: 'Clean it.', command: 'git status' } },
    });
    expect(outcome.status === 'blocked' && outcome.blocker.command).toBe('git status');
  });

  it('distinguishes rate limiting and honours Retry-After', () => {
    expect(interpretPreflightResponse(429, {}, '42')).toEqual({ status: 'rate_limited', retryAfterSeconds: 42 });
    expect(interpretPreflightResponse(429, {}, 'soon')).toEqual({ status: 'rate_limited', retryAfterSeconds: null });
  });

  it('maps authorization and server failures to explicit error states', () => {
    expect(interpretPreflightResponse(403, {})).toEqual({ status: 'error', reason: 'authorization', code: null });
    expect(interpretPreflightResponse(503, { code: 'update_capability_unavailable' }))
      .toEqual({ status: 'error', reason: 'unavailable', code: 'update_capability_unavailable' });
  });
});

describe('localizeBlocker', () => {
  const outcome = interpretPreflightResponse(200, blockerBody);
  const blocker = outcome.status === 'blocked' ? outcome.blocker : null;

  it('uses Arabic text for an Arabic UI and English otherwise', () => {
    expect(blocker).not.toBeNull();
    expect(localizeBlocker(blocker!, 'ar').reason).toBe('توجد جلسات نشطة.');
    expect(localizeBlocker(blocker!, 'de').action).toBe('End the sessions.');
  });

  it('falls back to the other language when one side is missing', () => {
    expect(localizeBlocker({ ...blocker!, reasonAr: null }, 'ar').reason).toBe('Active sessions are running.');
  });
});
