import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConnectorPlacementInput,
  mcpServerNameFor,
} from '@/modules/connectors/connector-placement-definition.js';

test('connector placement name is stable and namespaced', () => {
  assert.equal(mcpServerNameFor({ id: 'google-work' }), 'nassaj-connector-google-work');
});

test('stdio placement builds the exact canonical non-secret MCP input', () => {
  const args = ['--yes', '@scope/server@1.2.3'];
  const env = { REGION: 'me-central1' };
  assert.deepEqual(buildConnectorPlacementInput(
    { id: 'stdio-account' },
    17,
    { transport: 'stdio', command: 'npx', args, env },
  ), {
    name: 'nassaj-connector-stdio-account',
    scope: 'user',
    userId: 17,
    transport: 'stdio',
    command: 'npx',
    args,
    env,
  });
  assert.notEqual(buildConnectorPlacementInput(
    { id: 'stdio-account' }, 17,
    { transport: 'stdio', command: 'npx', args, env },
  ).args, args);
});

test('http placement contains endpoint and non-secret headers without credential invention', () => {
  assert.deepEqual(buildConnectorPlacementInput(
    { id: 'http-account' },
    23,
    { transport: 'http', url: 'https://mcp.example.test', headers: { 'X-Tenant': 'public-id' } },
  ), {
    name: 'nassaj-connector-http-account',
    scope: 'user',
    userId: 23,
    transport: 'http',
    url: 'https://mcp.example.test',
    headers: { 'X-Tenant': 'public-id' },
  });
});
