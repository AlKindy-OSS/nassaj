/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL) — client side of turn-scoped stop/approval:
 * the turnKey a stop names, one commandId per intent, and a small outbox that
 * resends the same commandId after a reconnect within 30 s.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  acknowledgeControlCommand,
  commandIdForIntent,
  recordTurnKeyFrame,
  rememberSentTurnKey,
  resendPendingControlCommands,
  resetControlCommandState,
  resolveStopTarget,
  submitControlCommand,
} from './controlCommandOutbox';

beforeEach(() => resetControlCommandState());

describe('turn key per session', () => {
  it('keeps the turnKey of the run frames of a session', () => {
    recordTurnKeyFrame({ kind: 'text', role: 'assistant', sessionId: 's1', turnKey: 'turn-1' });
    expect(resolveStopTarget('s1')).toBe('turn-1');
    expect(resolveStopTarget('s2')).toBeNull();
  });

  it('a session_busy / not-started frame never replaces the running turn key', () => {
    recordTurnKeyFrame({ kind: 'tool_use', sessionId: 's1', turnKey: 'running' });
    recordTurnKeyFrame({ kind: 'error', code: 'session_busy', sessionId: 's1', turnKey: 'rejected' });
    recordTurnKeyFrame({ kind: 'complete', notStarted: true, sessionId: 's1', turnKey: 'rejected-2' });
    expect(resolveStopTarget('s1')).toBe('running');
  });

  it('condition 4: before the first run frame the pending send id is the target', () => {
    rememberSentTurnKey(null, 'pending-new');
    expect(resolveStopTarget(null)).toBe('pending-new');
    recordTurnKeyFrame({ kind: 'text', role: 'assistant', sessionId: 's1', turnKey: 'turn-1' });
    rememberSentTurnKey('s1', 'pending-resume');
    expect(resolveStopTarget('s1')).toBe('pending-resume');
  });

  it('the pending id clears once its own run frame arrives, or when it was refused', () => {
    rememberSentTurnKey(null, 'k-new');
    recordTurnKeyFrame({ kind: 'session_created', sessionId: 's9', newSessionId: 's9', turnKey: 'k-new' });
    expect(resolveStopTarget(null)).toBeNull();
    expect(resolveStopTarget('s9')).toBe('k-new');
    recordTurnKeyFrame({ kind: 'text', role: 'assistant', sessionId: 's1', turnKey: 'running' });
    rememberSentTurnKey('s1', 'busy');
    recordTurnKeyFrame({ kind: 'error', code: 'session_busy', sessionId: 's1', turnKey: 'busy' });
    expect(resolveStopTarget('s1')).toBe('running');
  });
});

describe('one commandId per intent', () => {
  it('the same intent reuses its commandId until a retryable receipt', () => {
    const first = commandIdForIntent('stop:s1:turn-1');
    expect(commandIdForIntent('stop:s1:turn-1')).toBe(first);
    expect(commandIdForIntent('stop:s1:turn-2')).not.toBe(first);
    acknowledgeControlCommand({ commandId: first, status: 'stopped' });
    expect(commandIdForIntent('stop:s1:turn-1')).toBe(first);
    acknowledgeControlCommand({ commandId: first, status: 'failed' });
    expect(commandIdForIntent('stop:s1:turn-1')).not.toBe(first);
  });

  it('commandIds are bounded opaque tokens the server accepts', () => {
    expect(commandIdForIntent('approval:req-1')).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
  });
});

describe('control outbox', () => {
  it('resends the same payload after a reconnect within 30 s, then forgets it on receipt', () => {
    const sent: unknown[] = [];
    const payload = { type: 'abort-session', sessionId: 's1', commandId: 'c1', targetTurnKey: 'k' };
    submitControlCommand(payload, (message) => { sent.push(message); return { ok: true }; }, 1_000);
    expect(resendPendingControlCommands((message) => sent.push(message), 25_000)).toBe(1);
    expect(sent).toEqual([payload, payload]);
    acknowledgeControlCommand({ commandId: 'c1', status: 'stopped' });
    expect(resendPendingControlCommands((message) => sent.push(message), 26_000)).toBe(0);
  });

  it('a command older than 30 s is dropped, never resent', () => {
    const sent: unknown[] = [];
    submitControlCommand({ type: 'abort-session', commandId: 'old' }, () => ({ ok: false, reason: 'x' }), 0);
    expect(resendPendingControlCommands((message) => sent.push(message), 30_001)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a send that failed while disconnected is still resent on reconnect', () => {
    const sent: unknown[] = [];
    const result = submitControlCommand({ type: 'abort-session', commandId: 'c2' }, () => ({ ok: false, reason: 'disconnected' }), 0);
    expect(result).toEqual({ ok: false, reason: 'disconnected' });
    expect(resendPendingControlCommands((message) => sent.push(message), 5_000)).toBe(1);
  });
});
