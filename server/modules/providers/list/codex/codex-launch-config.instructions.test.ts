/**
 * T-2107: the Codex launch config carries the per-turn slot as `developer_instructions`,
 * on a cloud chat and on a local-engine chat (whose overrides are applied last), so
 * Nassaj's runtime instructions (document sharing included) always reach Codex.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { codexLocalConfig } from '../../../../services/isolation/apply-codex-local-engine-env.js';
import { DOCUMENT_SHARING_INSTRUCTIONS, getRuntimeInstructions } from '../../../../../shared/documentSharingInstructions.js';

import { composeCodexLaunchConfig } from './codex-launch-config.js';

test('the composed Codex launch config delivers the runtime instructions, local runs included', () => {
  const instructions = getRuntimeInstructions('delegate');
  const local = codexLocalConfig({ connectOrigin: 'http://192.168.8.137:8080', contextWindow: 32768 } as never);
  for (const localConfig of [null, local]) {
    const config = composeCodexLaunchConfig({ multiAgentConfig: {}, developerInstructions: instructions, sandboxMode: 'read-only',
      docsWritableRoots: [], localConfig });
    assert.equal(config.developer_instructions, instructions, localConfig ? 'local run' : 'cloud run');
    assert.ok(String(config.developer_instructions).includes(DOCUMENT_SHARING_INSTRUCTIONS.slice(0, 40)));
  }
});
