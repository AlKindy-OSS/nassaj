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

  it('redirects the legacy ?settings=local-models deep link to agents + localModels', () => {
    expect(readSettingsDestination('?settings=local-models')).toEqual({
      tab: 'agents',
      localModels: true,
    });
  });

  it('reads ?settingsLocalModels=true on the agents tab', () => {
    expect(readSettingsDestination('?settings=agents&settingsLocalModels=true')).toEqual({
      tab: 'agents',
      localModels: true,
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

  it('writes settingsLocalModels and omits agent/category for the local-models card', () => {
    window.history.replaceState(null, '', '/session/one?projectId=p1');

    writeSettingsDestination({ tab: 'agents', localModels: true });
    expect(window.location.search).toBe('?projectId=p1&settings=agents&settingsLocalModels=true');

    clearSettingsDestination();
    expect(window.location.search).toBe('?projectId=p1');
  });

  it('keeps role-restricted settings URLs out of unavailable tabs', () => {
    expect(canOpenSettingsTab('users', 'user')).toBe(false);
    expect(canOpenSettingsTab('users', 'admin')).toBe(true);
    expect(canOpenSettingsTab('command-board', 'admin')).toBe(false);
    expect(canOpenSettingsTab('command-board', 'owner')).toBe(true);
  });

  // T-1866: the old ?settings=command-board deep link must keep opening
  // Command Board itself (role access / raw-exec / safe & custom commands) —
  // moving storage/tmpfs/permissions/auto-update out of it must not touch
  // this destination's own validity or role gate.
  it('T-1866: ?settings=command-board still opens Command Board unchanged', () => {
    expect(readSettingsDestination('?settings=command-board')).toEqual({ tab: 'command-board' });
    expect(canOpenSettingsTab('command-board', 'owner')).toBe(true);
    expect(canOpenSettingsTab('command-board', 'admin')).toBe(false);
  });

  it('T-1866: ?settings=system is a recognized deep link, owner-only like command-board', () => {
    expect(readSettingsDestination('?settings=system')).toEqual({ tab: 'system' });
    expect(canOpenSettingsTab('system', 'owner')).toBe(true);
    expect(canOpenSettingsTab('system', 'admin')).toBe(false);
    expect(canOpenSettingsTab('system', 'user')).toBe(false);
  });

  describe('B-1076: fenceFilter deep link (permission-fence outbox card)', () => {
    it('reads a well-formed filter on the system tab', () => {
      expect(readSettingsDestination('?settings=system&settingsFenceFilter=sess-abc_123')).toEqual({
        tab: 'system',
        fenceFilter: 'sess-abc_123',
      });
    });

    it.each([
      '<script>alert(1)</script>',
      'javascript:alert(1)',
      'x'.repeat(65),
      'a b',
      '../etc/passwd',
    ])('drops a malicious or oversized filter: %j', (poison) => {
      expect(readSettingsDestination(`?settings=system&settingsFenceFilter=${encodeURIComponent(poison)}`))
        .toEqual({ tab: 'system' });
    });

    it('ignores the filter on any tab other than system', () => {
      expect(readSettingsDestination('?settings=agents&settingsFenceFilter=sess-abc')).toEqual({ tab: 'agents' });
    });

    it('writes and clears settingsFenceFilter without leaking it onto other tabs', () => {
      window.history.replaceState(null, '', '/session/one?projectId=p1');

      writeSettingsDestination({ tab: 'system', fenceFilter: 'sess-abc' });
      expect(window.location.search).toBe('?projectId=p1&settings=system&settingsFenceFilter=sess-abc');

      writeSettingsDestination({ tab: 'agents' });
      expect(window.location.search).not.toContain('settingsFenceFilter');

      clearSettingsDestination();
      expect(window.location.search).toBe('?projectId=p1');
    });

    it('never writes a malicious filter into the URL', () => {
      window.history.replaceState(null, '', '/');
      writeSettingsDestination({ tab: 'system', fenceFilter: '<script>alert(1)</script>' });
      expect(window.location.search).toBe('?settings=system');
    });
  });
});
