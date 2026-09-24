import { describe, expect, it } from 'vitest';

import { compareVersions, parseVersion } from './versionCompare';

const ASCENDING = [
  '1.38.0.1',
  '1.39-alpha',
  '1.39-beta',
  '1.39-nassaj',
  '1.39-rc.1',
  '1.39-rc.2',
  '1.39-rc.10',
  '1.39',
  '1.39.0.1',
  '1.39.1',
  '1.40',
];

describe('parseVersion', () => {
  it('parses v prefixes, four-part cores, prereleases and build metadata', () => {
    expect(parseVersion('v2.3.0.4')).toMatchObject({ valid: true, core: ['2', '3', '0', '4'], prerelease: [] });
    expect(parseVersion('v1.39-nassaj')).toMatchObject({ valid: true, core: ['1', '39'], prerelease: ['nassaj'] });
    expect(parseVersion('1.39+build.7')).toMatchObject({ valid: true, core: ['1', '39'], prerelease: [] });
  });

  it('rejects malformed values instead of coercing them to zero', () => {
    for (const value of ['', ' ', 'nassaj', '1.x.3', '..', '1..2', '1.39-', 'v', null, undefined, 42]) {
      expect(parseVersion(value).valid, String(value)).toBe(false);
    }
  });
});

describe('compareVersions', () => {
  it('fixes the suffix regression that hid a newer release', () => {
    expect(compareVersions('1.39-nassaj', '1.38.0.1')).toBe(1);
    expect(compareVersions('v1.39-nassaj', '1.38.0.1')).toBe(1);
  });

  it('orders current four-part release versions numerically', () => {
    expect(compareVersions('2.3.0.4', '2.3.0.3')).toBe(1);
    expect(compareVersions('2.3.0.3', '2.3.0.4')).toBe(-1);
    expect(compareVersions('v2.3.0.4', '2.3.0.4')).toBe(0);
  });

  it('orders prerelease identifiers with SemVer precedence', () => {
    expect(compareVersions('1.39-rc.2', '1.39-rc.10')).toBe(-1);
    expect(compareVersions('1.39-rc.1', '1.39')).toBe(-1);
    expect(compareVersions('1.39', '1.39-rc.1')).toBe(1);
    expect(compareVersions('1.40-alpha', '1.39')).toBe(1);
  });

  it('orders numeric parts without Number rounding or Infinity', () => {
    expect(compareVersions('1.9007199254740993', '1.9007199254740992')).toBe(1);
    expect(compareVersions('1.0-rc.9007199254740993', '1.0-rc.9007199254740992')).toBe(1);
    expect(compareVersions(`1.0-rc.${'9'.repeat(400)}`, `1.0-rc.${'8'.repeat(400)}`)).toBe(1);
    expect(compareVersions('1.0000000000000000000002', '1.2')).toBe(0);
  });

  it('fails closed for a malformed offered version', () => {
    expect(compareVersions('not-a-version', '2.3.0.4')).toBe(-1);
    expect(compareVersions('2.3.0.4', 'not-a-version')).toBe(1);
  });

  it('is antisymmetric and transitive across representative labels', () => {
    for (const left of ASCENDING) {
      for (const right of ASCENDING) {
        expect(compareVersions(left, right) + compareVersions(right, left), `${left}/${right}`).toBe(0);
      }
    }
    for (let left = 0; left < ASCENDING.length; left += 1) {
      for (let right = left + 1; right < ASCENDING.length; right += 1) {
        expect(compareVersions(ASCENDING[left], ASCENDING[right])).toBe(-1);
      }
    }
  });
});
