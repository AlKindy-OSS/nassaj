/**
 * denyRuleSeverity.test.ts — B-1278: the client's severity split must track the
 * server's denylist exactly.
 *
 * The server module is read as TEXT, never imported: importing it opens the
 * application database. The block between `export const RAW_DENY_RULES` and its
 * closing `]);` is the only source of rule codes and of their order.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DENIED_COMMAND_DEFAULTS,
  DISCRETIONARY_DENY_RULES,
  FATAL_DENY_RULES,
  deniedCommandMessage,
  deniedCommandMessageKey,
  deniedCommandRule,
} from './denyRuleSeverity';
import { rawDenyRuleCodesInOrder } from './rawDenyRuleCodes.testutil';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../..');

/** Rule codes in the order the server evaluates them (duplicates kept). */
function serverRuleCodesInOrder(): string[] {
  return rawDenyRuleCodesInOrder(
    readFileSync(resolve(REPO, 'server/services/command-board-raw.js'), 'utf8'),
  );
}

describe('B-1278 — client severity matches the server denylist', () => {
  const ordered = serverRuleCodesInOrder();
  const unique = [...new Set(ordered)];

  it('extracts a non-trivial rule list (the regex still matches)', () => {
    expect(unique.length).toBeGreaterThanOrEqual(8);
    expect(unique).toContain('pm2_lifecycle');
  });

  it('classifies every server rule in exactly one category', () => {
    const unclassified = unique.filter(
      (c) => FATAL_DENY_RULES.has(c) === DISCRETIONARY_DENY_RULES.has(c),
    );
    expect(unclassified).toEqual([]);
  });

  it('classifies no rule the server does not have', () => {
    const known = new Set(unique);
    const stale = [...FATAL_DENY_RULES, ...DISCRETIONARY_DENY_RULES].filter((c) => !known.has(c));
    expect(stale).toEqual([]);
  });

  it('evaluates every fatal rule before any discretionary one (first match wins)', () => {
    const lastFatal = ordered.reduce((acc, c, i) => (FATAL_DENY_RULES.has(c) ? i : acc), -1);
    const firstDiscretionary = ordered.findIndex((c) => DISCRETIONARY_DENY_RULES.has(c));
    expect(lastFatal).toBeGreaterThan(-1);
    expect(firstDiscretionary).toBeGreaterThan(-1);
    expect(lastFatal, `order: ${ordered.join(', ')}`).toBeLessThan(firstDiscretionary);
  });
});

describe('B-1278 — deniedCommandMessageKey', () => {
  it('gives a fatal rule the fatal wording', () => {
    expect(deniedCommandMessageKey('denied_command:pm2_lifecycle')).toBe('denied_command_fatal');
    expect(deniedCommandMessageKey('denied_command:host_power')).toBe('denied_command_fatal');
  });

  it('gives a discretionary rule the weaker wording', () => {
    expect(deniedCommandMessageKey('denied_command:systemctl_lifecycle')).toBe('denied_command');
  });

  it('never claims a server outage for an unknown rule', () => {
    expect(deniedCommandMessageKey('denied_command:brand_new_rule')).toBe('denied_command');
  });

  it('falls back to the weaker wording for malformed input', () => {
    expect(deniedCommandMessageKey('denied_command:')).toBe('denied_command');
    expect(deniedCommandMessageKey('')).toBe('denied_command');
    expect(deniedCommandMessageKey('pm2_lifecycle:denied_command')).toBe('denied_command');
    expect(deniedCommandMessageKey('denied_command:PM2_LIFECYCLE')).toBe('denied_command');
  });

  it('extracts the rule only from a denylist code', () => {
    expect(deniedCommandRule('denied_command:kill_mass')).toBe('kill_mass');
    expect(deniedCommandRule('denied_command:')).toBe('');
    expect(deniedCommandRule('internal')).toBeNull();
  });

  it('keeps a severity-specific English fallback for each key', () => {
    for (const text of Object.values(DENIED_COMMAND_DEFAULTS)) {
      expect(text).toContain('{{rule}}');
      expect(text.toLowerCase()).toContain('terminal');
    }
    expect(DENIED_COMMAND_DEFAULTS.denied_command).not.toBe(DENIED_COMMAND_DEFAULTS.denied_command_fatal);
  });
});

describe('B-1278 — deniedCommandMessage', () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const t = (key: string, options: Record<string, unknown>) => {
    calls.push([key, options]);
    return `T(${key})`;
  };

  it('returns null for a code that is not a denylist refusal, without translating', () => {
    calls.length = 0;
    expect(deniedCommandMessage(t, 'internal', 'base')).toBeNull();
    expect(deniedCommandMessage(t, 'pm2_lifecycle', 'base')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('resolves a fatal rule under the given key base with its rule and fallback', () => {
    calls.length = 0;
    expect(deniedCommandMessage(t, 'denied_command:pm2_lifecycle', 'codeBlock.insertError'))
      .toBe('T(codeBlock.insertError.denied_command_fatal)');
    expect(calls).toEqual([[
      'codeBlock.insertError.denied_command_fatal',
      { rule: 'pm2_lifecycle', defaultValue: DENIED_COMMAND_DEFAULTS.denied_command_fatal },
    ]]);
  });

  it('gives discretionary, unknown and empty rules the weaker wording', () => {
    for (const [code, rule] of [
      ['denied_command:systemctl_lifecycle', 'systemctl_lifecycle'],
      ['denied_command:brand_new_rule', 'brand_new_rule'],
      ['denied_command:', ''],
    ]) {
      calls.length = 0;
      deniedCommandMessage(t, code, 'a.b');
      expect(calls).toEqual([[
        'a.b.denied_command',
        { rule, defaultValue: DENIED_COMMAND_DEFAULTS.denied_command },
      ]]);
    }
  });
});
