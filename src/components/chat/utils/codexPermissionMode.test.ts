import { describe, expect, it } from 'vitest';
import {
  applyPendingCodexPermissionStamp, clearPendingCodexPermissionStamp, writePendingCodexPermissionStamp,
  initialComposerPermissionMode, readCodexSettingsPermissionMode } from './codexPermissionMode';

const settings = (permissionMode: unknown) => JSON.stringify({ permissionMode });

describe('codex settings permission mode (B-472)', () => {
  it('reads valid stored modes', () => {
    expect(readCodexSettingsPermissionMode(settings('acceptEdits'))).toBe('acceptEdits');
    expect(readCodexSettingsPermissionMode(settings('bypassPermissions'))).toBe('bypassPermissions');
  });
  it('falls back to default for missing, corrupt, unknown or plan', () => {
    expect(readCodexSettingsPermissionMode(null)).toBe('default');
    expect(readCodexSettingsPermissionMode('{bad')).toBe('default');
    expect(readCodexSettingsPermissionMode(settings('root'))).toBe('default');
    expect(readCodexSettingsPermissionMode(settings('plan'))).toBe('default');
  });
  it('seeds only Codex from Settings', () => {
    expect(initialComposerPermissionMode('codex', settings('acceptEdits'))).toBe('acceptEdits');
    expect(initialComposerPermissionMode('claude', settings('acceptEdits'))).toBe('default');
  });
});

describe('pending stamp binding (B-472)', () => {
  it('requires a clientMsgId to write and to apply; clear drops it', () => {
    sessionStorage.clear(); localStorage.clear();
    writePendingCodexPermissionStamp('default', null);
    expect(applyPendingCodexPermissionStamp('s', 'x')).toBeNull();
    writePendingCodexPermissionStamp('acceptEdits', 'c1');
    clearPendingCodexPermissionStamp();
    expect(applyPendingCodexPermissionStamp('s', 'c1')).toBeNull();
    writePendingCodexPermissionStamp('acceptEdits', 'c1');
    expect(applyPendingCodexPermissionStamp('s', 'c1')).toBe('acceptEdits');
    expect(localStorage.getItem('permissionMode-s')).toBe('acceptEdits');
  });
});
