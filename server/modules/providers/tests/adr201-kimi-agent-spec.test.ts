/**
 * ADR-201 qa M4 — native Kimi agent transcripts.
 *
 * The Kimi agent synchronizer records `<KIMI_CODE_HOME>/sessions/<id>/agents/
 * <agentId>/wire.jsonl` under provider `kimi`, while the reader confined `kimi`
 * to nassaj's vendor tree with `<id>.jsonl` names, so every such row was
 * refused (`outside_tree`) and its history came back empty. The `kimi` spec now
 * has the agent layout as its member/operator tree: root `<home>/.kimi/sessions`,
 * bound by the session directory name (`<id>/agents/<agentId>/wire.jsonl`
 * exactly), opened pinned like every transcript. No hash fallback is involved.
 *
 * The wire header shape (`{"type":"metadata","protocol_version","created_at"}`)
 * is the key set of a real file on this host (2026-10-12); every value is replaced.
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { initializeDatabase } from '@/modules/database/index.js';
import { isTranscriptHandle, openRecordedTranscript } from '@/modules/providers/shared/session-transcript-reader.js';
import { isVendorTranscriptProvider, transcriptSpecOf } from '@/modules/providers/shared/session-transcript-specs.js';
import { vendorTranscriptPath } from '@/modules/providers/shared/vendor/vendor-transcript.js';
import { KIMI_HOME_SUBDIR } from '@/services/isolation/provision-user-dirs.js';

await initializeDatabase();

const USERS = path.join(SANDBOX_HOME, '.nassaj-users');
const MEMBER = 1;
const OTHER = 10;
const memberSessions = (member: number) => path.join(USERS, String(member), KIMI_HOME_SUBDIR, 'sessions');
const OPERATOR_SESSIONS = path.join(SANDBOX_HOME, KIMI_HOME_SUBDIR, 'sessions');
const wire = (sessions: string, sessionId: string, agentId = 'main') =>
  path.join(sessions, sessionId, 'agents', agentId, 'wire.jsonl');
const WIRE_TEXT = `${JSON.stringify({ type: 'metadata', protocol_version: '0.0', created_at: 0 })}\n`;

function write(file: string, text = WIRE_TEXT): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function openReason(sessionId: string, jsonlPath: string): Promise<string> {
  const original = console.warn;
  console.warn = () => {};
  try {
    const opened = await openRecordedTranscript({ session_id: sessionId, provider: 'kimi', jsonl_path: jsonlPath }, 'history');
    if (!isTranscriptHandle(opened)) return opened.reason;
    await opened.fd.close();
    return 'ok';
  } finally {
    console.warn = original;
  }
}

test('M4: a recorded native Kimi agent wire.jsonl opens, in a member tree and the operator tree', async () => {
  const id = 'session_00000000-0000-4000-a204-000000000001';
  assert.equal(await openReason(id, write(wire(memberSessions(MEMBER), id))), 'ok');
  const operatorId = 'session_00000000-0000-4000-a204-000000000002';
  assert.equal(await openReason(operatorId, write(wire(OPERATOR_SESSIONS, operatorId))), 'ok');
  // A subagent folder of the same conversation is bound by the same directory.
  assert.equal(await openReason(id, write(wire(memberSessions(MEMBER), id, 'sub-1'))), 'ok');
});

test('M4: the session directory binds the id; layout, links and other trees are refused', async () => {
  const id = 'session_00000000-0000-4000-a204-000000000003';
  const victim = 'session_00000000-0000-4000-a204-000000000004';
  // A wire.jsonl in another conversation's directory never reads as this one.
  assert.equal(await openReason(id, write(wire(memberSessions(MEMBER), victim))), 'id_mismatch');
  // Exactly `<id>/agents/<agentId>/wire.jsonl`.
  assert.equal(await openReason(id, write(path.join(memberSessions(MEMBER), id, 'wire.jsonl'))), 'id_mismatch');
  assert.equal(await openReason(id, write(path.join(memberSessions(MEMBER), id, 'agents', 'main', `${id}.jsonl`))),
    'name_mismatch');
  // A symlink planted at the recorded name is refused as such (pinned no-follow open).
  const linked = wire(memberSessions(MEMBER), 'session_00000000-0000-4000-a204-000000000005');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(write(wire(memberSessions(OTHER), 'session_00000000-0000-4000-a204-000000000005')), linked);
  assert.equal(await openReason('session_00000000-0000-4000-a204-000000000005', linked), 'symlink');
  // Outside every Kimi tree.
  assert.equal(await openReason(id, write(wire(path.join(SANDBOX_HOME, 'elsewhere'), id))), 'outside_tree');
});

test('M4: the vendor layout is unchanged and kimi stays a vendor transcript provider', async () => {
  const id = 'kimi-vendor-0001';
  const file = write(vendorTranscriptPath('kimi', id, '/work/project'), '{"type":"meta"}\n');
  assert.equal(await openReason(id, file), 'ok');
  assert.equal(isVendorTranscriptProvider('kimi'), true, 'a row with no recorded path keeps its vendor lookup');
  assert.equal(transcriptSpecOf('kimi')?.underHome, path.join(KIMI_HOME_SUBDIR, 'sessions'));
});
