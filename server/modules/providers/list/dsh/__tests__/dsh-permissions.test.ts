/**
 * dsh-permissions.test — every dsh escalation is answered by its turn owner,
 * once, or rejected (timeout, disconnect) / cancelled (run end) (T-2086 S3).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  cancelAllDshPermissions, dshPermissionTimeoutMs, cancelDshPermissionsForRun, isDshPermissionPending,
  requestDshPermission, resolveDshPermission,
} from '../dsh-permissions.js';

const OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
];

function writer(readyState = 1) {
  const raw = Object.assign(new EventEmitter(), { readyState });
  const frames: Array<Record<string, any>> = [];
  return { ws: raw, frames, send: (frame: Record<string, any>) => frames.push(frame) };
}

function ask(w: ReturnType<typeof writer>, extra: Record<string, unknown> = {}) {
  const outcome = requestDshPermission({
    runId: 'run-1', ownerUserId: 7, sessionId: 's-1', toolName: 'write', input: { file_path: '/x' },
    options: OPTIONS, writer: w, ...extra,
  });
  const request = w.frames.find((f) => f.kind === 'permission_request');
  return { outcome, requestId: request?.requestId as string, request };
}

describe('dsh permission questions', () => {
  it('waits exactly as long as Claude: 55 s for a tool, 30 min for a question, same env overrides', () => {
    assert.equal(dshPermissionTimeoutMs('write', {}), 55_000);
    assert.equal(dshPermissionTimeoutMs('bash', {}), 55_000);
    assert.equal(dshPermissionTimeoutMs('ask_user_question', {}), 1_800_000);
    assert.equal(dshPermissionTimeoutMs('write', { CLAUDE_TOOL_APPROVAL_TIMEOUT_MS: '9000' }), 9000);
    assert.equal(dshPermissionTimeoutMs('ask_user_question', { CLAUDE_INTERACTIVE_APPROVAL_TIMEOUT_MS: '7000' }), 7000);
  });

  it('asks with the tool and its input, and the owner\'s allow selects allow-once, once', async () => {
    const w = writer();
    const { outcome, requestId, request } = ask(w);
    assert.equal(request?.toolName, 'write');
    assert.deepEqual(request?.input, { file_path: '/x' });
    assert.equal(request?.provider, 'dsh');
    assert.equal(resolveDshPermission(requestId, { allow: true, requesterUserId: 7 }), true);
    assert.deepEqual(await outcome, { outcome: 'selected', optionId: 'allow-once' });
    assert.equal(resolveDshPermission(requestId, { allow: false }), false, 'a settled question re-opened');
  });

  it('a non-owner cannot answer; the owner\'s reject selects reject-once', async () => {
    const w = writer();
    const { outcome, requestId } = ask(w);
    assert.equal(resolveDshPermission(requestId, { allow: true, requesterUserId: 8 }), false);
    assert.equal(resolveDshPermission(requestId, { allow: true, requesterUserId: null }), false);
    assert.equal(isDshPermissionPending(requestId), true);
    assert.equal(resolveDshPermission(requestId, { allow: false, requesterUserId: '7' }), true);
    assert.deepEqual(await outcome, { outcome: 'selected', optionId: 'reject-once' });
  });

  it('times out to reject-once and tells the client', async () => {
    const w = writer();
    const { outcome, requestId } = ask(w, { timeoutMs: 5 });
    assert.deepEqual(await outcome, { outcome: 'selected', optionId: 'reject-once' });
    assert.equal(w.frames.find((f) => f.kind === 'permission_cancelled')?.reason, 'timeout');
    assert.equal(resolveDshPermission(requestId, { allow: true }), false);
  });

  it('a closed or closing socket rejects the question', async () => {
    const closed = writer(3);
    assert.deepEqual(await ask(closed).outcome, { outcome: 'selected', optionId: 'reject-once' });
    const open = writer();
    const { outcome } = ask(open);
    open.ws.emit('close');
    assert.deepEqual(await outcome, { outcome: 'selected', optionId: 'reject-once' });
  });

  it('a run end or a drain cancels its questions; reject without a reject option cancels', async () => {
    const run = ask(writer(), { runId: 'run-2' });
    const other = ask(writer(), { runId: 'run-3' });
    cancelDshPermissionsForRun('run-2');
    assert.deepEqual(await run.outcome, { outcome: 'cancelled' });
    assert.equal(isDshPermissionPending(other.requestId), true);
    assert.equal(cancelAllDshPermissions(), 1);
    assert.deepEqual(await other.outcome, { outcome: 'cancelled' });
    const noReject = ask(writer(), { options: [OPTIONS[0]] });
    resolveDshPermission(noReject.requestId, { allow: false });
    assert.deepEqual(await noReject.outcome, { outcome: 'cancelled' });
  });
});
