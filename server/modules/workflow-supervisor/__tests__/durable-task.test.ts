/**
 * T-820 — DurableTask schema (schema_version "2") STRICT validation + the
 * writeDurableTask parallel writer.
 *
 * The v2 validator is the web-surface fail-closed gate (الشرط 3 / §أ-1): every
 * field strict, conversationId/originMessageId path-traversal-proof, handoffPolicy
 * a closed set, leafOnly literally true, and NO field outside the template. The
 * legacy v1 path (schema_version absent) must keep validating unchanged.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateIntent } from '@/modules/workflow-supervisor/intent.js';
import { writeDurableTask } from '@/modules/workflow-supervisor/durable-task.js';

function v2(over: Record<string, unknown> = {}, specOver: Record<string, unknown> = {}) {
  return {
    schema_version: '2',
    taskId: 'task-abc_1',
    userId: 7,
    projectPath: '/home/dev/workspace/demo',
    conversationId: 'conv-1',
    originMessageId: 'msg-1',
    spec: {
      scriptOrPrompt: 'run the audit',
      model: 'haiku',
      effort: null,
      handoffPolicy: 'card-only',
      leafOnly: true,
      ...specOver,
    },
    requestedAt: new Date().toISOString(),
    ...over,
  };
}

test('validateIntent v2: a well-formed DurableTask is accepted and normalized to a LaunchIntent view', () => {
  const res = validateIntent(v2());
  assert.equal(res.ok, true);
  if (res.ok) {
    // Normalized view for the existing launch pipeline.
    assert.equal(res.intent.wfLaunchId, 'task-abc_1');
    assert.equal(res.intent.userId, 7);
    assert.equal(res.intent.scriptOrPrompt, 'run the audit');
    assert.equal(res.intent.model, 'haiku');
    // Full task carried for the delivery context.
    assert.ok(res.task, 'the full DurableTask is surfaced');
    assert.equal(res.task?.conversationId, 'conv-1');
    assert.equal(res.task?.spec.handoffPolicy, 'card-only');
    assert.equal(res.task?.spec.leafOnly, true);
  }
});

test('validateIntent v2: handoffPolicy defaults to card-only when omitted (T-830)', () => {
  const blob = v2();
  delete (blob.spec as Record<string, unknown>).handoffPolicy;
  const res = validateIntent(blob);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.task?.spec.handoffPolicy, 'card-only');
});

test('validateIntent v2: a path-traversal conversationId is REJECTED (no jsonl escape)', () => {
  for (const bad of ['../../etc', '../x', 'a/b', 'a b', 'a.b', 'a/../b', '']) {
    const res = validateIntent(v2({ conversationId: bad }));
    assert.equal(res.ok, false, `conversationId=${JSON.stringify(bad)} must be rejected`);
  }
});

test('validateIntent v2: a path-traversal originMessageId is REJECTED', () => {
  for (const bad of ['../../x', 'm/1', 'm 1', '']) {
    const res = validateIntent(v2({ originMessageId: bad }));
    assert.equal(res.ok, false, `originMessageId=${JSON.stringify(bad)} must be rejected`);
  }
});

test('validateIntent v2: a bad taskId charset is REJECTED (no unit-name injection)', () => {
  for (const bad of ['a/b', 'a.service', '../x', 'a b', '']) {
    const res = validateIntent(v2({ taskId: bad }));
    assert.equal(res.ok, false, `taskId=${JSON.stringify(bad)} must be rejected`);
  }
});

test('validateIntent v2: a non-integer userId is REJECTED (fail-closed isolation base)', () => {
  for (const bad of [null, undefined, 'abc', '7', 1.5, {}]) {
    const res = validateIntent(v2({ userId: bad }));
    assert.equal(res.ok, false, `userId=${JSON.stringify(bad)} must be rejected`);
  }
});

test('validateIntent v2: a non-absolute projectPath is REJECTED', () => {
  const res = validateIntent(v2({ projectPath: 'relative/path' }));
  assert.equal(res.ok, false);
});

test('validateIntent v2: a handoffPolicy outside the closed set is REJECTED', () => {
  const res = validateIntent(v2({}, { handoffPolicy: 'auto-turn-please' }));
  assert.equal(res.ok, false);
});

test('validateIntent v2: leafOnly must be LITERALLY true — false/1/"true" REJECTED', () => {
  for (const bad of [false, 1, 'true', 0, null]) {
    const res = validateIntent(v2({}, { leafOnly: bad }));
    assert.equal(res.ok, false, `leafOnly=${JSON.stringify(bad)} must be rejected`);
  }
});

test('validateIntent v2: an UNEXPECTED top-level field is REJECTED (any field outside the template)', () => {
  const res = validateIntent(v2({ evil: 'x' }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /unexpected DurableTask field/);
});

test('validateIntent v2: an UNEXPECTED spec field is REJECTED', () => {
  const res = validateIntent(v2({}, { evil: 'x' }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /unexpected spec field/);
});

test('validateIntent v1: a legacy intent (no schema_version) still validates unchanged', () => {
  const res = validateIntent({
    wfLaunchId: 'l-1',
    userId: 5,
    projectPath: '/tmp/proj',
    scriptOrPrompt: 'do it',
    requestedAt: new Date().toISOString(),
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.task, undefined, 'v1 carries no DurableTask');
});

// --- writeDurableTask -------------------------------------------------------

test('writeDurableTask: HARD NO-OP when WORKFLOW_SUPERVISOR is off (nothing on disk)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wf-dt-off-'));
  try {
    const res = await writeDurableTask({
      userId: 3,
      projectPath: '/tmp/proj',
      scriptOrPrompt: 'work',
      conversationId: 'c1',
      originMessageId: 'm1',
      env: { WORKFLOW_SUPERVISOR_STATE_DIR: root }, // flag ABSENT => off
    });
    assert.equal(res.written, false);
    if (!res.written) assert.match(res.reason, /flag off/);
    assert.deepEqual(await readdir(root).catch(() => []), [], 'nothing written while off');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeDurableTask: flag ON writes a VALID, atomic, 0600 intent under intents/<userId>/', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wf-dt-on-'));
  try {
    const res = await writeDurableTask({
      userId: 8,
      projectPath: '/home/dev/workspace/demo',
      scriptOrPrompt: 'run the audit',
      conversationId: 'conv-9',
      originMessageId: 'msg-9',
      model: 'haiku',
      handoffPolicy: 'card-only',
      env: { WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_STATE_DIR: root },
    });
    assert.equal(res.written, true);
    if (res.written) {
      assert.match(res.path, /\/intents\/8\/.+\.json$/);
      const blob = JSON.parse(await readFile(res.path, 'utf8'));
      // Round-trips as a valid DurableTask.
      assert.equal(blob.schema_version, '2');
      assert.equal(blob.taskId, res.taskId);
      assert.equal(blob.conversationId, 'conv-9');
      assert.equal(blob.spec.leafOnly, true);
      const check = validateIntent(blob);
      assert.equal(check.ok, true, 'the written blob re-validates strictly');
      // 0600 file mode (web-originated surface).
      const mode = (await stat(res.path)).mode & 0o777;
      assert.equal(mode, 0o600, `intent file must be 0600, got ${mode.toString(8)}`);
      // No .tmp- residue (atomic rename).
      const files = await readdir(path.dirname(res.path));
      assert.ok(files.every((f) => !f.includes('.tmp-')), 'no tmp file lingers');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
