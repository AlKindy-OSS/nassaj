/**
 * T-2113: the SDK 0.3.317–0.3.325 stream messages nassaj used to drop.
 *
 * Shapes are taken from node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
 * (0.3.325) and the bundled CLI 2.1.325, which emits:
 *   - `tool_progress` heartbeats while hooks run (`tool_use_id` begins `hook-`,
 *     `tool_name` is the hook event, CHANGELOG 0.3.323);
 *   - `system/informational` level `warning` tagged `hook_no_verdict` with a
 *     `hook_no_verdict: { hook_event, tool_use_id, timed_out }` object (0.3.325);
 *   - `system/informational` level `warning` tagged `hook_callback_failed` (0.3.317);
 *   - `system/session_writes_lost` `{ error_code, lost, transcript_session_ids }`;
 *   - `credential_expires_at` (ISO 8601) on result messages (0.3.318).
 *
 * Run: npm run test:server -- server/modules/providers/list/claude/__tests__/claude-stream-notices.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createClaudeStreamNotices,
  CREDENTIAL_EXPIRING_NOTICE_CODE,
  HOOK_FAILED_NOTICE_CODE,
  HOOK_NO_VERDICT_NOTICE_CODE,
  HOOK_RUNNING_STATUS_TEXT,
  SESSION_WRITES_LOST_NOTICE_CODE,
} from '../claude-stream-notices.js';

const SID = 'sess-1';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const hookBeat = (id = 'hook-abc', elapsed = 1) => ({
  type: 'tool_progress', tool_use_id: id, tool_name: 'PreToolUse', parent_tool_use_id: null,
  elapsed_time_seconds: elapsed, uuid: `u-${id}-${elapsed}`, session_id: SID,
});

const make = () => createClaudeStreamNotices({ now: () => NOW });

test('a hook heartbeat becomes one quiet status; repeats are collapsed', () => {
  const notices = make();
  const first = notices.observe(hookBeat('hook-abc', 1), SID);
  assert.equal(first.broadcast.length, 1);
  assert.equal(first.broadcast[0].kind, 'status');
  assert.equal(first.broadcast[0].text, HOOK_RUNNING_STATUS_TEXT);
  assert.equal(first.ownerOnly.length, 0);
  assert.equal(notices.observe(hookBeat('hook-abc', 2), SID).broadcast.length, 0);
  assert.equal(notices.observe(hookBeat('hook-other', 3), SID).broadcast.length, 0);
});

test('model output after a hook heartbeat moves the status back to working', () => {
  const notices = make();
  notices.observe(hookBeat(), SID);
  const after = notices.observe({ type: 'assistant', message: { content: [] } }, SID);
  assert.equal(after.broadcast.length, 1);
  assert.equal(after.broadcast[0].kind, 'status');
  assert.equal(after.broadcast[0].text, 'Working');
  // Without a hook in flight, ordinary output emits nothing.
  assert.equal(notices.observe({ type: 'assistant', message: { content: [] } }, SID).broadcast.length, 0);
  // A later hook shows the status again.
  assert.equal(notices.observe(hookBeat('hook-2', 1), SID).broadcast.length, 1);
});

test('a tool heartbeat that is not a hook is ignored', () => {
  const notices = make();
  const out = notices.observe({ ...hookBeat('toolu_01', 5), tool_name: 'Bash', heartbeat: true }, SID);
  assert.deepEqual(out, { broadcast: [], ownerOnly: [] });
});

test('hook_no_verdict becomes a warning notice with its reason', () => {
  const notices = make();
  const raw = {
    type: 'system', subtype: 'informational', level: 'warning', tag: 'hook_no_verdict',
    content: "A hook didn't answer in time, so it didn't check this action.",
    hook_no_verdict: { hook_event: 'PreToolUse', tool_use_id: 'toolu_9', timed_out: true },
    uuid: 'info-1', session_id: SID,
  };
  const [msg] = notices.observe(raw, SID).broadcast;
  assert.equal(msg.kind, 'notice');
  assert.equal(msg.noticeCode, HOOK_NO_VERDICT_NOTICE_CODE);
  assert.equal(msg.noticeReason, 'timed_out');
  assert.equal(msg.noticeLevel, 'warning');
  assert.equal(msg.id, 'info-1');
  assert.match(String(msg.content), /didn't answer in time/);
  const noAnswer = notices.observe({ ...raw, uuid: 'info-2',
    hook_no_verdict: { ...raw.hook_no_verdict, timed_out: false } }, SID).broadcast[0];
  assert.equal(noAnswer.noticeReason, 'no_answer');
});

test('a hook callback failure: viewers get a generic line, the owner alone gets the detail', () => {
  const notices = make();
  const raw = 'PreToolUse: Hook callback cb_1 failed: ENOENT /home/operator/secret/path. Its answer was treated as empty.';
  const out = notices.observe({
    type: 'system', subtype: 'informational', level: 'warning', tag: 'hook_callback_failed',
    content: raw, uuid: 'info-3', session_id: SID,
  }, SID);
  // The error text comes from nassaj's own server-side hook callbacks: it may name
  // server paths, so it never enters the broadcast (mirrors + replay buffer).
  const [shared] = out.broadcast;
  assert.equal(out.broadcast.length, 1);
  assert.equal(shared.kind, 'notice');
  assert.equal(shared.noticeCode, HOOK_FAILED_NOTICE_CODE);
  assert.equal(shared.noticeLevel, 'warning');
  assert.equal(shared.id, 'info-3');
  assert.doesNotMatch(JSON.stringify(shared), /cb_1|ENOENT|\/home\//);
  const [detail] = out.ownerOnly;
  assert.equal(out.ownerOnly.length, 1);
  assert.equal(detail.noticeCode, HOOK_FAILED_NOTICE_CODE);
  assert.equal(detail.content, raw);
  assert.equal(detail.noticeDetailOf, 'info-3');
  assert.notEqual(detail.id, shared.id);
});

test('untagged informational lines stay out of the chat', () => {
  const notices = make();
  const out = notices.observe({ type: 'system', subtype: 'informational', level: 'notice', content: 'x' }, SID);
  assert.deepEqual(out, { broadcast: [], ownerOnly: [] });
});

test('session_writes_lost becomes an error notice naming what was lost', () => {
  const notices = make();
  const [msg] = notices.observe({
    type: 'system', subtype: 'session_writes_lost', error_code: 'ENOSPC',
    lost: ['transcript', 'global_config', 'surprise'], transcript_session_ids: [SID],
    uuid: 'lost-1', session_id: SID,
  }, SID).broadcast;
  assert.equal(msg.kind, 'notice');
  assert.equal(msg.noticeCode, SESSION_WRITES_LOST_NOTICE_CODE);
  assert.equal(msg.noticeLevel, 'error');
  assert.equal(msg.noticeReason, 'ENOSPC');
  assert.deepEqual(msg.lostWrites, ['transcript', 'global_config']);
  assert.ok(String(msg.content).length > 0);
});

test('a sign-in ending within 3 days warns the run owner only, once', () => {
  const notices = make();
  const expiresAt = new Date(NOW + 2 * DAY).toISOString();
  const out = notices.observe({ type: 'result', subtype: 'success', credential_expires_at: expiresAt }, SID);
  assert.equal(out.broadcast.length, 0);
  assert.equal(out.ownerOnly.length, 1);
  const [msg] = out.ownerOnly;
  assert.equal(msg.kind, 'notice');
  assert.equal(msg.noticeCode, CREDENTIAL_EXPIRING_NOTICE_CODE);
  assert.equal(msg.noticeLevel, 'warning');
  assert.equal(msg.noticeReason, 'soon');
  assert.equal(msg.credentialExpiresAt, expiresAt);
  const again = notices.observe({ type: 'result', subtype: 'success', credential_expires_at: expiresAt }, SID);
  assert.equal(again.ownerOnly.length, 0);
});

test('a sign-in end date in the past reads as probably ended', () => {
  const [msg] = make().observe({ type: 'result', credential_expires_at: new Date(NOW - DAY).toISOString() }, SID)
    .ownerOnly;
  assert.equal(msg.noticeReason, 'expired');
});

test('no warning when the end is further than 3 days, missing, or unreadable', () => {
  for (const value of [new Date(NOW + 4 * DAY).toISOString(), undefined, 'not-a-date', 42]) {
    const out = make().observe({ type: 'result', credential_expires_at: value }, SID);
    assert.deepEqual(out, { broadcast: [], ownerOnly: [] }, String(value));
  }
});
