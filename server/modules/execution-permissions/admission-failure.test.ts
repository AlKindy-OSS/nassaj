import assert from 'node:assert/strict';
import test from 'node:test';

import { PermissionStateConflictError } from '@/modules/database/index.js';

import {
  admissionFailurePayload,
  classifyAdmissionFailure,
  reportAdmissionFailure,
  sendAdmissionFailureResponse,
} from './admission-failure.js';

const sessionFence = { scopeKind: 'session', reasonCode: 'RECONCILED_EFFECT_UNKNOWN' } as const;

test('B-1076: permanent refusals are non-retryable 409s', () => {
  assert.deepEqual(
    classifyAdmissionFailure(new PermissionStateConflictError('EFFECT_SCOPE_FENCED', sessionFence)),
    { code: 'effect_scope_fenced', retryable: false, httpStatus: 409, fence: sessionFence },
  );
  assert.deepEqual(classifyAdmissionFailure(new PermissionStateConflictError('GENERATION_BLOCKED', {
    scopeKind: 'generation', reasonCode: 'START_EVIDENCE_WRITE_FAILED',
  })), {
    code: 'generation_blocked', retryable: false, httpStatus: 409,
    fence: { scopeKind: 'generation', reasonCode: 'START_EVIDENCE_WRITE_FAILED' },
  });
});

test('B-1076: known transient codes keep their code, 503 and retryable', () => {
  for (const raw of ['GENERATION_TRANSITIONING', 'ACTOR_REVOKED_OR_STALE', 'IDENTITY_STALE']) {
    assert.deepEqual(classifyAdmissionFailure(new PermissionStateConflictError(raw)), {
      code: raw.toLowerCase(), retryable: true, httpStatus: 503,
    });
  }
});

test('B-1076: unknown, arbitrary and missing codes collapse to permission_admission_unavailable', () => {
  const unavailable = { code: 'permission_admission_unavailable', retryable: true, httpStatus: 503 };
  const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  assert.deepEqual(classifyAdmissionFailure(busy), unavailable);
  assert.deepEqual(classifyAdmissionFailure(new Error('PERMISSION_AUTHORIZER_UNAVAILABLE')), unavailable);
  assert.deepEqual(classifyAdmissionFailure({ code: 'something_new' }), unavailable);
  assert.deepEqual(classifyAdmissionFailure(null), unavailable);
  assert.deepEqual(classifyAdmissionFailure('boom'), unavailable);
});

test('B-1076: a transient code never carries a fence even if the error has one', () => {
  const error = Object.assign(new Error('x'), { code: 'SQLITE_BUSY', fence: sessionFence });
  assert.equal(classifyAdmissionFailure(error).fence, undefined);
});

test('B-1076: an unreadable or malformed fence never masks the permanent code', () => {
  const throwing = new PermissionStateConflictError('EFFECT_SCOPE_FENCED');
  Object.defineProperty(throwing, 'fence', { get() { throw new Error('lookup failed'); } });
  const malformed = [
    { scopeKind: 'scope_key_leak', reasonCode: 'X' },
    { scopeKind: 'session', reasonCode: 'has spaces and\nnewlines' },
    { scopeKind: 'session' },
  ];
  const expected = { code: 'effect_scope_fenced', retryable: false, httpStatus: 409 };
  assert.deepEqual(classifyAdmissionFailure(throwing), expected);
  for (const fence of malformed) {
    const error = new PermissionStateConflictError('EFFECT_SCOPE_FENCED', fence as never);
    assert.deepEqual(classifyAdmissionFailure(error), expected);
  }
});

test('B-1076: the transport payload exposes only code, retryable and the fence hint', () => {
  const payload = admissionFailurePayload(classifyAdmissionFailure(
    new PermissionStateConflictError('EFFECT_SCOPE_FENCED', {
      ...sessionFence, scopeKey: 'session-secret', decisionId: 'd-1',
    } as never),
  ));
  assert.deepEqual(payload, { code: 'effect_scope_fenced', retryable: false, fence: sessionFence });
  assert.deepEqual(Object.keys(payload.fence ?? {}).sort(), ['reasonCode', 'scopeKind']);
  assert.deepEqual(admissionFailurePayload(classifyAdmissionFailure(new Error('x'))), {
    code: 'permission_admission_unavailable', retryable: true,
  });
});

test('B-1076: one structured warn line with identifiers and codes, never a body', () => {
  const lines: string[] = [];
  const error = new PermissionStateConflictError('EFFECT_SCOPE_FENCED', sessionFence);
  const result = reportAdmissionFailure({
    entrypoint: 'ws.chat', sessionId: 'session-1', userId: 7, provider: 'claude', purpose: 'sdk_turn',
  }, error, line => lines.push(line));
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(entry, {
    event: 'permission_admission_failed',
    code: 'effect_scope_fenced',
    retryable: false,
    originalCode: 'EFFECT_SCOPE_FENCED',
    originalMessage: 'EFFECT_SCOPE_FENCED',
    entrypoint: 'ws.chat',
    sessionId: 'session-1',
    userId: 7,
    provider: 'claude',
    purpose: 'sdk_turn',
    fenceScopeKind: 'session',
    fenceReasonCode: 'RECONCILED_EFFECT_UNKNOWN',
  });
  assert.equal(result.code, 'effect_scope_fenced');
  assert.equal('body' in entry || 'command' in entry || 'prompt' in entry, false);
});

test('B-1076: the log keeps the original code of an unknown failure and bounds its message', () => {
  const lines: string[] = [];
  const busy = Object.assign(new Error(`locked\n${'x'.repeat(500)}`), { code: 'SQLITE_BUSY' });
  const result = reportAdmissionFailure({ entrypoint: 'rest.agent' }, busy, line => lines.push(line));
  const entry = JSON.parse(lines[0]);
  assert.equal(result.code, 'permission_admission_unavailable');
  assert.equal(entry.originalCode, 'SQLITE_BUSY');
  assert.equal(entry.originalMessage.length, 200);
  assert.doesNotMatch(entry.originalMessage, /\n/);
  assert.equal(entry.sessionId, null);
});

test('B-1076: a failing log sink never changes the classification', () => {
  const result = reportAdmissionFailure(
    { entrypoint: 'ws.btw' },
    new PermissionStateConflictError('GENERATION_BLOCKED'),
    () => { throw new Error('sink down'); },
  );
  assert.deepEqual(result, { code: 'generation_blocked', retryable: false, httpStatus: 409 });
});

test('B-1076: REST responder (rest.agent, rest.git) sends the classified status and body', () => {
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = { status: (status: number) => ({ json: (body: unknown) => sent.push({ status, body }) }) };
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.warn = (line: string) => { lines.push(line); };
  try {
    sendAdmissionFailureResponse(res, { entrypoint: 'rest.agent', userId: 3, provider: 'codex' },
      new PermissionStateConflictError('EFFECT_SCOPE_FENCED', sessionFence));
    sendAdmissionFailureResponse(res, { entrypoint: 'rest.agent' },
      new PermissionStateConflictError('ACTOR_REVOKED_OR_STALE'));
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(sent, [{
    status: 409,
    body: {
      error: 'Permission admission failed closed.', code: 'effect_scope_fenced',
      retryable: false, fence: sessionFence, notStarted: true,
    },
  }, {
    status: 503,
    body: {
      error: 'Permission admission failed closed.', code: 'actor_revoked_or_stale',
      retryable: true, notStarted: true,
    },
  }]);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).entrypoint, 'rest.agent');
});

test('B-1076: client-supplied log fields are capped at 128 chars without control characters', () => {
  const lines: string[] = [];
  const longId = `s${'x'.repeat(5_000)}`;
  reportAdmissionFailure({
    entrypoint: 'rest.agent', sessionId: `${longId}\nforged`, userId: 'u'.repeat(300),
    provider: 'p'.repeat(300), purpose: 'q'.repeat(300),
  }, new PermissionStateConflictError('EFFECT_SCOPE_FENCED', sessionFence), line => lines.push(line));
  const entry = JSON.parse(lines[0]);
  for (const field of ['sessionId', 'userId', 'provider', 'purpose']) {
    assert.equal(entry[field].length, 128, field);
  }
  assert.doesNotMatch(entry.sessionId, /\n/);
  assert.equal(lines[0].length < 1_000, true);
});
