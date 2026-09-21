import { describe, expect, it } from 'vitest';

import {
  readSessionWorkspaceGeneration,
  rememberSessionWorkspaceGeneration,
} from './sessionWorkspaceBinding';

describe('session workspace generation binding', () => {
  it('stores and reads only a non-empty server generation under its session', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(rememberSessionWorkspaceGeneration(' session-1 ', ' generation-1 ', storage)).toBe(true);
    expect(readSessionWorkspaceGeneration('session-1', storage)).toBe('generation-1');
    expect(readSessionWorkspaceGeneration('session-2', storage)).toBeNull();
    expect(rememberSessionWorkspaceGeneration('session-1', '', storage)).toBe(false);
    expect(readSessionWorkspaceGeneration('session-1', storage)).toBe('generation-1');
  });
});
