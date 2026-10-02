/**
 * engine-carrier-survival.reviewer.test.ts — tripwire: the mechanical supervisor
 * can still send the REVIEW of a turn to a configured vendor (kimi / glm /
 * deepseek) after those ids are deleted as agent bodies.
 *
 * The reviewer target is resolved inside the runtime; it is observed here through
 * its effect on `preflight`: with a vendor reviewer configured, the credential
 * that gets probed — and whose absence blocks the turn — is that vendor's, not
 * the Claude fallback reviewer's. No adapter dispatches and nothing is spawned.
 *
 * Runner: node:test (`npm run test:server -- <this file>`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VENDOR_RUNTIME } from '@/modules/providers/index.js';

import { createClaudeSdkTurnAdapter } from './adapters/claude-sdk-adapter.js';
import { createHostedVendorAdapter } from './adapters/hosted-vendor-adapter.js';
import { HostedTurnSupervisorRuntime } from './hosted-turn-supervisor.service.js';

const ENGINES = ['kimi', 'glm', 'deepseek'] as const;

describe('mechanical supervisor: a configured vendor reviewer is still the review target', () => {
  /** An armed Claude cell whose review is routed to `reviewProvider`. */
  function runtimeWithReviewer(reviewProvider: (typeof ENGINES)[number], credential: string | null) {
    const probed: string[] = [];
    const hosted = createHostedVendorAdapter({
      resolveCredential: (provider) => {
        probed.push(provider);
        return credential;
      },
      fetchImpl: async () => { throw new Error('preflight must not dispatch'); },
    });
    const claude = createClaudeSdkTurnAdapter({
      enabled: () => true,
      getAuthStatus: async () => ({ installed: true, authenticated: true }),
      resolveEnvironment: () => ({ PATH: process.env.PATH }),
      queryFactory: () => { throw new Error('preflight must not spawn Claude'); },
    });
    const runtime = new HostedTurnSupervisorRuntime({
      NASSAJ_TURN_SUPERVISOR_CLAUDE_CHAT_SDK_MECHANICAL: '1',
      [`NASSAJ_TURN_SUPERVISOR_${reviewProvider.toUpperCase()}_CHAT`]: '1',
      NASSAJ_TURN_SUPERVISOR_REVIEW_PROVIDER: reviewProvider,
      NASSAJ_TURN_SUPERVISOR_REVIEW_MODEL: VENDOR_RUNTIME[reviewProvider].fallbackModels.DEFAULT,
    }, hosted, claude);
    return { runtime, probed };
  }

  const reviewTurn = {
    provider: 'claude', mode: 'chat', coordinationLevel: 'delegate_review', model: 'sonnet', userId: 7,
  } as const;

  for (const engine of ENGINES) {
    it(`routes the review of a Claude turn to ${engine} and requires its credential`, async () => {
      const keyed = runtimeWithReviewer(engine, 'secret');
      assert.equal(keyed.runtime.supports(reviewTurn), true);
      assert.equal(await keyed.runtime.preflight(reviewTurn), true);
      assert.deepEqual(keyed.probed, [engine], 'the reviewer probed is the configured vendor');

      const keyless = runtimeWithReviewer(engine, null);
      assert.equal(
        await keyless.runtime.preflight(reviewTurn),
        false,
        'with the vendor reviewer configured, its missing credential must block the turn',
      );
      assert.deepEqual(keyless.probed, [engine]);
    });
  }

  it('the default reviewer adapter reads the credential through the vendor key variable', () => {
    for (const engine of ENGINES) {
      assert.match(VENDOR_RUNTIME[engine].keyEnv, /^(KIMI|DEEPSEEK|GLM)_API_KEY$/);
      assert.match(VENDOR_RUNTIME[engine].messagesUrl, /^https:\/\//);
    }
  });
});
