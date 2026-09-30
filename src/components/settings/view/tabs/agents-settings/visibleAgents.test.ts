import { describe, expect, it } from 'vitest';
import { visibleSettingsAgents } from './visibleAgents';

describe('visibleSettingsAgents (T-1760 order)', () => {
  it('orders tiles by each company’s first generative-AI release', () => {
    expect(visibleSettingsAgents()).toEqual([
      'antigravity', 'codex', 'claude', 'opencode',
    ]);
  });

  it('hides globally disabled providers that are not coming-soon', () => {
    const agents = visibleSettingsAgents();
    expect(agents).not.toContain('glm');
    // hermes: disabled 2026-09-28 (owner decision), not a coming-soon tile.
    expect(agents).not.toContain('hermes');
    // qwen: disabled 2026-09-28 (owner decision), key to move to the OpenCode carrier.
    expect(agents).not.toContain('qwen');
    // cursor, kimi, deepseek: hidden 2026-09-29 (owner decision).
    for (const hidden of ['cursor', 'kimi', 'deepseek']) expect(agents).not.toContain(hidden);
  });
});
