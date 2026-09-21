import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQwenExecutionContract,
  QWEN_BODY_AVAILABILITY,
  QWEN_GESTURE_MAX_AGE_MS,
  QWEN_MAX_ACTIVE_GESTURES,
  type QwenExecutionRequest,
} from './qwen-execution-contract.js';

const baseRequest = (gestureToken: string): QwenExecutionRequest => ({
  actorUserId: 7,
  sessionId: 'session-qwen-1',
  executionClass: 'foreground_interactive',
  triggerSource: 'user_chat',
  gestureToken,
});

test('Qwen body is exposed only as foreground interactive runtime', () => {
  assert.equal(QWEN_BODY_AVAILABILITY, 'foreground_interactive');
});

test('allows one fresh owner-bound foreground user gesture and audits no secret', () => {
  let clock = 1_000;
  const rows: Array<{ action: string; options: unknown }> = [];
  const contract = createQwenExecutionContract({
    now: () => clock,
    randomToken: () => 'opaque-gesture-secret',
    assertSessionWriteAccess: () => undefined,
    audit: { record: (action, options) => rows.push({ action, options }) },
  });
  const gesture = contract.issueGesture({
    actorUserId: 7,
    sessionId: 'session-qwen-1',
  });
  clock += 25;

  const result = contract.authorizeSpawn(baseRequest(gesture));
  assert.deepEqual(result, {
    body: 'qwen',
    executionClass: 'foreground_interactive',
    gestureAgeMs: 25,
  });
  assert.equal(rows[0]?.action, 'qwen_execution_allowed');
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /opaque-gesture-secret|sk-sp-/);
  assert.throws(() => contract.authorizeSpawn(baseRequest(gesture)), /gesture_missing_or_consumed/);
});

for (const executionClass of ['workflow', 'background', 'cron', 'batch'] as const) {
  test(`rejects ${executionClass} before spawn`, () => {
    const contract = createQwenExecutionContract({
      randomToken: () => `gesture-${executionClass}`,
      assertSessionWriteAccess: () => undefined,
      audit: { record: () => undefined },
    });
    const gesture = contract.issueGesture({
      actorUserId: 7,
      sessionId: 'session-qwen-1',
    });
    assert.throws(
      () => contract.authorizeSpawn({ ...baseRequest(gesture), executionClass }),
      /execution_class_forbidden/,
    );
    assert.throws(() => contract.authorizeSpawn(baseRequest(gesture)), /gesture_missing_or_consumed/);
  });
}

test('rejects scheduler/system/recovery triggers', () => {
  for (const triggerSource of ['scheduler', 'system', 'recovery'] as const) {
    const contract = createQwenExecutionContract({
      randomToken: () => `gesture-${triggerSource}`,
      assertSessionWriteAccess: () => undefined,
      audit: { record: () => undefined },
    });
    const gesture = contract.issueGesture({
      actorUserId: 7,
      sessionId: 'session-qwen-1',
    });
    assert.throws(
      () => contract.authorizeSpawn({ ...baseRequest(gesture), triggerSource }),
      /trigger_source_forbidden/,
    );
    assert.throws(() => contract.authorizeSpawn(baseRequest(gesture)), /gesture_missing_or_consumed/);
  }
});

test('rejects auto-continue and auto-resume', () => {
  for (const automatic of [{ autoContinue: true }, { autoResume: true }]) {
    const contract = createQwenExecutionContract({
      randomToken: () => JSON.stringify(automatic),
      assertSessionWriteAccess: () => undefined,
      audit: { record: () => undefined },
    });
    const gesture = contract.issueGesture({
      actorUserId: 7,
      sessionId: 'session-qwen-1',
    });
    assert.throws(
      () => contract.authorizeSpawn({ ...baseRequest(gesture), ...automatic }),
      /automatic_continuation_forbidden/,
    );
    assert.throws(() => contract.authorizeSpawn(baseRequest(gesture)), /gesture_missing_or_consumed/);
  }
});

test('re-checks server-side session write access and consumes the gesture on refusal', () => {
  let allowed = true;
  const rows: Array<{ action: string; options: unknown }> = [];
  const contract = createQwenExecutionContract({
    randomToken: () => 'owner-bound',
    assertSessionWriteAccess: () => {
      if (!allowed) throw new Error('SESSION_NOT_FOUND');
    },
    audit: { record: (action, options) => rows.push({ action, options }) },
  });
  const gesture = contract.issueGesture({
    actorUserId: 7,
    sessionId: 'session-qwen-1',
  });
  allowed = false;
  assert.throws(() => contract.authorizeSpawn(baseRequest(gesture)), /session_access_denied/);
  assert.equal(rows.at(-1)?.action, 'qwen_execution_rejected');
  assert.match(JSON.stringify(rows.at(-1)), /session_access_denied/);
  assert.doesNotMatch(JSON.stringify(rows.at(-1)), /SESSION_NOT_FOUND/);
  allowed = true;
  assert.throws(() => contract.authorizeSpawn(baseRequest(gesture)), /gesture_missing_or_consumed/);
});

test('rejects expired and cross-session gestures, consuming each token', () => {
  let clock = 10;
  let counter = 0;
  const contract = createQwenExecutionContract({
    now: () => clock,
    randomToken: () => `gesture-${counter += 1}`,
    assertSessionWriteAccess: () => undefined,
    audit: { record: () => undefined },
  });
  const expired = contract.issueGesture({
    actorUserId: 7,
    sessionId: 'session-qwen-1',
  });
  clock += QWEN_GESTURE_MAX_AGE_MS + 1;
  assert.throws(() => contract.authorizeSpawn(baseRequest(expired)), /gesture_expired/);
  assert.throws(() => contract.authorizeSpawn(baseRequest(expired)), /gesture_missing_or_consumed/);

  const wrongSession = contract.issueGesture({
    actorUserId: 7,
    sessionId: 'session-qwen-1',
  });
  assert.throws(
    () => contract.authorizeSpawn({ ...baseRequest(wrongSession), sessionId: 'session-qwen-2' }),
    /gesture_binding_mismatch/,
  );
});

test('keeps only one active gesture per actor/session', () => {
  let counter = 0;
  const contract = createQwenExecutionContract({
    randomToken: () => `one-active-${counter += 1}`,
    assertSessionWriteAccess: () => undefined,
    audit: { record: () => undefined },
  });
  const first = contract.issueGesture({ actorUserId: 7, sessionId: 'session-qwen-1' });
  const second = contract.issueGesture({ actorUserId: 7, sessionId: 'session-qwen-1' });
  assert.throws(() => contract.authorizeSpawn(baseRequest(first)), /gesture_missing_or_consumed/);
  assert.equal(contract.authorizeSpawn(baseRequest(second)).body, 'qwen');
});

test('prunes expired gestures on issue and enforces a fixed fail-closed cap', () => {
  let clock = 0;
  let counter = 0;
  const contract = createQwenExecutionContract({
    now: () => clock,
    randomToken: () => `capacity-${counter += 1}`,
    assertSessionWriteAccess: () => undefined,
    audit: { record: () => undefined },
  });
  const expired = contract.issueGesture({ actorUserId: 1, sessionId: 'expired' });
  clock = QWEN_GESTURE_MAX_AGE_MS + 1;
  contract.issueGesture({ actorUserId: 2, sessionId: 'fresh' });
  assert.throws(() => contract.authorizeSpawn({ ...baseRequest(expired), actorUserId: 1, sessionId: 'expired' }), /gesture_missing_or_consumed/);

  for (let index = 1; index < QWEN_MAX_ACTIVE_GESTURES; index += 1) {
    contract.issueGesture({ actorUserId: index + 2, sessionId: `session-cap-${index}` });
  }
  assert.throws(
    () => contract.issueGesture({ actorUserId: 99_999, sessionId: 'over-cap' }),
    (error: unknown) => Boolean(
      error && typeof error === 'object'
      && 'statusCode' in error
      && (error as { statusCode?: number }).statusCode === 429,
    ),
  );
});
