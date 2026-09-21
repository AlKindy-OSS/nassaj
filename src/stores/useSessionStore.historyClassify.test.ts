import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../utils/api', () => ({ authenticatedFetch }));

import {
  classifyHistoryFailure, planHistoryAutoRetry, HISTORY_AUTO_RETRY_CAP,
  useSessionStore, type HistoryError, type HistoryFailure,
} from './useSessionStore';

const fail = (status: number, code: string | null = null): HistoryFailure => ({
  ok: false, status, code, retryAfterMs: null,
});
const err = (status: number, retryAt = 0, retryAfterMs: number | null = null): HistoryError => ({
  ok: false, status, code: null, retryAfterMs, operation: 'initial', retryAt,
});

afterEach(cleanup);

// T-1660: the classifier is the single source of the banner key, so this table
// is the authoritative answer to "which status/code produces 'unavailable'".
describe('classifyHistoryFailure', () => {
  it('maps the specific transport statuses to their own keys', () => {
    expect(classifyHistoryFailure(fail(413, 'HISTORY_BUDGET_EXCEEDED'))).toBe('budget');
    expect(classifyHistoryFailure(fail(503, 'HISTORY_BUSY'))).toBe('busy');
    expect(classifyHistoryFailure(fail(504, 'HISTORY_TIMEOUT'))).toBe('timeout');
    expect(classifyHistoryFailure(fail(409, 'HISTORY_SOURCE_INCOMPLETE'))).toBe('incomplete');
    expect(classifyHistoryFailure(fail(409, 'HISTORY_REVISION_CHANGED'))).toBe('revision');
    expect(classifyHistoryFailure(fail(409, 'CURSOR_STALE'))).toBe('revision');
  });

  it('collapses every other status — including status 0 transport — to unavailable', () => {
    for (const status of [0, 400, 401, 403, 404, 409, 422, 500, 502]) {
      expect(classifyHistoryFailure(fail(status))).toBe('unavailable');
    }
    // A generic 409 (HISTORY_SOURCE_UNAVAILABLE) is NOT a rebase conflict.
    expect(classifyHistoryFailure(fail(409, 'HISTORY_SOURCE_UNAVAILABLE'))).toBe('unavailable');
    // The pure network failure the server never sees — the diagnostic log's reason.
    expect(classifyHistoryFailure(fail(0, 'HISTORY_NETWORK_ERROR'))).toBe('unavailable');
  });

  it('lets the rebase code win over a status that would otherwise bucket elsewhere', () => {
    expect(classifyHistoryFailure(fail(413, 'HISTORY_REVISION_CHANGED'))).toBe('revision');
  });

  it('treats a missing failure as unavailable', () => {
    expect(classifyHistoryFailure(null)).toBe('unavailable');
    expect(classifyHistoryFailure(undefined)).toBe('unavailable');
  });
});

// T-1660 follow-up: the auto-recovery planner decides WHEN a sticky banner
// retries itself, on capped exponential backoff, for transient statuses only.
describe('planHistoryAutoRetry', () => {
  it('retries transient transport/gateway statuses, including Cloudflare 520-524/530', () => {
    for (const status of [0, 502, 503, 504, 520, 521, 522, 523, 524, 530]) {
      expect(planHistoryAutoRetry(err(status), 0).retry).toBe(true);
    }
  });

  it('never retries a 4xx client/content rejection', () => {
    for (const status of [400, 401, 404, 413]) {
      expect(planHistoryAutoRetry(err(status), 0)).toEqual({ retry: false, delayMs: 0 });
    }
  });

  it('backs off exponentially and stops once the attempt cap is reached', () => {
    const now = 1_000_000;
    expect(planHistoryAutoRetry(err(0, 0), 0, now)).toEqual({ retry: true, delayMs: 1000 });
    expect(planHistoryAutoRetry(err(0, 0), 1, now)).toEqual({ retry: true, delayMs: 2000 });
    expect(planHistoryAutoRetry(err(0, 0), 2, now)).toEqual({ retry: true, delayMs: 4000 });
    expect(planHistoryAutoRetry(err(0, 0), 4, now)).toEqual({ retry: true, delayMs: 16000 });
    // Cap reached → recovery stops, leaving only the manual button.
    expect(planHistoryAutoRetry(err(0, 0), HISTORY_AUTO_RETRY_CAP, now).retry).toBe(false);
  });

  it('never schedules earlier than an honoured Retry-After (retryAt floor)', () => {
    const now = 1_000_000;
    // retryAt 20s out beats the 1s first backoff.
    expect(planHistoryAutoRetry(err(503, now + 20_000), 0, now)).toEqual({ retry: true, delayMs: 20_000 });
  });

  it('does not retry a missing error', () => {
    expect(planHistoryAutoRetry(null, 0)).toEqual({ retry: false, delayMs: 0 });
  });
});

// The diagnostic is the only record of a status-0 transport failure, which
// never reaches the server. It must fire for the unavailable class and stay
// silent for a failure that already has a specific, self-explaining banner.
describe('setHistoryError diagnostic logging', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('logs bounded metadata for an unavailable-class failure', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.setHistoryError('s1', fail(0, 'HISTORY_NETWORK_ERROR'), 'reconnect'));
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0];
    expect(message).toContain('unavailable');
    expect(meta).toEqual({ sessionId: 's1', operation: 'reconnect', status: 0, code: 'HISTORY_NETWORK_ERROR' });
  });

  it('does not log for a classified failure (413 budget)', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.setHistoryError('s2', fail(413, 'HISTORY_BUDGET_EXCEEDED'), 'older'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not log (or set an error) for an aborted read (status 499)', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.setHistoryError('s3', fail(499, 'HISTORY_ABORTED'), 'initial'));
    expect(warn).not.toHaveBeenCalled();
    expect(result.current.getSlot('s3').historyError).toBeNull();
  });
});
