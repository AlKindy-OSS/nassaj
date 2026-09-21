import { afterEach, describe, expect, it } from 'vitest';

import {
  canOpenSettingsTab,
  clearSettingsDestination,
  readSettingsDestination,
  writeSettingsDestination,
} from './settingsUrl';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('settings URL destination', () => {
  it('reads a validated main tab and agent surface from a shared URL', () => {
    expect(readSettingsDestination('?settings=agents&settingsAgent=codex&settingsCategory=permissions')).toEqual({
      tab: 'agents',
      agent: 'codex',
      category: 'permissions',
    });
  });

  it('keeps malformed tab parameters from opening an arbitrary surface', () => {
    expect(readSettingsDestination('?settings=unknown&settingsAgent=codex')).toBeUndefined();
    expect(readSettingsDestination('?settings=agents&settingsAgent=unknown&settingsCategory=unknown')).toEqual({
      tab: 'agents',
    });
  });

  it('writes and clears only settings parameters', () => {
    window.history.replaceState(null, '', '/session/one?projectId=p1');

    writeSettingsDestination({ tab: 'agents', agent: 'claude', category: 'account' });
    expect(window.location.search).toBe(
      '?projectId=p1&settings=agents&settingsAgent=claude&settingsCategory=account',
    );

    clearSettingsDestination();
    expect(window.location.search).toBe('?projectId=p1');
  });

  it('keeps role-restricted settings URLs out of unavailable tabs', () => {
    expect(canOpenSettingsTab('users', 'user')).toBe(false);
    expect(canOpenSettingsTab('users', 'admin')).toBe(true);
    expect(canOpenSettingsTab('command-board', 'admin')).toBe(false);
    expect(canOpenSettingsTab('command-board', 'owner')).toBe(true);
  });
});
