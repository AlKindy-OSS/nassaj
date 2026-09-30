import { beforeEach, describe, expect, it } from 'vitest';

import {
  GIT_CHECKOUT_V2_PHASES,
  RELEASE_LAYOUT_V2_PHASES,
  UPDATE_ATTEMPT_STORAGE_KEY,
  UPDATE_PROGRESS_STATES,
  blockedReasonI18nArgs,
  clearStoredUpdateAttempt,
  formatBytesDirectional,
  inferStrategy,
  isTerminalUpdateState,
  normalizeUpdateJob,
  parseBlockedStorage,
  phaseListForStrategy,
  pollingDelay,
  readStoredUpdateAttempt,
  safeStatusPath,
  storeUpdateAttempt,
  updateJobPercent,
} from './updateJobClient';

describe('updateJobClient', () => {
  beforeEach(() => localStorage.clear());

  it('persists the idempotent attempt needed to resume after reload', () => {
    const attempt = {
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb',
      jobId: 'job-7',
      statusUrl: '/api/system/update/jobs/job-7',
      targetVersion: '1.45.0.0',
      createdAt: 123,
    };
    storeUpdateAttempt(attempt);
    expect(readStoredUpdateAttempt()).toEqual(attempt);
    clearStoredUpdateAttempt();
    expect(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY)).toBeNull();
  });

  it('rejects cross-origin and unrelated polling URLs', () => {
    expect(safeStatusPath('/api/system/update/jobs/job-7')).toBe('/api/system/update/jobs/job-7');
    expect(safeStatusPath(`${location.origin}/api/system/update/jobs/job-7?view=status`))
      .toBe('/api/system/update/jobs/job-7?view=status');
    expect(safeStatusPath('https://attacker.invalid/api/system/update/jobs/job-7')).toBeNull();
    expect(safeStatusPath('/api/users')).toBeNull();
  });

  it('keeps exact server states and only treats actual outcomes as terminal', () => {
    expect(normalizeUpdateJob({ state: 'candidate_sealed' }).state).toBe('candidate_sealed');
    expect(isTerminalUpdateState('candidate_sealed')).toBe(false);
    expect(isTerminalUpdateState('restart_queued')).toBe(false);
    expect(isTerminalUpdateState('activated')).toBe(true);
    expect(isTerminalUpdateState('rolled_back')).toBe(true);
    expect(isTerminalUpdateState('manual_recovery_required')).toBe(true);
  });

  it('caps exponential polling backoff', () => {
    expect(pollingDelay(0)).toBe(1_000);
    expect(pollingDelay(3)).toBe(8_000);
    expect(pollingDelay(20)).toBe(10_000);
  });
});

// ─── Phase lists ─────────────────────────────────────────────────────────────

describe('GIT_CHECKOUT_V2_PHASES', () => {
  it('has exactly 9 phases ending with activated', () => {
    expect(GIT_CHECKOUT_V2_PHASES).toHaveLength(9);
    expect(GIT_CHECKOUT_V2_PHASES[0]).toBe('accepted');
    expect(GIT_CHECKOUT_V2_PHASES[GIT_CHECKOUT_V2_PHASES.length - 1]).toBe('activated');
  });

  it('includes staging but not downloading/archive_verified/extracting', () => {
    expect(GIT_CHECKOUT_V2_PHASES).toContain('staging');
    expect(GIT_CHECKOUT_V2_PHASES).not.toContain('downloading');
    expect(GIT_CHECKOUT_V2_PHASES).not.toContain('archive_verified');
    expect(GIT_CHECKOUT_V2_PHASES).not.toContain('extracting');
  });
});

describe('RELEASE_LAYOUT_V2_PHASES', () => {
  it('has exactly 11 phases ending with activated', () => {
    expect(RELEASE_LAYOUT_V2_PHASES).toHaveLength(11);
    expect(RELEASE_LAYOUT_V2_PHASES[RELEASE_LAYOUT_V2_PHASES.length - 1]).toBe('activated');
  });

  it('includes downloading/archive_verified/extracting but not staging', () => {
    expect(RELEASE_LAYOUT_V2_PHASES).toContain('downloading');
    expect(RELEASE_LAYOUT_V2_PHASES).toContain('archive_verified');
    expect(RELEASE_LAYOUT_V2_PHASES).toContain('extracting');
    expect(RELEASE_LAYOUT_V2_PHASES).not.toContain('staging');
  });
});

describe('phaseListForStrategy', () => {
  it('returns RELEASE_LAYOUT_V2_PHASES for release-layout-v2', () => {
    expect(phaseListForStrategy('release-layout-v2')).toBe(RELEASE_LAYOUT_V2_PHASES);
  });

  it('returns GIT_CHECKOUT_V2_PHASES for any other strategy', () => {
    expect(phaseListForStrategy('git-checkout-v2')).toBe(GIT_CHECKOUT_V2_PHASES);
    expect(phaseListForStrategy(undefined)).toBe(GIT_CHECKOUT_V2_PHASES);
    expect(phaseListForStrategy('unknown-strategy')).toBe(GIT_CHECKOUT_V2_PHASES);
  });
});

describe('UPDATE_PROGRESS_STATES backward compat alias', () => {
  it('aliases GIT_CHECKOUT_V2_PHASES', () => {
    expect(UPDATE_PROGRESS_STATES).toBe(GIT_CHECKOUT_V2_PHASES);
  });
});

// ─── updateJobPercent (per-strategy) ─────────────────────────────────────────

describe('updateJobPercent', () => {
  it('returns 0 for accepted and 100 only for activated (git-checkout-v2)', () => {
    expect(updateJobPercent('accepted', 'git-checkout-v2')).toBe(0);
    expect(updateJobPercent('activated', 'git-checkout-v2')).toBe(100);
  });

  it('returns 0 for accepted and 100 only for activated (release-layout-v2)', () => {
    expect(updateJobPercent('accepted', 'release-layout-v2')).toBe(0);
    expect(updateJobPercent('activated', 'release-layout-v2')).toBe(100);
  });

  it('returns exact percents for each git-checkout-v2 phase (no 18→55 jump)', () => {
    // 9 phases → indices 0–8 → percents 0, 13, 25, 38, 50, 63, 75, 88, 100
    const expected = [0, 13, 25, 38, 50, 63, 75, 88, 100];
    const actual = GIT_CHECKOUT_V2_PHASES.map(s => updateJobPercent(s, 'git-checkout-v2'));
    expect(actual).toEqual(expected);
  });

  it('returns exact percents for each release-layout-v2 phase (no 18→55 jump)', () => {
    // 11 phases → indices 0–10 → percents 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    const expected = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const actual = RELEASE_LAYOUT_V2_PHASES.map(s => updateJobPercent(s, 'release-layout-v2'));
    expect(actual).toEqual(expected);
  });

  it('is monotonically increasing along git-checkout-v2 phases', () => {
    const percents = GIT_CHECKOUT_V2_PHASES.map(s => updateJobPercent(s, 'git-checkout-v2') as number);
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThan(percents[i - 1]);
    }
  });

  it('is monotonically increasing along release-layout-v2 phases', () => {
    const percents = RELEASE_LAYOUT_V2_PHASES.map(s => updateJobPercent(s, 'release-layout-v2') as number);
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThan(percents[i - 1]);
    }
  });

  it('returns null for every failure and rollback terminal state', () => {
    expect(updateJobPercent('failed')).toBeNull();
    expect(updateJobPercent('rolled_back')).toBeNull();
    expect(updateJobPercent('rollback_pending')).toBeNull();
    expect(updateJobPercent('superseded')).toBeNull();
    expect(updateJobPercent('manual_recovery_required')).toBeNull();
  });

  it('returns null for an unrecognised/unknown state', () => {
    // Cast to bypass TS — tests the runtime path for unknown server state.
    expect(updateJobPercent('unknown_state' as never)).toBeNull();
  });

  it('never returns 100 for any active (non-terminal) phase in git-checkout-v2', () => {
    const activePhases = GIT_CHECKOUT_V2_PHASES.filter(s => s !== 'activated');
    for (const phase of activePhases) {
      expect(updateJobPercent(phase, 'git-checkout-v2')).toBeLessThan(100);
    }
  });

  it('infers git-checkout-v2 when strategy is absent and state is in that list', () => {
    // staging is exclusive to git-checkout-v2
    expect(updateJobPercent('staging')).toBe(38);
    expect(updateJobPercent('candidate_sealed')).toBe(50);
    expect(updateJobPercent('restart_queued')).toBe(63);
  });

  it('returns null for release-layout-v2-exclusive states when no strategy given', () => {
    // downloading / archive_verified / extracting are NOT in GIT_CHECKOUT_V2_PHASES
    expect(updateJobPercent('downloading')).toBeNull();
    expect(updateJobPercent('archive_verified')).toBeNull();
    expect(updateJobPercent('extracting')).toBeNull();
  });
});

describe('inferStrategy', () => {
  it('returns declared strategy when provided', () => {
    expect(inferStrategy('staging', 'release-layout-v2')).toBe('release-layout-v2');
  });

  it('infers git-checkout-v2 for states in that list', () => {
    expect(inferStrategy('staging')).toBe('git-checkout-v2');
    expect(inferStrategy('restart_queued')).toBe('git-checkout-v2');
    expect(inferStrategy('activated')).toBe('git-checkout-v2');
  });

  it('returns undefined for states not in git-checkout-v2 without declared strategy', () => {
    expect(inferStrategy('downloading')).toBeUndefined();
    expect(inferStrategy('extracting')).toBeUndefined();
  });
});

// ─── normalizeUpdateJob (dual-shape) ─────────────────────────────────────────

describe('normalizeUpdateJob dual-shape normalization', () => {
  it('accepts the new flat shape (T-1750)', () => {
    const snapshot = normalizeUpdateJob({
      state: 'failed',
      targetVersion: '1.45.0.0',
      errorCode: 'dirty_worktree',
      message: 'Tree has uncommitted changes',
      failedPhase: 'staging',
      strategy: 'git-checkout-v2',
    });
    expect(snapshot.state).toBe('failed');
    expect(snapshot.targetVersion).toBe('1.45.0.0');
    expect(snapshot.errorCode).toBe('dirty_worktree');
    expect(snapshot.message).toBe('Tree has uncommitted changes');
    expect(snapshot.failedPhase).toBe('staging');
    expect(snapshot.strategy).toBe('git-checkout-v2');
  });

  it('accepts the old nested shape (backward compat)', () => {
    const snapshot = normalizeUpdateJob({
      state: 'failed',
      expectedVersion: '1.45.0.0',
      error: { code: 'dirty_worktree', message: 'Tree has uncommitted changes' },
      strategy: 'git-checkout-v2',
    });
    expect(snapshot.state).toBe('failed');
    expect(snapshot.targetVersion).toBe('1.45.0.0');
    expect(snapshot.errorCode).toBe('dirty_worktree');
    expect(snapshot.message).toBe('Tree has uncommitted changes');
    expect(snapshot.failedPhase).toBeNull();
    expect(snapshot.strategy).toBe('git-checkout-v2');
  });

  it('prefers flat fields over nested when both present', () => {
    const snapshot = normalizeUpdateJob({
      state: 'failed',
      targetVersion: '1.45.0.0',
      expectedVersion: '1.44.0.0',
      errorCode: 'flat_code',
      message: 'flat message',
      error: { code: 'nested_code', message: 'nested message' },
    });
    expect(snapshot.targetVersion).toBe('1.45.0.0');
    expect(snapshot.errorCode).toBe('flat_code');
    expect(snapshot.message).toBe('flat message');
  });

  it('normalizes null failedPhase when absent', () => {
    const snapshot = normalizeUpdateJob({ state: 'failed', errorCode: 'candidate_build_failed' });
    expect(snapshot.failedPhase).toBeNull();
  });

  it('extracts failedPhase from new flat field', () => {
    const snapshot = normalizeUpdateJob({ state: 'rolled_back', failedPhase: 'activating' });
    expect(snapshot.failedPhase).toBe('activating');
  });

  it('falls back to version field as last resort for targetVersion', () => {
    const snapshot = normalizeUpdateJob({ state: 'accepted', version: '1.45.0.0' });
    expect(snapshot.targetVersion).toBe('1.45.0.0');
  });

  it('handles missing error gracefully — null errorCode and message', () => {
    const snapshot = normalizeUpdateJob({ state: 'activating' });
    expect(snapshot.errorCode).toBeNull();
    expect(snapshot.message).toBeUndefined();
  });
});

// ─── T-1912: scheduled-message hold on restart_queued ────────────────────────

describe('normalizeUpdateJob scheduled-message hold (T-1912)', () => {
  it('keeps autoActivation.state = waiting_scheduled and parses scheduledDueSoon', () => {
    const snapshot = normalizeUpdateJob({
      state: 'restart_queued',
      autoActivate: true,
      autoActivation: {
        state: 'waiting_scheduled',
        code: 'scheduled_messages_due',
        liveSessions: 0,
        deadlineAt: 1_700_000_000_000,
        scheduledDueSoon: { count: 2, earliestAt: '2026-09-28T10:15:00.000Z' },
      },
    });
    expect(snapshot.autoActivation?.state).toBe('waiting_scheduled');
    expect(snapshot.autoActivation?.scheduledDueSoon).toEqual({
      count: 2,
      earliestAt: '2026-09-28T10:15:00.000Z',
    });
    expect(snapshot.autoActivation?.scheduledOverride).toBe(false);
  });

  it('parses scheduledOverride: true once the owner has skipped the wait', () => {
    const snapshot = normalizeUpdateJob({
      state: 'restart_queued',
      autoActivation: {
        state: 'waiting_scheduled',
        scheduledDueSoon: { count: 1, earliestAt: null },
        scheduledOverride: true,
      },
    });
    expect(snapshot.autoActivation?.scheduledOverride).toBe(true);
    expect(snapshot.autoActivation?.scheduledDueSoon).toEqual({ count: 1, earliestAt: null });
  });

  it('parses a terminal gate refusal with its reason (activation defect 2026-09-29)', () => {
    const snapshot = normalizeUpdateJob({
      state: 'restart_queued',
      autoActivation: { state: 'refused', code: 'gate_failed', terminal: true, reason: 'node required' },
    });
    expect(snapshot.autoActivation?.terminal).toBe(true);
    expect(snapshot.autoActivation?.reason).toBe('node required');
    const plain = normalizeUpdateJob({ state: 'restart_queued', autoActivation: { state: 'refused', code: 'x' } });
    expect(plain.autoActivation?.terminal).toBe(false);
    expect(plain.autoActivation?.reason).toBeNull();
  });

  it('drops a malformed scheduledDueSoon (non-positive count) to null', () => {
    const snapshot = normalizeUpdateJob({
      state: 'restart_queued',
      autoActivation: { state: 'waiting_scheduled', scheduledDueSoon: { count: 0, earliestAt: null } },
    });
    expect(snapshot.autoActivation?.scheduledDueSoon).toBeNull();
  });

  it('drops an unparseable earliestAt string to null but keeps the count', () => {
    const snapshot = normalizeUpdateJob({
      state: 'restart_queued',
      autoActivation: { state: 'waiting_scheduled', scheduledDueSoon: { count: 3, earliestAt: 'not-a-date' } },
    });
    expect(snapshot.autoActivation?.scheduledDueSoon).toEqual({ count: 3, earliestAt: null });
  });

  it('parses the top-level scheduledDueSoon field independent of autoActivation', () => {
    const snapshot = normalizeUpdateJob({
      state: 'restart_queued',
      scheduledDueSoon: { count: 1, earliestAt: '2026-09-28T09:00:00.000Z' },
    });
    expect(snapshot.scheduledDueSoon).toEqual({ count: 1, earliestAt: '2026-09-28T09:00:00.000Z' });
  });

  it('normalizes a null/absent scheduledDueSoon to null', () => {
    const snapshot = normalizeUpdateJob({ state: 'restart_queued' });
    expect(snapshot.scheduledDueSoon).toBeNull();
  });

  it('still accepts pre-T-1912 autoActivation states unchanged', () => {
    const snapshot = normalizeUpdateJob({
      state: 'restart_queued',
      autoActivation: { state: 'waiting_sessions', liveSessions: 2 },
    });
    expect(snapshot.autoActivation?.state).toBe('waiting_sessions');
    expect(snapshot.autoActivation?.scheduledDueSoon).toBeNull();
    expect(snapshot.autoActivation?.scheduledOverride).toBe(false);
  });
});

describe('parseBlockedStorage', () => {
  it('accepts finite non-negative integer byte counts', () => {
    expect(parseBlockedStorage({ availableBytes: 1024, requiredBytes: 2048 }))
      .toEqual({ availableBytes: 1024, requiredBytes: 2048 });
  });

  it('accepts zero as a valid byte count', () => {
    expect(parseBlockedStorage({ availableBytes: 0, requiredBytes: 0 }))
      .toEqual({ availableBytes: 0, requiredBytes: 0 });
  });

  it('rejects null/undefined/non-object input', () => {
    expect(parseBlockedStorage(null)).toBeNull();
    expect(parseBlockedStorage(undefined)).toBeNull();
    expect(parseBlockedStorage('nope')).toBeNull();
    expect(parseBlockedStorage(42)).toBeNull();
  });

  it('rejects negative byte counts', () => {
    expect(parseBlockedStorage({ availableBytes: -1, requiredBytes: 2048 })).toBeNull();
  });

  it('rejects non-integer byte counts', () => {
    expect(parseBlockedStorage({ availableBytes: 1.5, requiredBytes: 2048 })).toBeNull();
  });

  it('rejects non-finite byte counts (Infinity/NaN)', () => {
    expect(parseBlockedStorage({ availableBytes: Infinity, requiredBytes: 2048 })).toBeNull();
    expect(parseBlockedStorage({ availableBytes: NaN, requiredBytes: 2048 })).toBeNull();
  });

  it('rejects string-typed byte counts', () => {
    expect(parseBlockedStorage({ availableBytes: '1024', requiredBytes: 2048 })).toBeNull();
  });

  it('rejects a payload missing one of the two fields', () => {
    expect(parseBlockedStorage({ availableBytes: 1024 })).toBeNull();
  });
});

describe('blockedReasonI18nArgs', () => {
  it('returns the plain key for a non-storage reason', () => {
    expect(blockedReasonI18nArgs('release_layout_required', null))
      .toEqual({ key: 'versionUpdate.blockedReasons.release_layout_required' });
  });

  it('falls back to "failed" for an undefined reason', () => {
    expect(blockedReasonI18nArgs(undefined, null))
      .toEqual({ key: 'versionUpdate.blockedReasons.failed' });
  });

  it('returns the plain insufficient_disk key when no figures are available', () => {
    expect(blockedReasonI18nArgs('insufficient_disk', null))
      .toEqual({ key: 'versionUpdate.blockedReasons.insufficient_disk' });
  });

  it('returns the detail key with human-readable figures and the shortfall when figures are present', () => {
    const result = blockedReasonI18nArgs('insufficient_disk', { availableBytes: 500 * 1024 * 1024, requiredBytes: 2 * 1024 * 1024 * 1024 });
    expect(result.key).toBe('versionUpdate.blockedReasons.insufficient_disk_detail');
    expect(result.params).toEqual({ available: '500 MB', required: '2 GB', shortfall: '1.6 GB' });
  });

  it('never renders an identical available/required pair as a zero shortfall gap', () => {
    // 4 GiB available against a 4.05 GiB requirement: naive one-decimal rounding
    // of each figure independently would print "4 GB available, 4 GB required".
    const result = blockedReasonI18nArgs('insufficient_disk', {
      availableBytes: 4 * 1024 * 1024 * 1024,
      requiredBytes: Math.round(4.05 * 1024 * 1024 * 1024),
    });
    expect(result.params?.available).toBe('4 GB');
    expect(result.params?.required).toBe('4.1 GB');
    expect(result.params?.shortfall).toBe('51.2 MB');
  });

  it('ignores figures for a reason other than insufficient_disk', () => {
    const result = blockedReasonI18nArgs('storage_probe_failed', { availableBytes: 1024, requiredBytes: 2048 });
    expect(result).toEqual({ key: 'versionUpdate.blockedReasons.storage_probe_failed' });
  });
});

describe('formatBytesDirectional', () => {
  it('formats zero and sub-byte input as "0 B"', () => {
    expect(formatBytesDirectional(0, 'down')).toBe('0 B');
    expect(formatBytesDirectional(-5, 'up')).toBe('0 B');
    expect(formatBytesDirectional(Number.NaN, 'down')).toBe('0 B');
  });

  it('formats plain bytes and kilobytes', () => {
    expect(formatBytesDirectional(512, 'down')).toBe('512 B');
    expect(formatBytesDirectional(2048, 'down')).toBe('2 KB');
  });

  it('formats megabytes, gigabytes, and terabytes with binary (1024) units', () => {
    expect(formatBytesDirectional(500 * 1024 * 1024, 'down')).toBe('500 MB');
    expect(formatBytesDirectional(2 * 1024 * 1024 * 1024, 'up')).toBe('2 GB');
    expect(formatBytesDirectional(3 * 1024 * 1024 * 1024 * 1024, 'down')).toBe('3 TB');
  });

  it('rounds down for "down" so availability is never overstated', () => {
    // 1.999 GiB should read as 1.9 GB available, not round up to "2 GB".
    const bytes = Math.round(1.999 * 1024 * 1024 * 1024);
    expect(formatBytesDirectional(bytes, 'down')).toBe('1.9 GB');
  });

  it('rounds up for "up" so a requirement or shortfall is never understated', () => {
    // 1.901 GiB should read as 1.91 GB → 2 decimal? no, one decimal ceil → 2.0 → "2 GB"
    const bytes = Math.round(1.901 * 1024 * 1024 * 1024);
    expect(formatBytesDirectional(bytes, 'up')).toBe('2 GB');
  });

  it('near-equal figures still diverge under opposite rounding directions', () => {
    const bytes = Math.round(4.04 * 1024 * 1024 * 1024);
    expect(formatBytesDirectional(bytes, 'down')).toBe('4 GB');
    expect(formatBytesDirectional(bytes, 'up')).toBe('4.1 GB');
  });
});
