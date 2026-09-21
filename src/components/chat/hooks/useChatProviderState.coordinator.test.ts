/**
 * T-886 (revert) — يؤكّد أن وضع coordinator غُيِّل من Codex
 *
 * يغطّي:
 *   - أوضاع codex ثلاثة فقط (default / acceptEdits / bypassPermissions)
 *   - 'coordinator' غائب عن كل المزوّدين
 *
 * Run: npm run test:client -- src/components/chat/hooks/useChatProviderState.coordinator.test.ts
 */

import { describe, it, expect } from 'vitest';
import { getPermissionModesForProvider } from './useChatProviderState';

describe('getPermissionModesForProvider — no coordinator mode', () => {
  it('codex cycle contains exactly the three expected modes', () => {
    const modes = getPermissionModesForProvider('codex');
    expect(modes).toEqual(['default', 'acceptEdits', 'bypassPermissions']);
  });

  it('coordinator is absent from codex', () => {
    expect(getPermissionModesForProvider('codex')).not.toContain('coordinator');
  });

  it('coordinator is absent from claude', () => {
    expect(getPermissionModesForProvider('claude')).not.toContain('coordinator');
  });

  it('coordinator is absent from gemini', () => {
    expect(getPermissionModesForProvider('gemini')).not.toContain('coordinator');
  });

  it('coordinator is absent from cursor', () => {
    expect(getPermissionModesForProvider('cursor')).not.toContain('coordinator');
  });

  it('coordinator is absent from opencode', () => {
    expect(getPermissionModesForProvider('opencode')).not.toContain('coordinator');
  });
});
