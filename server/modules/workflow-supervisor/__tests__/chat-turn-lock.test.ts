/**
 * T-822 §ج-4 — the per-conversation chat-turn lock, the ONLY critical-path touch.
 * Proves on the REAL flock(2) primitive (two independent OFDs conflict even in one
 * process):
 *  - the live-chat helper is a SYNCHRONOUS no-op when the sub-flag is off (byte-
 *    identical guarantee) and when there is no resume target,
 *  - the injector taker is NON-blocking: a held lock ⇒ 'contended' (it DEFERS —
 *    human priority),
 *  - the chat taker WAITS (bounded) and then fails-OPEN on timeout while the lock
 *    is held (§ح-3), and acquires cleanly once released,
 *  - release frees the lock for the next taker.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireInjectorTurnLock,
  acquireChatTurnLockForLiveTurn,
} from '@/modules/workflow-supervisor/chat-turn-lock.js';

function onEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WORKFLOW_SUPERVISOR: '1',
    WORKFLOW_SUPERVISOR_CHAT_LOCK: '1',
    WORKFLOW_SUPERVISOR_STATE_DIR: root,
    ...extra,
  };
}

test('chat helper is a no-op when the sub-flag is off (byte-identical path)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ctl-off-'));
  try {
    // Master on but sub-flag off.
    const env = { ...process.env, WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_STATE_DIR: root };
    const lock = await acquireChatTurnLockForLiveTurn('conv-1', 5, env);
    assert.equal(lock.held, false);
    assert.equal(lock.reason, 'disabled');
    lock.release(); // no-op, does not throw
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat helper is a no-op for a NEW session (no resume target)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ctl-new-'));
  try {
    const lock = await acquireChatTurnLockForLiveTurn(null, 5, onEnv(root));
    assert.equal(lock.held, false);
    assert.equal(lock.reason, 'disabled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('injector lock is non-blocking: a held lock ⇒ contended (defer, human priority)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ctl-inj-'));
  const env = onEnv(root);
  try {
    const a = await acquireInjectorTurnLock('conv-x', env);
    assert.equal(a.held, true);
    const b = await acquireInjectorTurnLock('conv-x', env);
    assert.equal(b.held, false, 'second taker does NOT block');
    assert.equal(b.reason, 'contended');
    // A DIFFERENT conversation is independent.
    const other = await acquireInjectorTurnLock('conv-y', env);
    assert.equal(other.held, true);
    other.release();
    a.release();
    // After release, the lock is re-acquirable.
    const c = await acquireInjectorTurnLock('conv-x', env);
    assert.equal(c.held, true);
    c.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat taker waits, then fails-OPEN on timeout while held; acquires after release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ctl-wait-'));
  // Short ceiling so the timeout branch is fast.
  const env = onEnv(root, { WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS: '600' });
  try {
    const injector = await acquireInjectorTurnLock('conv-z', env);
    assert.equal(injector.held, true);

    const t0 = Date.now();
    const chat = await acquireChatTurnLockForLiveTurn('conv-z', 5, env);
    const waited = Date.now() - t0;
    // It waited (bounded by the ceiling) then failed OPEN — the human proceeds.
    assert.equal(chat.held, false);
    assert.equal(chat.reason, 'timeout-fail-open');
    assert.ok(waited >= 500, `waited the bounded ceiling (~600ms), got ${waited}ms`);
    assert.ok(waited < 4000, 'never an unbounded block on the critical path');

    injector.release();
    // Now the chat taker acquires cleanly.
    const chat2 = await acquireChatTurnLockForLiveTurn('conv-z', 5, env);
    assert.equal(chat2.held, true);
    assert.equal(chat2.reason, 'acquired');
    chat2.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('injector defers to a held CHAT lock (the common case: human first)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ctl-human-first-'));
  const env = onEnv(root);
  try {
    // Human turn takes the lock first.
    const chat = await acquireChatTurnLockForLiveTurn('conv-h', 5, env);
    assert.equal(chat.held, true);
    // The injector, finding it held, defers IMMEDIATELY (non-blocking).
    const t0 = Date.now();
    const inj = await acquireInjectorTurnLock('conv-h', env);
    assert.ok(Date.now() - t0 < 3000, 'injector does not block on a live human turn');
    assert.equal(inj.held, false);
    assert.equal(inj.reason, 'contended');
    chat.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
