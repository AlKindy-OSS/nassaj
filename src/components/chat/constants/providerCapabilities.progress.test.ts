/**
 * ADR-199 Decision 5: every server-registered provider declares its progress
 * capability explicitly, and the list matches provider.registry.ts.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getProgressCapability, getProviderCapabilities } from './providerCapabilities';

const EXPECTED = {
  claude: { plan: 'live', subagents: 'live' },
  codex: { plan: 'live', subagents: 'live' },
  antigravity: { plan: 'turn', subagents: 'turn' },
  opencode: { plan: 'live', subagents: 'turn' },
  kimi: { plan: 'none', subagents: 'none' },
  qwen: { plan: 'none', subagents: 'none' },
  cursor: { plan: 'none', subagents: 'none' },
  deepseek: { plan: 'none', subagents: 'none' },
  glm: { plan: 'none', subagents: 'none' },
} as const;

/** Provider ids registered in the server's `providers` map. */
function registeredProviderIds(): string[] {
  const source = readFileSync(path.resolve(process.cwd(), 'server/modules/providers/provider.registry.ts'), 'utf8');
  const block = /const providers:[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/^\s*([a-z]+):\s*new\s/gm)].map((m) => m[1]).sort();
}

describe('progress capability (ADR-199)', () => {
  it('covers exactly the registered providers', () => {
    const registered = registeredProviderIds();
    expect(registered.length).toBeGreaterThan(0);
    expect(registered).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s declares its progress signals', (id, expected) => {
    expect(getProgressCapability(id)).toEqual(expected);
    expect(getProviderCapabilities(id).progress).toEqual(expected);
  });

  it('an unknown provider declares none/none', () => {
    expect(getProviderCapabilities('future-body').progress).toEqual({ plan: 'none', subagents: 'none' });
    expect(getProgressCapability('toString')).toEqual({ plan: 'none', subagents: 'none' });
  });
});
