import { describe, expect, it } from 'vitest';

import { resolveSendProvider } from './resolveSendProvider';

describe('resolveSendProvider (B-167 cross-provider sealing)', () => {
  it('uses the global selection for a brand-new conversation', () => {
    // Requirement 3: a new chat inherits the current picker choice at creation.
    expect(resolveSendProvider(false, 'claude', 'opencode')).toBe('opencode');
    expect(resolveSendProvider(false, null, 'claude')).toBe('claude');
  });

  it('seals a resumed conversation to its own provider, ignoring the global drift', () => {
    // Requirement 1: opening an existing OpenCode session and sending while the
    // global selection has drifted to Claude must still dispatch OpenCode.
    expect(resolveSendProvider(true, 'opencode', 'claude')).toBe('opencode');
    expect(resolveSendProvider(true, 'hermes', 'antigravity')).toBe('hermes');
    expect(resolveSendProvider(true, 'claude', 'opencode')).toBe('claude');
  });

  it('falls back to the global provider on resume when the session provider is unknown', () => {
    // A session just minted in this view has no __provider yet; the global
    // selection is exactly the provider it was created under.
    expect(resolveSendProvider(true, null, 'opencode')).toBe('opencode');
    expect(resolveSendProvider(true, undefined, 'claude')).toBe('claude');
  });
});
