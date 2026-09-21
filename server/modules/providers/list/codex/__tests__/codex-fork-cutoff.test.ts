import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, symlink, link, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { createCodexFinalResponseTracker, openCodexForkCutoff, parseCodexForkCutoff } from '../codex-fork-cutoff.js';

const row = (type: string, payload: object) => ({ type, payload });
const final = (id = 'msg_a', turnId = 'turn-a', phase = 'final_answer') => row('response_item', {
  type: 'message', role: 'assistant', id, phase, content: [{ type: 'output_text', text: 'Answer' }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});
const entries = (cwd = '/project') => [row('session_meta', { id: 'source', cwd }),
  row('event_msg', { type: 'task_started', turn_id: 'turn-a' }), final(),
  row('event_msg', { type: 'task_complete', turn_id: 'turn-a' })];
const encode = (rows: object[]) => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
const parse = (rows: object[], id = 'msg_a') => parseCodexForkCutoff(encode(rows), 'source', '/project', id);

test('exact durable final binds a completed historical turn even when a later turn is active', () => {
  assert.equal(parse(entries()).hasLaterTurns, false);
  const result = parse([...entries(), row('event_msg', { type: 'task_started', turn_id: 'turn-b' }), final('msg_b', 'turn-b', 'commentary')]);
  assert.equal(result.turnId, 'turn-a');
  assert.equal(result.hasLaterTurns, true);
});

test('rejects commentary, synthetic ids, missing completion, duplicate and mismatched turn evidence', () => {
  for (const rows of [entries().slice(0, -1), [...entries(), final()],
    [entries()[0], entries()[1], final('msg_a', 'turn-a', 'commentary'), entries()[3]],
    [entries()[0], entries()[1], final('msg_a', 'turn-b'), entries()[3]],
    [entries()[0], entries()[1], final(), final('msg_b'), entries()[3]],
    [...entries(), row('event_msg', { type: 'turn_aborted', turn_id: 'turn-a' })],
    [...entries(), entries()[3]],
  ]) assert.throws(() => parse(rows), /unsupported_cutoff/);
  for (const id of ['item_0', 'codex-history-x', '']) assert.throws(() => parse(entries(), id));
  assert.throws(() => parseCodexForkCutoff(encode(entries()).trimEnd(), 'source', '/project', 'msg_a'));
  assert.throws(() => parseCodexForkCutoff(encode(entries()), 'foreign', '/project', 'msg_a'));
});

test('pins fd and prefix, allows appended later turns, rejects same-inode edits and replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-cutoff-'));
  try {
    const projectPath = path.join(root, 'project');
    const codexHome = path.join(root, 'codex');
    await mkdir(projectPath); await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
    const filePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
    await writeFile(filePath, encode(entries(projectPath)));
    const input = { filePath, codexHome, projectPath, sessionId: 'source', messageId: 'msg_a' };
    const proof = await openCodexForkCutoff(input);
    try {
      await appendFile(filePath, encode([row('event_msg', { type: 'task_started', turn_id: 'turn-b' })]));
      await proof.verify();
      await writeFile(filePath, encode(entries(projectPath)).replace('Answer', 'Changed'));
      await assert.rejects(proof.verify());
    } finally { await proof.close(); }
    await writeFile(filePath, encode(entries(projectPath)));
    const replaced = await openCodexForkCutoff(input);
    try {
      await rename(filePath, filePath + '.old');
      await writeFile(filePath, encode(entries(projectPath)));
      await assert.rejects(replaced.verify());
    } finally { await replaced.close(); }
    await symlink(filePath, filePath + '.link');
    await assert.rejects(openCodexForkCutoff({ ...input, filePath: filePath + '.link' }));
    await link(filePath, filePath + '.hard');
    await assert.rejects(openCodexForkCutoff(input));
    await writeFile(path.join(root, 'outside.jsonl'), encode(entries(projectPath)));
    await assert.rejects(openCodexForkCutoff({ ...input, filePath: path.join(root, 'outside.jsonl') }));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('history eligibility appears only at exact completion and is revoked for duplicates or abort', () => {
  const tracker = createCodexFinalResponseTracker();
  const raw: any = { uuid: 'msg_a' };
  tracker.observe(entries()[1]); tracker.observe(final()); tracker.bind(raw);
  assert.equal(raw.transcriptMessageId, undefined);
  tracker.observe(entries()[3]);
  assert.equal(raw.transcriptMessageId, 'msg_a');
  tracker.observe(final());
  assert.equal(raw.transcriptMessageId, undefined);
  const interrupted = createCodexFinalResponseTracker();
  interrupted.observe(final()); interrupted.bind(raw);
  interrupted.observe({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-a' } });
  interrupted.observe(entries()[3]);
  assert.equal(raw.transcriptMessageId, undefined);
});
