/**
 * ADR-218: shared task-lifecycle readers, and the tracker settling by task id
 * first. Fixture: real 2.1.306 transcript rows of a background agent resumed
 * by SendMessage (see its `_provenance`).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createClaudeSubagentTracker } from '../claude-progress.js';
import { createClaudeProgressFold } from '../claude-progress-fold.js';
import { ClaudeSessionsProvider } from '../claude-sessions.provider.js';
import { claudeAgentTaskBindings, claudeTaskEnds } from '../claude-task-events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '../../../services/session-agents/__fixtures__/claude-sendmessage-resume.real.json');
const SID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Doc = { agentId: string; events: Array<Record<string, any>> };
const load = async (): Promise<Doc> => JSON.parse(await readFile(FIXTURE, 'utf8'));
const AGENT_CALL = 'toolu_01LT34MLESrBYW8BnX1WPJKY';
const RESUME_CALL = 'toolu_01T1iUYZBXngRVvds1nwm9N4';

test('claudeTaskEnds reads both notifications with the agent id as task id', async () => {
  const { agentId, events } = await load();
  const ends = events.flatMap((event) => claudeTaskEnds(event));
  assert.deepEqual(ends, [
    { taskId: agentId, toolUseId: AGENT_CALL, state: 'completed' },
    { taskId: agentId, toolUseId: RESUME_CALL, state: 'completed' },
  ]);
});

test('claudeTaskEnds: peer-relayed notification text and non-terminal updates end nothing', async () => {
  const { events } = await load();
  const note = events.find((event) => event.origin?.kind === 'task-notification')!;
  assert.deepEqual(claudeTaskEnds({ ...note, origin: { ...note.origin, subkind: 'peer' } }), []);
  assert.deepEqual(claudeTaskEnds({ ...note, origin: undefined }), []);
  const update = { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'running' } };
  assert.deepEqual(claudeTaskEnds(update, { includeUpdates: true }), []);
  assert.deepEqual(claudeTaskEnds({ ...update, patch: { status: 'killed' } }), [], 'updates are opt-in');
  assert.deepEqual(claudeTaskEnds({ ...update, patch: { status: 'killed' } }, { includeUpdates: true }),
    [{ taskId: 'a1', toolUseId: null, state: 'stopped' }]);
});

test('claudeAgentTaskBindings: local_agent task_started and a result naming its agentId', async () => {
  const { agentId, events } = await load();
  assert.deepEqual(claudeAgentTaskBindings(events[1]), [{ taskId: agentId, toolUseId: AGENT_CALL }]);
  assert.deepEqual(claudeAgentTaskBindings({ type: 'system', subtype: 'task_started', task_id: 'b1',
    tool_use_id: 't1', task_type: 'local_bash' }), []);
  assert.deepEqual(claudeAgentTaskBindings({ type: 'system', subtype: 'task_started', task_id: 'a2',
    tool_use_id: 't2', task_type: 'local_agent' }), [{ taskId: 'a2', toolUseId: 't2' }]);
});

test('tracker settles a SendMessage-resumed agent by task id; the tool_use id alone misses it', async () => {
  const { agentId, events } = await load();
  const provider = new ClaudeSessionsProvider();
  const fold = createClaudeProgressFold('history', SID);
  const settled = events.flatMap((event) => fold.observe(event, provider.normalizeMessage(event, SID)));
  assert.deepEqual(settled.map((row) => [row.subagent?.id, row.subagent?.state]),
    [[AGENT_CALL, 'completed'], [AGENT_CALL, 'completed']]);

  const bare = createClaudeSubagentTracker();
  bare.observe(events[0], provider.normalizeMessage(events[0], SID));
  assert.equal(bare.settle(RESUME_CALL, 'completed'), null, 'no binding: SendMessage id names no delegation');
  assert.equal(bare.settle(RESUME_CALL, 'completed', agentId), null, 'unbound task id falls back to the tool id');
  bare.observe(events[1], provider.normalizeMessage(events[1], SID));
  assert.equal(bare.settle(RESUME_CALL, 'completed', agentId)?.id, AGENT_CALL);
});
