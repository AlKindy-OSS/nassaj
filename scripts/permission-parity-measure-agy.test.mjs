import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMeasuredAgyCandidate } from './permission-parity-measure-agy.mjs';

test('agy measurement remains non-parity until delegation, MCP, and connectors are mechanically denied', () => {
  const candidate = buildMeasuredAgyCandidate({
    measuredAt: '2026-09-01T00:00:00.000Z', buildFingerprint: `sha256:${'a'.repeat(64)}`,
    observation: { readHost: true, writeHost: true, processHost: true, networkExternal: true, noApproval: true },
  });
  assert.equal(candidate.dimensions.filesystem_write.scope, 'host');
  assert.equal(candidate.dimensions.mcp.decision, 'allow');
  assert.deepEqual(candidate.deniedSurfaces, []);
  assert.throws(() => buildMeasuredAgyCandidate({
    measuredAt: '2026-09-01T00:00:00.000Z', buildFingerprint: `sha256:${'a'.repeat(64)}`,
    observation: { readHost: true },
  }), /PERMISSION_AGY_MEASUREMENT_INCOMPLETE/u);
});
