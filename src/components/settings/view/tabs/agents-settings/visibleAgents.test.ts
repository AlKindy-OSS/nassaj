import { describe, expect, it } from 'vitest';
import { visibleSettingsAgents } from './visibleAgents';

describe('visibleSettingsAgents (T-1760 order)', () => {
  it('orders tiles by each company’s first generative-AI release', () => {
    expect(visibleSettingsAgents()).toEqual([
      'antigravity', 'codex', 'claude', 'dsh', 'opencode',
    ]);
  });

  it('hides globally disabled providers that are not coming-soon', () => {
    const agents = visibleSettingsAgents();
    expect(agents).not.toContain('glm');
    // hermes: disabled 2026-09-28 (owner decision), not a coming-soon tile.
    expect(agents).not.toContain('hermes');
    // qwen: disabled 2026-09-28 (owner decision), key to move to the OpenCode carrier.
    expect(agents).not.toContain('qwen');
    // cursor, kimi, and legacy deepseek API body stay hidden; DSH is the active harness.
    for (const hidden of ['cursor', 'kimi', 'deepseek']) expect(agents).not.toContain(hidden);
    expect(agents).toContain('dsh');
  });
});
