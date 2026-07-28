/**
 * T-821 / C5 (T-820 audit) — the DISK validator no longer leans on GATE2 or
 * Node-spawn to reject a hostile on-disk DurableTask. Proves the hardened v2
 * validator rejects `..`/control chars/NUL in projectPath, a non-POSITIVE userId,
 * and over-sized string fields, while a clean task still validates.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateIntent, type DurableTask } from '@/modules/workflow-supervisor/intent.js';

function baseTask(): DurableTask {
  return {
    schema_version: '2',
    taskId: 'task_1',
    userId: 1,
    projectPath: '/home/owner/proj',
    conversationId: 'conv_1',
    originMessageId: 'm_1',
    spec: { scriptOrPrompt: 'run the audit', model: null, effort: null, handoffPolicy: 'card-only', leafOnly: true },
    requestedAt: new Date(0).toISOString(),
  };
}

test('a clean v2 task validates', () => {
  const r = validateIntent(baseTask());
  assert.equal(r.ok, true);
});

test('projectPath with a ".." segment is rejected', () => {
  const r = validateIntent({ ...baseTask(), projectPath: '/home/../etc/passwd' });
  assert.equal(r.ok, false);
});

test('projectPath with a NUL byte is rejected', () => {
  const r = validateIntent({ ...baseTask(), projectPath: `/home/owner${String.fromCharCode(0)}/x` });
  assert.equal(r.ok, false);
});

test('projectPath with a control char is rejected', () => {
  const r = validateIntent({ ...baseTask(), projectPath: `/home/owner${String.fromCharCode(9)}proj` });
  assert.equal(r.ok, false);
});

test('userId 0 and -5 are rejected (must be POSITIVE integer)', () => {
  assert.equal(validateIntent({ ...baseTask(), userId: 0 }).ok, false);
  assert.equal(validateIntent({ ...baseTask(), userId: -5 }).ok, false);
});

test('oversized scriptOrPrompt is rejected', () => {
  const huge = 'x'.repeat(64 * 1024 + 1);
  const t = baseTask();
  t.spec = { ...t.spec, scriptOrPrompt: huge };
  assert.equal(validateIntent(t).ok, false);
});

test('oversized model / effort are rejected', () => {
  const t1 = baseTask();
  t1.spec = { ...t1.spec, model: 'm'.repeat(129) };
  assert.equal(validateIntent(t1).ok, false);

  const t2 = baseTask();
  t2.spec = { ...t2.spec, effort: 'e'.repeat(129) };
  assert.equal(validateIntent(t2).ok, false);
});

test('a normal absolute projectPath with dots in a filename (not a segment) is allowed', () => {
  // "..foo" or "foo.." are NOT traversal segments; only an exact ".." segment is.
  const r = validateIntent({ ...baseTask(), projectPath: '/home/owner/my..proj/v1.2' });
  assert.equal(r.ok, true);
});
