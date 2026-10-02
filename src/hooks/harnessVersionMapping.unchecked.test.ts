/**
 * B-1468: `parseUncheckedDetails` validates the STORE_ACCESS_UNPROVABLE details
 * shared by the synchronous 423 body and a failed job's `error`. The server
 * caps the list and may send a larger total; neither field is trusted as-is.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { describe, expect, it } from 'vitest';

import { mapUpdateJob, parseUncheckedDetails } from './harnessVersionMapping';

describe('parseUncheckedDetails', () => {
  it('returns undefined for a missing, non-array, or all-invalid list', () => {
    expect(parseUncheckedDetails(undefined)).toBeUndefined();
    expect(parseUncheckedDetails(null)).toBeUndefined();
    expect(parseUncheckedDetails({ code: 'STORE_ACCESS_UNPROVABLE' })).toBeUndefined();
    expect(parseUncheckedDetails({ uncheckedProcesses: 'sqlite3' })).toBeUndefined();
    expect(parseUncheckedDetails({ uncheckedProcesses: [{ pid: '1', comm: 'x' }, { pid: 2 }, null] })).toBeUndefined();
  });

  it('keeps valid entries, a known reason, and drops an unknown reason', () => {
    expect(parseUncheckedDetails({
      uncheckedProcesses: [
        { pid: 1, comm: 'a', reason: 'identity_unverified' },
        { pid: 2, comm: 'b', reason: 'something_new' },
        { pid: 3.5, comm: 'c' },
      ],
    })).toEqual({ processes: [{ pid: 1, comm: 'a', reason: 'identity_unverified' }, { pid: 2, comm: 'b' }], total: 2 });
  });

  it('uses the total only when it is an integer above the shown list length', () => {
    const list = [{ pid: 1, comm: 'a' }];
    expect(parseUncheckedDetails({ uncheckedProcesses: list, uncheckedProcessCount: 12 })?.total).toBe(12);
    expect(parseUncheckedDetails({ uncheckedProcesses: list, uncheckedProcessCount: 0 })?.total).toBe(1);
    expect(parseUncheckedDetails({ uncheckedProcesses: list, uncheckedProcessCount: 2.5 })?.total).toBe(1);
    expect(parseUncheckedDetails({ uncheckedProcesses: list, uncheckedProcessCount: '9' })?.total).toBe(1);
  });

  it('mapUpdateJob threads a failed job error into state.unchecked', () => {
    const state = mapUpdateJob({
      jobId: 'j', provider: 'codex', status: 'failed', phase: 'done', percent: 100, log: [],
      fromVersion: '1', toVersion: '2',
      error: { code: 'STORE_ACCESS_UNPROVABLE', message: 'm', uncheckedProcesses: [{ pid: 9, comm: 'z' }] },
    });
    expect(state).toMatchObject({ status: 'failed', reason: 'STORE_ACCESS_UNPROVABLE', unchecked: { processes: [{ pid: 9, comm: 'z' }], total: 1 } });
  });
});
