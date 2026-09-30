import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { storeUpdateAttempt, readStoredUpdateAttempt, type StoredUpdateAttempt } from './updateJobClient';

const authenticatedFetch = vi.fn();
vi.mock('../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const {
  classifyCompletionVerdict,
  isCandidateForCompletionCheck,
  useUpdateCompletionNotice,
} = await import('./useUpdateCompletionNotice');

const baseAttempt: StoredUpdateAttempt = {
  idempotencyKey: 'a1b2c3d4-0000-4000-8000-000000000001',
  targetVersion: '2.3.0.12',
  statusUrl: '/api/system/update/jobs/job-1',
  createdAt: Date.now(),
};

const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

describe('isCandidateForCompletionCheck', () => {
  it('rejects when there is no stored attempt', () => {
    expect(isCandidateForCompletionCheck(null, '2.3.0.12')).toBe(false);
  });

  it('rejects when the current version is unknown', () => {
    expect(isCandidateForCompletionCheck(baseAttempt, null)).toBe(false);
  });

  it('rejects when the current version has not reached the target yet', () => {
    expect(isCandidateForCompletionCheck(baseAttempt, '2.3.0.11')).toBe(false);
  });

  it('accepts once the current version matches the stored target', () => {
    expect(isCandidateForCompletionCheck(baseAttempt, '2.3.0.12')).toBe(true);
  });

  it('rejects a stale attempt older than the 24h consent timeout', () => {
    const stale = { ...baseAttempt, createdAt: Date.now() - 25 * 60 * 60 * 1000 };
    expect(isCandidateForCompletionCheck(stale, '2.3.0.12')).toBe(false);
  });

  it('still accepts a fresh attempt within the 24h window', () => {
    const fresh = { ...baseAttempt, createdAt: Date.now() - 23 * 60 * 60 * 1000 };
    expect(isCandidateForCompletionCheck(fresh, '2.3.0.12')).toBe(true);
  });
});

describe('classifyCompletionVerdict', () => {
  it('reads "activated" as success', () => {
    expect(classifyCompletionVerdict('activated')).toBe('success');
  });

  it('reads other terminal states as a silent clear (no notice)', () => {
    expect(classifyCompletionVerdict('rolled_back')).toBe('clear-silent');
    expect(classifyCompletionVerdict('failed')).toBe('clear-silent');
    expect(classifyCompletionVerdict('cancelled')).toBe('clear-silent');
    expect(classifyCompletionVerdict('manual_recovery_required')).toBe('clear-silent');
  });

  it('reads a non-terminal state as pending — check again later', () => {
    expect(classifyCompletionVerdict('runtime_verifying')).toBe('pending');
    expect(classifyCompletionVerdict('activating')).toBe('pending');
  });
});

function Probe({ currentVersion }: { currentVersion: string | null }) {
  const { notice, dismiss } = useUpdateCompletionNotice(currentVersion);
  if (!notice) return <span>no-notice</span>;
  return (
    <div>
      <span>{`notice:${notice.targetVersion}`}</span>
      <button onClick={dismiss}>dismiss</button>
    </div>
  );
}

/** Flush the microtask queue (fetch/json Promise chains) without advancing virtual time. */
async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('useUpdateCompletionNotice', () => {
  beforeEach(() => {
    localStorage.clear();
    authenticatedFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('a version match alone does not show a notice — it must confirm activated first', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(200, { state: 'runtime_verifying' }));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await flushMicrotasks();
    expect(screen.getByText('no-notice')).not.toBeNull();
  });

  it('runtime_verifying leaves the stored attempt in place (still checking)', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(200, { state: 'runtime_verifying' }));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await flushMicrotasks();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('no-notice')).not.toBeNull();
    expect(readStoredUpdateAttempt()).not.toBeNull();
  });

  it('rolled_back clears the attempt silently — no success notice', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(200, { state: 'rolled_back' }));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await flushMicrotasks();
    expect(readStoredUpdateAttempt()).toBeNull();
    expect(screen.getByText('no-notice')).not.toBeNull();
  });

  it('activated shows the notice and clears the attempt', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(200, { state: 'activated' }));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await flushMicrotasks();
    expect(screen.getByText('notice:2.3.0.12')).not.toBeNull();
    expect(readStoredUpdateAttempt()).toBeNull();
  });

  it('a 404 on the job clears the attempt silently', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(404, {}));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await flushMicrotasks();
    expect(readStoredUpdateAttempt()).toBeNull();
    expect(screen.getByText('no-notice')).not.toBeNull();
  });

  it('never fetches when the attempt has no usable statusUrl', async () => {
    storeUpdateAttempt({ ...baseAttempt, statusUrl: undefined });
    render(<Probe currentVersion="2.3.0.12" />);
    await flushMicrotasks();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('dismiss clears the visible notice', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(200, { state: 'activated' }));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await flushMicrotasks();
    expect(screen.getByText('notice:2.3.0.12')).not.toBeNull();
    fireEvent.click(screen.getByText('dismiss'));
    expect(screen.getByText('no-notice')).not.toBeNull();
  });

  // qa-critic round 2, M-b(3): a transient read failure keeps the attempt and
  // retries, bounded at MAX_ATTEMPTS (5) — never spins forever.
  it('a persistent 500 keeps the attempt and retries up to the bound, then stops', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(500, {}));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await vi.advanceTimersByTimeAsync(30_000); // covers all 5 backed-off attempts
    expect(authenticatedFetch).toHaveBeenCalledTimes(5);
    expect(readStoredUpdateAttempt()).not.toBeNull();
    expect(screen.getByText('no-notice')).not.toBeNull();
  });

  it('a rejected fetch keeps the attempt and retries up to the bound', async () => {
    authenticatedFetch.mockRejectedValue(new Error('network down'));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(5);
    expect(readStoredUpdateAttempt()).not.toBeNull();
  });

  // qa-critic round 2, M-b(4): pending on the first read, activated on retry.
  it('shows the notice once a bounded retry finds the job activated', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(200, { state: 'runtime_verifying' }))
      .mockResolvedValue(jsonResponse(200, { state: 'activated' }));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    await vi.advanceTimersByTimeAsync(2_000); // past the first backoff step
    expect(screen.getByText('notice:2.3.0.12')).not.toBeNull();
    expect(readStoredUpdateAttempt()).toBeNull();
  });

  // qa-critic round 2, T-b: a newer attempt (owner started another update)
  // must never be clobbered by a stale check still in flight for the old one.
  it('does not clear a newer attempt that replaced the one being checked', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse(200, { state: 'activated' }));
    storeUpdateAttempt(baseAttempt);
    render(<Probe currentVersion="2.3.0.12" />);
    // The effect has started checking `baseAttempt` and its fetch is in
    // flight (not yet resolved — real awaiting happens on the next flush).
    // A new update attempt lands before that old check resolves.
    storeUpdateAttempt({ ...baseAttempt, idempotencyKey: 'newer-attempt-0000', targetVersion: '2.3.0.13' });
    await flushMicrotasks();
    expect(screen.getByText('no-notice')).not.toBeNull();
    expect(readStoredUpdateAttempt()?.idempotencyKey).toBe('newer-attempt-0000');
  });
});
