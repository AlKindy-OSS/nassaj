/** ADR-173 P6: which providers let a member continue another member's conversation (mirrors the server, v1). */
import { describe, expect, it } from 'vitest';

import { getSharedWritingSupport } from './providerCapabilities';

describe('getSharedWritingSupport', () => {
  it('claude supports shared writing', () => {
    expect(getSharedWritingSupport('claude')).toBe('supported');
  });

  it.each(['codex', 'antigravity', 'opencode', 'dsh'])('%s is continued by its creator only', (provider) => {
    expect(getSharedWritingSupport(provider)).toBe('creator_only');
  });

  it('says nothing for providers the server does not refuse', () => {
    expect(getSharedWritingSupport('glm')).toBe('unknown');
    expect(getSharedWritingSupport(null)).toBe('unknown');
  });
});
