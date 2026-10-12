/**
 * Client/server parity for what a Claude subscription token looks like.
 *
 * The server decides where a value goes by this definition, and the vendor card
 * decides which refusal text to show by it. Drift between the two is not a
 * visible bug but a false money claim on screen, so every reader must go
 * through the one shared definition (ADR-200 S1, L2) and none may own a literal.
 *
 * RUNNER: vitest (`npm run test:client`) — node reads, no DOM.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isClaudeSubscriptionToken } from '../../../../../../shared/claudeSubscriptionToken';

const root = path.resolve(__dirname, '../../../../../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('subscription-token definition', () => {
  it('recognises every oat generation, with surrounding whitespace, and nothing else', () => {
    expect(isClaudeSubscriptionToken('sk-ant-oat01-abc')).toBe(true);
    expect(isClaudeSubscriptionToken('  sk-ant-oat02-abc ')).toBe(true);
    expect(isClaudeSubscriptionToken('sk-ant-api03-abc')).toBe(false);
    expect(isClaudeSubscriptionToken('')).toBe(false);
  });

  it('is read from shared/ by the server writer, the guard and the card hook', () => {
    // A code literal: a quoted string or a regex source. Comments may still name the prefix.
    const literal = /['"]sk-ant-oat|\/\^sk-ant-oat/;
    expect(read('shared/claudeSubscriptionToken.ts')).toMatch(literal);
    const readers = [
      'server/modules/providers/list/claude/claude-credentials.writer.ts',
      'server/modules/providers/shared/credentials/subscription-token-guard.ts',
      'src/components/settings/view/tabs/vendors-settings/useVendorCardActions.ts',
    ];
    for (const file of readers) {
      const source = read(file);
      expect(source, `${file} defines its own token literal`).not.toMatch(literal);
      expect(source, `${file} does not read the shared definition`).toMatch(
        /isClaudeSubscriptionToken|SUBSCRIPTION_TOKEN_(PREFIX|PATTERN)/,
      );
    }
  });
});
