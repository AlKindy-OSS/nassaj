/**
 * deepseek-body-removed.test.ts — T-2088.
 *
 * The id `deepseek` names four different things. Only ONE of them — the dormant
 * standalone body launcher (`server/deepseek-cli.js`, `spawnDeepSeek` over the
 * vendor runtime) — is deleted. The other three stay live and are pinned here:
 *
 *   - the ENGINE under the Claude body (B-424, ADR-073): endpoint allow-list,
 *     eligibility, and the `/api/providers/deepseek/models` catalog facet;
 *   - the OpenCode `deepseek/*` spawn-vendor routing (ADR-200 S8);
 *   - the `deepseek` vendor KEY SLOT (ADR-200), which a later `dsh` body reuses.
 *
 * The hosted turn supervisor still drives `deepseek-command` turns without the
 * body launcher (see chat-websocket.hosted-turn-supervisor.integration.test.ts),
 * and historical sessions stay readable through the registry.
 *
 * Runner: node:test (`npm run test:server -- server/deepseek-body-removed.test.ts`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { CREDENTIAL_PREDICATES } from '@/services/isolation/credential-gate.js';
import {
  DEEPSEEK_OPENCODE_BASE_URL,
  OPENCODE_SPAWN_VENDORS,
  spawnVendorOfModel,
} from '@/services/isolation/opencode-spawn-vendor.js';
import { VENDOR_SECRET_PROVIDERS } from '@/services/isolation/provider-secrets-store.js';

import { isProviderGloballyDisabled } from '../shared/disabledProviders.js';
import { ELIGIBLE_ENGINE_PROVIDERS, ENGINE_ANTHROPIC_ENDPOINT } from '../shared/engineProviders.js';
import { RETIRED_PROVIDER_IDS } from '../shared/retiredProviders.js';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const readServer = (relative: string) => fs.readFileSync(path.join(serverRoot, relative), 'utf8');

describe('kept: deepseek as an engine, a spawn vendor and a key slot', () => {
  it('stays an eligible Claude engine on its Anthropic-compatible endpoint', () => {
    assert.equal(ENGINE_ANTHROPIC_ENDPOINT.deepseek, 'https://api.deepseek.com/anthropic');
    assert.ok((ELIGIBLE_ENGINE_PROVIDERS as readonly string[]).includes('deepseek'));
  });

  it('keeps the engine model catalog and the history reader registered', () => {
    const provider = providerRegistry.resolveProvider('deepseek');
    assert.equal(typeof provider.models.getSupportedModels, 'function');
    assert.equal(typeof providerRegistry.resolveHistorySessions('deepseek').fetchHistory, 'function');
  });

  it('keeps OpenCode deepseek/* routing on the DeepSeek vendor row', () => {
    const row = spawnVendorOfModel('deepseek/deepseek-v4-pro');
    assert.equal(row, OPENCODE_SPAWN_VENDORS.deepseek);
    assert.ok(row);
    assert.equal(DEEPSEEK_OPENCODE_BASE_URL, 'https://api.deepseek.com/v1');
  });

  it('keeps the deepseek vendor key slot and its credential predicate', () => {
    assert.ok((VENDOR_SECRET_PROVIDERS as readonly string[]).includes('deepseek'));
    assert.equal(typeof (CREDENTIAL_PREDICATES as Record<string, unknown>).deepseek, 'function');
  });

  it('stays disabled, not retired (retiring it is an open owner decision)', () => {
    assert.equal(isProviderGloballyDisabled('deepseek'), true);
    assert.equal(RETIRED_PROVIDER_IDS.has('deepseek'), false);
  });
});

describe('removed: the standalone deepseek body launcher', () => {
  it('has no launcher file', () => {
    assert.equal(fs.existsSync(path.join(serverRoot, 'deepseek-cli.js')), false);
  });

  it('is wired into neither the server composition nor the chat dispatcher', () => {
    const wiring = /deepseek-cli|spawnDeepSeek|abortDeepSeekSession|isDeepSeekSessionActive|getActiveDeepSeekSessions/;
    for (const file of ['index.js', 'modules/websocket/services/chat-websocket.service.ts']) {
      assert.doesNotMatch(readServer(file), wiring, `${file} still wires the deepseek body`);
    }
  });
});
