import { describe, expect, it } from 'vitest';
import { visibleSettingsAgents } from './visibleAgents';

describe('visibleSettingsAgents (T-1760 order)', () => {
  it('orders tiles by each company’s first generative-AI release', () => {
    expect(visibleSettingsAgents()).toEqual([
      'antigravity', 'codex', 'cursor', 'claude', 'qwen', 'hermes', 'kimi', 'deepseek', 'opencode',
    ]);
  });

  it('keeps the coming-soon deepseek tile in its dated slot, not appended last', () => {
    const agents = visibleSettingsAgents();
    expect(agents.indexOf('deepseek')).toBe(agents.indexOf('kimi') + 1);
    expect(agents.at(-1)).toBe('opencode');
  });

  it('hides globally disabled providers that are not coming-soon', () => {
    const agents = visibleSettingsAgents();
    expect(agents).not.toContain('glm');
  });
});
