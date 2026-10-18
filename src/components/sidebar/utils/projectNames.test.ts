import { describe, expect, it } from 'vitest';

import type { Project } from '../../../types/app';

import { cancelSessionReveal, consumeSessionReveal, requestSessionReveal } from './sessionReveal';
import { getProjectNameDisambiguators } from './utils';

const project = (projectId: string, displayName: string, fullPath: string): Project =>
  ({ projectId, displayName, fullPath }) as Project;

describe('getProjectNameDisambiguators (B-1668)', () => {
  it('gives two same-named checkouts their distinct folder', () => {
    const suffixes = getProjectNameDisambiguators([
      project('a', 'nassaj', '/home/user/Project/nassaj-dev'),
      project('b', 'nassaj', '/home/user/nassaj-online'),
      project('c', 'other', '/home/user/other'),
    ]);
    expect(suffixes.get('a')).toBe('nassaj-dev');
    expect(suffixes.get('b')).toBe('nassaj-online');
    expect(suffixes.has('c')).toBe(false);
  });

  it('adds the parent folder when the suffix would only repeat the name', () => {
    const suffixes = getProjectNameDisambiguators([
      project('a', 'nassaj', '/home/user/nassaj-online'),
      project('b', 'nassaj', '/opt/build/nassaj'),
    ]);
    expect(suffixes.get('a')).toBe('nassaj-online');
    expect(suffixes.get('b')).toBe('build/nassaj');
  });

  it('walks up the path when the leaf folders are identical', () => {
    const suffixes = getProjectNameDisambiguators([
      project('a', 'app', '/srv/alpha/app'),
      project('b', 'app', '/srv/beta/app'),
    ]);
    expect(suffixes.get('a')).toBe('alpha/app');
    expect(suffixes.get('b')).toBe('beta/app');
  });
});

describe('session reveal token', () => {
  it('is consumed once, only by its row, and expires', () => {
    requestSessionReveal('s1', 1_000);
    expect(consumeSessionReveal('s2', 1_000)).toBe(false);
    expect(consumeSessionReveal('s1', 1_000)).toBe(true);
    expect(consumeSessionReveal('s1', 1_000)).toBe(false);

    requestSessionReveal('s1', 1_000);
    expect(consumeSessionReveal('s1', 60_000)).toBe(false);

    requestSessionReveal('s1');
    cancelSessionReveal();
    expect(consumeSessionReveal('s1')).toBe(false);
  });
});
