import { describe, expect, it } from 'vitest';

import {
  formatPrestageTime,
  isPrestageReadyFor,
  normalizePrestage,
  prestageNotice,
  type PrestageStatus,
} from './prestageStatus';

const base: PrestageStatus = {
  state: 'none', version: null, quarantineUntil: null, notPrestagedReason: null, readySince: null,
};
const at = (patch: Partial<PrestageStatus>): PrestageStatus => ({ ...base, ...patch });

describe('normalizePrestage (ADR-207)', () => {
  it('is null when absent (non-owner) or malformed', () => {
    expect(normalizePrestage(undefined)).toBeNull();
    expect(normalizePrestage(null)).toBeNull();
    expect(normalizePrestage({ state: 'exploded' })).toBeNull();
  });

  it('keeps valid fields and drops untrusted ones', () => {
    expect(normalizePrestage({
      state: 'quarantine', version: '2.4.0.1', quarantineUntil: 'not-a-date',
      notPrestagedReason: 'Low Memory!', readySince: '2026-10-15T10:00:00Z',
    })).toEqual({
      state: 'quarantine', version: '2.4.0.1', quarantineUntil: null,
      notPrestagedReason: null, readySince: '2026-10-15T10:00:00Z',
    });
  });
});

describe('isPrestageReadyFor', () => {
  it('requires ready AND the same version as the offered release', () => {
    expect(isPrestageReadyFor(at({ state: 'ready', version: '2.4.0.1' }), '2.4.0.1')).toBe(true);
    expect(isPrestageReadyFor(at({ state: 'ready', version: '2.4.0.0' }), '2.4.0.1')).toBe(false);
    expect(isPrestageReadyFor(at({ state: 'building', version: '2.4.0.1' }), '2.4.0.1')).toBe(false);
    expect(isPrestageReadyFor(null, '2.4.0.1')).toBe(false);
    expect(isPrestageReadyFor(at({ state: 'ready', version: '2.4.0.1' }), null)).toBe(false);
  });
});

describe('prestageNotice', () => {
  const L = '2.4.0.1';
  it.each([
    [at({ state: 'ready', version: L }), 'versionUpdate.prestage.ready', 'ready'],
    [at({ state: 'ready', version: '2.4.0.0' }), 'versionUpdate.prestage.notYet', 'neutral'],
    [at({ state: 'building', version: L }), 'versionUpdate.prestage.building', 'neutral'],
    [at({ state: 'quarantine' }), 'versionUpdate.prestage.notYet', 'neutral'],
    [at({ state: 'waiting', notPrestagedReason: 'low_memory' }), 'versionUpdate.prestage.lowMemory', 'neutral'],
    [at({ state: 'waiting', notPrestagedReason: 'low_disk' }), 'versionUpdate.prestage.lowDisk', 'neutral'],
    [at({ state: 'none', notPrestagedReason: 'policy_off' }), 'versionUpdate.prestage.stopped', 'neutral'],
    [at({ state: 'none', notPrestagedReason: 'kill_switch' }), 'versionUpdate.prestage.stopped', 'neutral'],
    [at({ state: 'waiting', notPrestagedReason: 'resource_busy' }), 'versionUpdate.prestage.notYet', 'neutral'],
    [at({ state: 'none', notPrestagedReason: 'something_new' }), 'versionUpdate.prestage.notYet', 'neutral'],
  ])('%o → %s', (prestage, key, tone) => {
    expect(prestageNotice(prestage, L)).toEqual({ key, tone });
  });

  it('carries the quarantine end for interpolation', () => {
    expect(prestageNotice(at({ state: 'quarantine', quarantineUntil: '2026-10-15T12:00:00Z' }), L))
      .toEqual({ key: 'versionUpdate.prestage.quarantine', tone: 'neutral', until: '2026-10-15T12:00:00Z' });
  });

  it('says nothing for adopted, a reasonless wait, absent data or no release', () => {
    expect(prestageNotice(at({ state: 'adopted', version: L }), L)).toBeNull();
    expect(prestageNotice(at({ state: 'waiting' }), L)).toBeNull();
    expect(prestageNotice(at({ state: 'none' }), L)).toBeNull();
    expect(prestageNotice(null, L)).toBeNull();
    expect(prestageNotice(at({ state: 'ready', version: L }), null)).toBeNull();
  });
});

describe('formatPrestageTime', () => {
  it('adds the weekday only when the time is not today', () => {
    const now = new Date('2026-10-15T08:00:00');
    const today = formatPrestageTime(new Date('2026-10-15T15:30:00').toISOString(), 'en-US', now);
    const later = formatPrestageTime(new Date('2026-10-17T15:30:00').toISOString(), 'en-US', now);
    expect(today).toMatch(/3:30/);
    expect(today).not.toMatch(/Sat/);
    expect(later).toMatch(/Sat/);
  });
});
