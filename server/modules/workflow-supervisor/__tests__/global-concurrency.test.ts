/**
 * T-820 — the HOST-WIDE concurrency gate (§ج-5, الشرط 7). The per-user cap alone
 * cannot bound total host memory; this second gate counts ALL active scopes and
 * QUEUES (never OOM, never silent-drop) an (N+1)th launch. Fail-closed: a
 * throwing lister is treated as at-capacity.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { admitLaunchGlobal } from '@/modules/workflow-supervisor/concurrency.js';
import { processIntent, type ProcessIntentDeps } from '@/modules/workflow-supervisor/supervisor-core.js';

const goodIntent = {
  wfLaunchId: 'g-1',
  userId: 5,
  projectPath: '/tmp/proj',
  scriptOrPrompt: 'do it',
  requestedAt: new Date().toISOString(),
};

test('admitLaunchGlobal: ADMIT strictly below the cap', async () => {
  const res = await admitLaunchGlobal(async () => ['a.service', 'b.service'], {
    WORKFLOW_SUPERVISOR_MAX_GLOBAL: '3',
  });
  assert.equal(res.admit, true);
  if (res.admit) assert.equal(res.active, 2);
});

test('admitLaunchGlobal: DENY at the cap (queue, do not OOM)', async () => {
  const res = await admitLaunchGlobal(async () => ['a.service', 'b.service', 'c.service'], {
    WORKFLOW_SUPERVISOR_MAX_GLOBAL: '3',
  });
  assert.equal(res.admit, false);
  if (!res.admit) assert.match(res.reason, /global concurrency cap reached \(3\/3\)/);
});

test('admitLaunchGlobal: a THROWING lister fails CLOSED (deny, treated as saturated)', async () => {
  const res = await admitLaunchGlobal(async () => {
    throw new Error('systemctl blip');
  }, { WORKFLOW_SUPERVISOR_MAX_GLOBAL: '3' });
  assert.equal(res.admit, false);
  if (!res.admit) assert.match(res.reason, /fail-closed deny/);
});

test('admitLaunchGlobal: default cap is a conservative 8 when unset', async () => {
  const under = await admitLaunchGlobal(async () => new Array(7).fill('x.service'), {});
  assert.equal(under.admit, true);
  const at = await admitLaunchGlobal(async () => new Array(8).fill('x.service'), {});
  assert.equal(at.admit, false);
});

// --- processIntent wiring: the global gate is applied AFTER the per-user gate --

function deps(over: Partial<ProcessIntentDeps> = {}): {
  deps: ProcessIntentDeps;
  launched: string[];
} {
  const launched: string[] = [];
  const base: ProcessIntentDeps = {
    authorize: {
      isOwnedOrMembered: () => true,
      resolveEnv: (userId) => ({ CLAUDE_CONFIG_DIR: `/x/${userId}` }),
    },
    listActiveScopes: async () => [], // per-user under cap
    launchScope: async ({ intent }) => {
      launched.push(intent.wfLaunchId);
      return `wf-${intent.wfLaunchId}.service`;
    },
    writeRecord: async () => {},
    env: {},
    ...over,
  };
  return { deps: base, launched };
}

test('processIntent: per-user OK but GLOBAL cap full => queued, NOT launched', async () => {
  const { deps: d, launched } = deps({
    listAllActiveScopes: async () => ['a.service', 'b.service'],
    env: { WORKFLOW_SUPERVISOR_MAX_GLOBAL: '2' }, // full at 2
  });
  const out = await processIntent(goodIntent, d);
  assert.equal(out.status, 'queued');
  assert.equal(launched.length, 0, 'a globally-capped intent must not launch');
});

test('processIntent: global gate skipped when no host-wide lister is injected (per-user only)', async () => {
  const { deps: d, launched } = deps(); // no listAllActiveScopes
  const out = await processIntent(goodIntent, d);
  assert.equal(out.status, 'launched');
  assert.deepEqual(launched, ['g-1']);
});

test('processIntent: global gate ALLOWS below cap and launches', async () => {
  const { deps: d, launched } = deps({
    listAllActiveScopes: async () => ['a.service'],
    env: { WORKFLOW_SUPERVISOR_MAX_GLOBAL: '5' },
  });
  const out = await processIntent(goodIntent, d);
  assert.equal(out.status, 'launched');
  assert.deepEqual(launched, ['g-1']);
});
