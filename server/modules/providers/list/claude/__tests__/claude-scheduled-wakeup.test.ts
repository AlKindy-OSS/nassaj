/**
 * B-1699 — scheduled wake-ups. Fixtures are the redacted CLI 2.1.306 / SDK 0.3.310
 * capture (server/claude-sdk.control-stream.wakeup.fixture.json), not invented shapes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

import {
  createScheduledWakeupTracker,
  isScheduledWakeupRow,
  scheduledWakeAt,
} from '../claude-scheduled-wakeup.js';

type Raw = Record<string, any>;
const capture = JSON.parse(fs.readFileSync(
  new URL('../../../../../claude-sdk.control-stream.wakeup.fixture.json', import.meta.url), 'utf8',
)) as { scenarios: Record<string, Array<{ t: number; m: Raw }>>; transcriptWakeRow: Raw };

const messages = (name: string) => capture.scenarios[name].map(({ m }) => m);
const schedulingResult = (name: string) => messages(name).find(m => m.type === 'user'
  && m.tool_use_result && typeof m.tool_use_result === 'object'
  && ('scheduledFor' in m.tool_use_result || 'nextFireAt' in m.tool_use_result)) as Raw;
const firstFire = (name: string) => messages(name).find(m => m.type === 'command_lifecycle') as Raw;

test('the captured ScheduleWakeup result names its time; the text fallback reads "(in Ns)"', () => {
  const result = schedulingResult('scheduleWakeup');
  const text = result.message.content[0].content as string;
  assert.equal(scheduledWakeAt('ScheduleWakeup', result.tool_use_result, text, 0),
    result.tool_use_result.scheduledFor);
  assert.equal(scheduledWakeAt('ScheduleWakeup', null, text, 1_000), 1_000 + 108_000);
  assert.equal(scheduledWakeAt('ScheduleWakeup', null, 'no time here', 1_000), null);
});

test('CronCreate counts only when session-only', () => {
  const structured = schedulingResult('cronCreate').tool_use_result;
  assert.equal(structured.durable, false, 'the capture is a session-only task');
  assert.equal(scheduledWakeAt('CronCreate', structured, '', 0), structured.nextFireAt);
  assert.equal(scheduledWakeAt('CronCreate', { ...structured, durable: true }, '', 0), null);
});

test('the tracker holds a wake-up from its result until its turn starts', () => {
  let clock = 0;
  const tracker = createScheduledWakeupTracker(60_000, () => clock);
  const stream = messages('scheduleWakeup');
  const wakeAt = schedulingResult('scheduleWakeup').tool_use_result.scheduledFor as number;
  clock = wakeAt - 100_000;
  let state = { nextWakeAt: null as number | null, firedCommandUuid: null as string | null };
  const fire = firstFire('scheduleWakeup');
  for (const m of stream) {
    if (m === fire) clock = wakeAt + 800;
    state = tracker.observe(m);
    if (m === fire) break;
    if (m.type === 'result') assert.equal(state.nextWakeAt, wakeAt, 'pending after the scheduling turn');
  }
  assert.equal(state.firedCommandUuid, fire.command_uuid, 'the start of the wake-up turn is recognised');
  assert.equal(state.nextWakeAt, null, 'and nothing is pending any more');
});

test('a command nassaj sent itself, or a start long before the time, is not a wake-up', () => {
  let clock = 0;
  const tracker = createScheduledWakeupTracker(60_000, () => clock);
  const stream = messages('scheduleWakeup');
  const fire = firstFire('scheduleWakeup');
  const wakeAt = schedulingResult('scheduleWakeup').tool_use_result.scheduledFor as number;
  clock = wakeAt - 100_000;
  for (const m of stream) if (m !== fire) tracker.observe(m);
  assert.equal(tracker.observe(fire).firedCommandUuid, null, 'too early to be the wake-up');
  clock = wakeAt;
  assert.equal(tracker.observe(fire, uuid => uuid === fire.command_uuid).firedCommandUuid, null);
  assert.equal(tracker.observe(fire).firedCommandUuid, fire.command_uuid);
});

test('a wake-up past its time plus the margin is no longer pending', () => {
  let clock = 0;
  const tracker = createScheduledWakeupTracker(1_000, () => clock);
  const wakeAt = schedulingResult('scheduleWakeup').tool_use_result.scheduledFor as number;
  clock = wakeAt - 10_000;
  let state;
  for (const m of messages('scheduleWakeup')) {
    if (m.type === 'command_lifecycle') break;
    state = tracker.observe(m);
  }
  assert.equal(state?.nextWakeAt, wakeAt);
  clock = wakeAt + 1_001;
  assert.equal(tracker.observe({ type: 'system', subtype: 'init' }).nextWakeAt, null);
});

test('history: the wake-up prompt row reads as the scheduled wake-up notice, never a user message', () => {
  const row = capture.transcriptWakeRow;
  assert.equal(isScheduledWakeupRow(row), true);
  const out = new ClaudeSessionsProvider().normalizeMessage(row as never, 'sess-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'notice');
  assert.equal(out[0].noticeCode, 'scheduled_wakeup');
  assert.equal(out[0].id, firstFire('scheduleWakeup').command_uuid, 'same id as the live notice');
  assert.equal(isScheduledWakeupRow({ ...row, isMeta: false }), false);
  assert.equal(isScheduledWakeupRow({ ...row, turnOrigin: 'sdk' }), false);
});

// ── qa veto round (M6, M3, C2) ──
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const textResult = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, content: text });

test('two tool_results in one message: the structured result is ignored, the text fallback applies', () => {
  const tracker = createScheduledWakeupTracker(60_000, () => 1_000);
  tracker.observe({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: {} },
    { type: 'tool_use', id: 'r1', name: 'Read', input: {} }] } });
  const state = tracker.observe({ type: 'user', parent_tool_use_id: null,
    tool_use_result: { scheduledFor: 999_999_999 },
    message: { role: 'user', content: [textResult('r1', 'file text'),
      textResult('w1', 'Next wakeup scheduled for 04:53:00 (in 30s).')] } });
  assert.equal(state.scheduled, true);
  assert.equal(state.nextWakeAt, 1_000 + 30_000, 'the shared structured field belongs to neither call');
});

test('overlapping wake-ups: the earliest fires first, the later one stays pending', () => {
  let clock = 0;
  const tracker = createScheduledWakeupTracker(60_000, () => clock);
  for (const [id, seconds] of [['a', 120], ['b', 30]] as const) {
    tracker.observe(toolUse(id, 'ScheduleWakeup'));
    tracker.observe({ type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: [textResult(id, `scheduled (in ${seconds}s)`)] } });
  }
  assert.equal(tracker.observe({ type: 'system' }).nextWakeAt, 30_000);
  clock = 30_500;
  const fired = tracker.observe({ type: 'command_lifecycle', state: 'started', command_uuid: 'c1' });
  assert.equal(fired.firedCommandUuid, 'c1');
  assert.equal(fired.nextWakeAt, 120_000, 'the later wake-up is still owed');
});

test('a recurring session-only cron stays pending across fires until CronDelete', () => {
  let clock = 0;
  const tracker = createScheduledWakeupTracker(1_000, () => clock);
  const created = schedulingResult('cronCreate');
  tracker.observe(toolUse(created.message.content[0].tool_use_id, 'CronCreate'));
  const nextFireAt = created.tool_use_result.nextFireAt as number;
  clock = nextFireAt - 10_000;
  const state = tracker.observe({ ...created, tool_use_result: { ...created.tool_use_result, recurring: true } });
  assert.equal(state.openEnded, true);
  clock = nextFireAt + 100;
  assert.equal(tracker.observe({ type: 'command_lifecycle', state: 'started', command_uuid: 'f1' }).firedCommandUuid,
    'f1');
  clock = nextFireAt + 3_600_000;
  const later = tracker.observe({ type: 'command_lifecycle', state: 'started', command_uuid: 'f2' });
  assert.equal(later.firedCommandUuid, 'f2', 'a later fire of the same task is recognised');
  assert.equal(later.openEnded, true, 'never pruned by time');
  tracker.observe(toolUse('del', 'CronDelete', { id: created.tool_use_result.id }));
  const deleted = tracker.observe({ type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [textResult('del', 'Cancelled')] } });
  assert.equal(deleted.cancelled, true);
  assert.equal(deleted.openEnded, false);
  assert.equal(deleted.nextWakeAt, null);
});

test('a failed CronDelete keeps the task pending', () => {
  const tracker = createScheduledWakeupTracker(1_000, () => 0);
  const created = schedulingResult('cronCreate');
  tracker.observe(toolUse(created.message.content[0].tool_use_id, 'CronCreate'));
  tracker.observe({ ...created, tool_use_result: { ...created.tool_use_result, recurring: true } });
  tracker.observe(toolUse('del', 'CronDelete', { id: created.tool_use_result.id }));
  const state = tracker.observe({ type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [{ ...textResult('del', 'no such task'), is_error: true }] } });
  assert.equal(state.cancelled, false);
  assert.equal(state.openEnded, true);
});
