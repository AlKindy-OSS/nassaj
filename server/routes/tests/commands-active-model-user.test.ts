/**
 * B-1752: `/models` and `/status` read the active model from the CALLER's session store.
 * resolveCommandModel already holds the authenticated user id; it must hand that id
 * to getCurrentActiveModel, or an isolated member's model is read from the operator.
 */
// B-1544: must stay the first app-side import (HOME, DATABASE_PATH, harness roots).
import { removeSandbox } from '../../modules/providers/tests/helpers/hermetic-sandbox.js';
import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';

const url = (relativePath: string) => new URL(relativePath, import.meta.url).href;

const realAccess = await import(`${url('../../modules/providers/services/session-access.js')}?real`);
mock.module(url('../../modules/providers/services/session-access.js'), {
  namedExports: { ...realAccess, isSessionAccessibleByUser: () => true },
});

const { executeModelsCommand } = await import('../commands.js');
const { providerModelsService } = await import('../../modules/providers/services/provider-models.service.js');
const { sessionsDb } = await import('../../modules/database/index.js');

after(() => {
  mock.restoreAll();
  removeSandbox();
});

test('B-1752: the models command reads the active model with the caller user id', async () => {
  const calls: unknown[][] = [];
  mock.method(sessionsDb, 'getSessionById', () => ({ session_id: 'ses-1752', project_path: '/p' }));
  mock.method(providerModelsService, 'getProviderModels', async () => ({
    models: { OPTIONS: [{ value: 'opencode/a', label: 'a' }], DEFAULT: 'opencode/a' },
    cache: { updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-04T00:00:00.000Z', source: 'fresh' },
  }));
  mock.method(providerModelsService, 'getCurrentActiveModel', async (...args: unknown[]) => {
    calls.push(args);
    return { model: 'opencode/b' };
  });

  const result = await executeModelsCommand([], { provider: 'opencode', sessionId: 'ses-1752', userId: 7 });

  assert.deepEqual(calls, [['opencode', 'ses-1752', 7]]);
  assert.equal(result.data.current.model, 'opencode/b');
});
