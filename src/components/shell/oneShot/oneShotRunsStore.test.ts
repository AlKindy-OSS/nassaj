/**
 * T-2037 — one-shot run registry: runIds are minted only by startOneShotRun,
 * history is per project and capped, capture round-trips by runId.
 * Run: NODE_ENV=test npx vitest run src/components/shell/oneShot/oneShotRunsStore.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_TIMEOUT_MS,
  claimOneShotLaunch,
  clearOneShotRunsStorage,
  isLiveOneShotRun,
  oneShotRunsKey,
  outcomeStatus,
  MAX_ONESHOT_RUNS,
  consumeOneShotRequest,
  markOneShotFinished,
  markOneShotRefused,
  registerOneShotCaptureSender,
  requestOneShotCapture,
  requestOneShotRun,
  resetOneShotRunsForTests,
  resolveOneShotCapture,
  selectOneShotRun,
  startOneShotRun,
} from './oneShotRunsStore';

afterEach(() => {
  resetOneShotRunsForTests();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('oneShotRunsStore', () => {
  it('a request is consumed once and carries the trimmed command', () => {
    expect(requestOneShotRun('   ')).toBeNull();
    requestOneShotRun('  ls  ');
    expect(consumeOneShotRequest()).toEqual(expect.objectContaining({ command: 'ls' }));
    expect(consumeOneShotRequest()).toBeNull();
  });

  it('keeps the last runs per project, newest first, persisted', () => {
    const ids = Array.from({ length: MAX_ONESHOT_RUNS + 2 }, (_, i) => startOneShotRun('p1', `c${i}`).runId);
    expect(new Set(ids).size).toBe(ids.length);
    const stored = JSON.parse(window.localStorage.getItem('nassaj.oneShotRuns.v1:p1') ?? '[]');
    expect(stored).toHaveLength(MAX_ONESHOT_RUNS);
    expect(stored[0].command).toBe(`c${MAX_ONESHOT_RUNS + 1}`);
    expect(window.localStorage.getItem('nassaj.oneShotRuns.v1:p2')).toBeNull();
  });

  it('reloads runs with their original runId (remount re-attaches, never re-mints)', () => {
    const run = startOneShotRun('p1', 'ls');
    markOneShotFinished('p1', run.runId, { exitCode: 0 });
    const stored = window.localStorage.getItem('nassaj.oneShotRuns.v1:p1');
    resetOneShotRunsForTests();
    window.localStorage.setItem('nassaj.oneShotRuns.v1:p1', stored ?? '');
    selectOneShotRun('p1', run.runId);
    const reread = JSON.parse(window.localStorage.getItem('nassaj.oneShotRuns.v1:p1') ?? '[]');
    expect(reread[0]).toEqual(expect.objectContaining({ runId: run.runId, status: 'finished', exitCode: 0 }));
  });

  it('records a refusal code', () => {
    const run = startOneShotRun('p1', 'pm2 stop all');
    markOneShotRefused('p1', run.runId, 'denied_command:pm2_lifecycle');
    const stored = JSON.parse(window.localStorage.getItem('nassaj.oneShotRuns.v1:p1') ?? '[]');
    expect(stored[0]).toEqual(expect.objectContaining({ status: 'refused', refusalCode: 'denied_command:pm2_lifecycle' }));
  });

  it('capture resolves with the matching frame; null without a sender or on timeout', async () => {
    expect(await requestOneShotCapture('nobody')).toBeNull();

    const send = vi.fn(() => true);
    const unregister = registerOneShotCaptureSender('r1', send);
    const pending = requestOneShotCapture('r1');
    expect(send).toHaveBeenCalledTimes(1);
    resolveOneShotCapture('r1', { text: 'out', truncated: false, exitCode: 0 });
    await expect(pending).resolves.toEqual({ text: 'out', truncated: false, exitCode: 0 });

    vi.useFakeTimers();
    const timedOut = requestOneShotCapture('r1');
    vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS + 1);
    await expect(timedOut).resolves.toBeNull();
    unregister();
  });

  it('grants the launching init exactly once, only for runs started in this page', () => {
    const run = startOneShotRun('u:p', 'ls');
    expect(isLiveOneShotRun(run.runId)).toBe(true);
    expect(claimOneShotLaunch(run.runId)).toBe(true);
    expect(claimOneShotLaunch(run.runId)).toBe(false);
    expect(claimOneShotLaunch('restored-id')).toBe(false);
    expect(isLiveOneShotRun('restored-id')).toBe(false);
  });

  it('keys runs by user and project; no key without both', () => {
    expect(oneShotRunsKey(7, 'p1')).toBe('7:p1');
    expect(oneShotRunsKey(null, 'p1')).toBeNull();
    expect(oneShotRunsKey(7, null)).toBeNull();
  });

  it('sign-out clears every stored run and the live/launch state', () => {
    const run = startOneShotRun('7:p1', 'ls');
    window.localStorage.setItem('unrelated', 'x');
    clearOneShotRunsStorage();
    expect(window.localStorage.getItem('nassaj.oneShotRuns.v1:7:p1')).toBeNull();
    expect(window.localStorage.getItem('unrelated')).toBe('x');
    expect(claimOneShotLaunch(run.runId)).toBe(false);
    expect(isLiveOneShotRun(run.runId)).toBe(false);
  });

  it('only a numeric exit code is "finished"', () => {
    expect(outcomeStatus({ exitCode: 0 })).toBe('finished');
    expect(outcomeStatus({ exitCode: 2 })).toBe('finished');
    expect(outcomeStatus({ exitCode: null })).toBe('unknown');
    expect(outcomeStatus({ exitCode: null, unknown: true })).toBe('unknown');
    expect(outcomeStatus({ exitCode: null, interrupted: true })).toBe('interrupted');
    expect(outcomeStatus({ exitCode: 0, refused: true })).toBe('refused');
  });
});
