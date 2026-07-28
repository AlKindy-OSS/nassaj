/**
 * Tests for the workflow agent rows that feed the composer strip.
 *
 * The journal fixture is a copy of a REAL workflow journal shape (the interrupted
 * run wf_1a7845b5-de1: nine `started`, eight `result`, the ninth agent killed
 * mid-flight). That asymmetry is the whole reason this feature exists, so it is
 * the default case here rather than an edge case.
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  __resetWorkflowAgentScan,
  deriveAgentLabel,
  parseJournalAgents,
  readWorkflowAgents,
} from '../workflow-agents.service.js';

/** Journal line shapes exactly as the harness writes them: {type, key, agentId}. */
const started = (agentId: string) =>
  JSON.stringify({ type: 'started', key: `v2:${agentId}hash`, agentId });
const result = (agentId: string) =>
  JSON.stringify({ type: 'result', key: `v2:${agentId}hash`, agentId, result: 'ok' });

/** One transcript row in the agent-file shape (prompt row, then tool calls). */
const promptRow = (text: string) =>
  JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text }] } });
const toolRow = (name: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input: {} }] } });

describe('parseJournalAgents', () => {
  it('keeps delegation order and marks only resulted agents done', () => {
    const text = [started('a1'), started('a2'), result('a1'), started('a3')].join('\n');
    const { order, resulted } = parseJournalAgents(text);
    assert.deepEqual(order, ['a1', 'a2', 'a3']);
    assert.deepEqual([...resulted], ['a1']);
  });

  it('still lists an agent whose `started` line was lost but which produced a result', () => {
    const { order, resulted } = parseJournalAgents([started('a1'), result('a2')].join('\n'));
    assert.deepEqual(order, ['a1', 'a2']);
    assert.ok(resulted.has('a2'));
  });

  it('skips a half-written tail line instead of aborting the parse', () => {
    const text = `${started('a1')}\n${result('a1')}\n{"type":"started","agen`;
    const { order } = parseJournalAgents(text);
    assert.deepEqual(order, ['a1']);
  });

  it('de-duplicates a repeated start (resume replays the journal)', () => {
    const { order } = parseJournalAgents([started('a1'), started('a1')].join('\n'));
    assert.deepEqual(order, ['a1']);
  });
});

describe('deriveAgentLabel', () => {
  it('accepts a short single-line task prompt', () => {
    assert.equal(deriveAgentLabel(promptRow('grep CI logs for retry markers')), 'grep CI logs for retry markers');
  });

  it('returns null for a long context preamble rather than truncating it', () => {
    // Real workflow prompts routinely open with a wall of repo context. A 90-char
    // slice of that reads like a task name and is not one — so: no label at all.
    const wall = `Repo: /home/dev/workspace/nassaj — ${'x'.repeat(400)}`;
    assert.equal(deriveAgentLabel(promptRow(wall)), null);
  });

  it('returns null on a malformed row', () => {
    assert.equal(deriveAgentLabel('{not json'), null);
    assert.equal(deriveAgentLabel(JSON.stringify({ message: {} })), null);
  });
});

describe('readWorkflowAgents', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wf-agents-'));
    __resetWorkflowAgentScan();
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('mirrors the interrupted-run shape: 3 started, 2 resulted → one row still running', async () => {
    await fsp.writeFile(
      path.join(dir, 'journal.jsonl'),
      [started('a1'), started('a2'), started('a3'), result('a1'), result('a2')].join('\n') + '\n',
      'utf8',
    );
    await fsp.writeFile(path.join(dir, 'agent-a1.jsonl'), [promptRow('audit secrets'), toolRow('Bash')].join('\n') + '\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'agent-a2.jsonl'), [promptRow('inventory infra'), toolRow('Read')].join('\n') + '\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'agent-a3.jsonl'), [promptRow('plan separation'), toolRow('Grep'), toolRow('Bash')].join('\n') + '\n', 'utf8');

    const { agents, truncated, lastActivityMs } = await readWorkflowAgents(dir);

    assert.equal(truncated, false);
    assert.deepEqual(agents.map((a) => a.status), ['done', 'done', 'running']);
    assert.deepEqual(agents.map((a) => a.ordinal), [1, 2, 3]);
    assert.deepEqual(agents.map((a) => a.label), ['audit secrets', 'inventory infra', 'plan separation']);
    assert.equal(agents[2]?.callCount, 2);
    assert.equal(agents[2]?.currentTool, 'Bash');
    assert.ok(lastActivityMs > 0, 'agent transcript mtimes must produce a real activity stamp');
  });

  it('never shows a "current tool" for a finished agent', async () => {
    await fsp.writeFile(path.join(dir, 'journal.jsonl'), [started('a1'), result('a1')].join('\n') + '\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'agent-a1.jsonl'), [promptRow('done work'), toolRow('Bash')].join('\n') + '\n', 'utf8');

    const { agents } = await readWorkflowAgents(dir);
    assert.equal(agents[0]?.status, 'done');
    assert.equal(agents[0]?.currentTool, null);
    assert.equal(agents[0]?.callCount, 1, 'the call count is still real for a finished agent');
  });

  it('counts only newly appended bytes on the second read (incremental cursor)', async () => {
    const journal = path.join(dir, 'journal.jsonl');
    const agentFile = path.join(dir, 'agent-a1.jsonl');
    await fsp.writeFile(journal, `${started('a1')}\n`, 'utf8');
    await fsp.writeFile(agentFile, [promptRow('long run'), toolRow('Bash')].join('\n') + '\n', 'utf8');

    const first = await readWorkflowAgents(dir);
    assert.equal(first.agents[0]?.callCount, 1);

    await fsp.appendFile(agentFile, `${toolRow('Read')}\n`, 'utf8');
    const second = await readWorkflowAgents(dir);
    assert.equal(second.agents[0]?.callCount, 2, 'appended calls must accumulate, not restart');
    assert.equal(second.agents[0]?.currentTool, 'Read');
  });

  it('reports a row for an agent whose transcript is missing, without throwing', async () => {
    await fsp.writeFile(path.join(dir, 'journal.jsonl'), `${started('ghost')}\n`, 'utf8');
    const { agents } = await readWorkflowAgents(dir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.callCount, 0);
    assert.equal(agents[0]?.updatedAt, null);
  });

  it('degrades to an empty list for a directory with no journal', async () => {
    const { agents, lastActivityMs } = await readWorkflowAgents(path.join(dir, 'absent'));
    assert.deepEqual(agents, []);
    assert.equal(lastActivityMs, 0);
  });
});
