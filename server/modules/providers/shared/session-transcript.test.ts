/**
 * ADR-201 A1: `openSessionTranscript` / `openRecordedTranscript` and the pinned
 * open under them. Positive cases use the real-derived share fixtures
 * (__fixtures__/session-share, B-1520 redacted); every negative case is one
 * planted defect: forged header id, wrong basename, symlink, hardlink into
 * another tree, a path in another member tree (/1 vs /10 prefix trap), no
 * /proc, non-regular file, oversize header, swap between lstat and open,
 * and an id-looking text or nested key that must not bind.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, participantsDb, userDb } from '@/modules/database/index.js';
import { AGY_BRAIN_UNDER_HOME } from '@/modules/providers/list/antigravity/agy-brain-layout.js';

import { recordedTreeRoots } from './contained-file.js';
import { openPinned, PinnedOpenError, type PinnedRefusal } from './pinned-fd.js';
import { AMBIGUOUS_HEADER_VALUE, HEADER_SCAN_LIMIT_BYTES, scanHeaderRecords } from './transcript-header-scan.js';
import {
  isTranscriptHandle, openRecordedTranscript, openSessionArtifactDir, openSessionTranscript,
  SessionArtifactDir, type SessionTranscriptResult,
} from './session-transcript.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'services', '__fixtures__', 'session-share');
const CLAUDE_FIXTURE_ID = '00000000-0000-4000-a000-000000000013';
const CODEX_FIXTURE_ID = '00000000-0000-7000-9000-000000000001';
const USERS = path.join(SANDBOX_HOME, '.nassaj-users');
const CLAUDE_PROJECT = '-home-operator-Project-General';

await initializeDatabase();
const ownerId = userDb.createUser('transcript-owner', 'hash-o', 'user').id;
const strangerId = userDb.createUser('transcript-stranger', 'hash-s', 'user').id;

let counter = 0;
/** A fresh session id in the fixture's UUID shape. */
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(12, '0')}`;
}

/** Inserts the session row directly (no discovery writer) and records the owner's spawn. */
function recordSession(sessionId: string, provider: string, jsonlPath: string | null): void {
  getConnection().prepare('INSERT INTO sessions (session_id, provider, jsonl_path) VALUES (?, ?, ?)')
    .run(sessionId, provider, jsonlPath);
  participantsDb.recordSpawn(sessionId, ownerId);
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const claudeText = (sessionId: string): string =>
  fs.readFileSync(path.join(FIXTURES, 'claude.jsonl'), 'utf8').replaceAll(CLAUDE_FIXTURE_ID, sessionId);
const codexText = (sessionId: string): string =>
  fs.readFileSync(path.join(FIXTURES, 'codex.jsonl'), 'utf8').replaceAll(CODEX_FIXTURE_ID, sessionId);

const claudeOperatorFile = (name: string): string =>
  path.join(SANDBOX_HOME, '.claude', 'projects', CLAUDE_PROJECT, name);
const claudeMemberFile = (member: string, name: string): string =>
  path.join(USERS, member, '.claude', 'projects', CLAUDE_PROJECT, name);
const codexFile = (sessionId: string): string =>
  path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '09', '01', `rollout-2026-09-01T17-24-33-${sessionId}.jsonl`);

/** Opens as the owner and closes any handle; resolves to `'ok'` or the refusal reason. */
async function outcome(sessionId: string, requester: number | null = ownerId): Promise<string> {
  const result: SessionTranscriptResult = await openSessionTranscript(sessionId, requester, 'history');
  if (!isTranscriptHandle(result)) return result.reason;
  await result.fd.close();
  return 'ok';
}

test('claude: a valid operator transcript opens pinned, with its realpath and fstat', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  const file = write(claudeOperatorFile(`${id}.jsonl`), claudeText(id));
  recordSession(id, 'claude', file);
  const result = await openSessionTranscript(id, ownerId, 'history');
  assert.ok(isTranscriptHandle(result));
  try {
    assert.equal(result.realpath, fs.realpathSync(file));
    assert.equal(result.stat.size, BigInt(fs.statSync(file).size));
    assert.equal(fs.readlinkSync(`/proc/self/fd/${result.fd.fd}`), result.realpath);
  } finally {
    await result.fd.close();
  }
});

test('authorisation: a stranger and an anonymous requester both get not_found', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  recordSession(id, 'claude', write(claudeOperatorFile(`${id}.jsonl`), claudeText(id)));
  assert.equal(await outcome(id, strangerId), 'not_found');
  assert.equal(await outcome(id, null), 'not_found');
  assert.equal(await outcome('no-such-session'), 'not_found');
});

test('claude: a forged header id (another session\'s content under this name) is refused', async () => {
  const victim = nextId('00000000-0000-4000-a000-');
  const forged = nextId('00000000-0000-4000-a000-');
  recordSession(forged, 'claude', write(claudeOperatorFile(`${forged}.jsonl`), claudeText(victim)));
  assert.equal(await outcome(forged), 'id_mismatch');
});

test('claude: a file whose basename is not <sessionId>.jsonl is refused', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  recordSession(id, 'claude', write(claudeOperatorFile(`other-${id}.jsonl`), claudeText(id)));
  assert.equal(await outcome(id), 'name_mismatch');
});

test('claude: an id-less header is refused; a long first record is read to its id; past the scan bound is oversize', async () => {
  const bare = nextId('00000000-0000-4000-a000-');
  recordSession(bare, 'claude', write(claudeOperatorFile(`${bare}.jsonl`), '{"type":"summary"}\n'));
  assert.equal(await outcome(bare), 'header_missing');
  // A conversation opening with a pasted log: `sessionId` is the last key of a 900 KB first record.
  const long = nextId('00000000-0000-4000-a000-');
  const record = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(900 * 1024) }, sessionId: long });
  recordSession(long, 'claude', write(claudeOperatorFile(`${long}.jsonl`), `${record}\n`));
  assert.equal(await outcome(long), 'ok');
  const big = nextId('00000000-0000-4000-a000-');
  const huge = JSON.stringify({ type: 'user', pad: 'x'.repeat(HEADER_SCAN_LIMIT_BYTES), sessionId: big });
  recordSession(big, 'claude', write(claudeOperatorFile(`${big}.jsonl`), `${huge}\n`));
  assert.equal(await outcome(big), 'header_oversize');
});

test('header scan: only a key at the exact path counts, never text or a nested key', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'scan-'));
  const lines = [
    { type: 'summary', text: '"sessionId":"victim"' },
    { message: { sessionId: 'victim' }, list: [{ sessionId: 'victim' }] },
    { sessionId: 'own', payload: { id: 'p', nested: { id: 'deep' } } },
  ].map((line) => JSON.stringify(line)).join('\n');
  const file = write(path.join(dir, 'h.jsonl'), lines);
  const { handle } = await openPinned(file, 'file');
  try {
    const seen: Array<Record<string, string>> = [];
    const end = await scanHeaderRecords(handle, [['sessionId'], ['payload', 'id']], (record) => {
      seen.push({ ...record });
      return 'next';
    });
    assert.equal(end, 'eof');
    assert.deepEqual(seen, [{}, {}, { sessionId: 'own', 'payload.id': 'p' }]);
  } finally {
    await handle.close();
  }
});

test('R3: a duplicate target key of any value type, or of a target\'s parent, is ambiguous', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'scan-r3-'));
  const lines = [
    '{"sessionId":"own","sessionId":123}', // JSON.parse reads 123
    '{"sessionId":"own","sessionId":null}',
    '{"sessionId":{"x":"own"},"sessionId":"own"}',
    '{"sessionId":["own"],"sessionId":true}',
    '{"payload":{"id":"p"},"payload":7}', // payload.id is gone for JSON.parse
    '{"payload":{"id":"p"},"payload":{"other":1}}',
    '{"payload.id":"alias","sessionId":5}', // a dotted key is not the path payload.id
    '{"list":[{"sessionId":"a"},{"sessionId":"b"}],"payload":{"id":"p"}}',
  ].join('\n');
  const file = write(path.join(dir, 'r3.jsonl'), `${lines}\n`);
  const { handle } = await openPinned(file, 'file');
  try {
    const seen: Array<Record<string, string>> = [];
    await scanHeaderRecords(handle, [['sessionId'], ['payload', 'id']], (record) => {
      seen.push({ ...record });
      return 'next';
    });
    const ambiguous = AMBIGUOUS_HEADER_VALUE;
    assert.deepEqual(seen, [
      { sessionId: ambiguous }, { sessionId: ambiguous }, { sessionId: ambiguous }, { sessionId: ambiguous },
      { 'payload.id': ambiguous }, { 'payload.id': ambiguous }, {}, { 'payload.id': 'p' },
    ]);
  } finally {
    await handle.close();
  }
});

test('L4: a duplicate or escaped target key never binds (JSON.parse would read another value)', async () => {
  const victim = nextId('00000000-0000-4000-a000-');
  // JSON.parse keeps the LAST duplicate; the scanner used to keep the first.
  const duplicate = nextId('00000000-0000-4000-a000-');
  recordSession(duplicate, 'claude', write(claudeOperatorFile(`${duplicate}.jsonl`),
    `{"type":"user","sessionId":"${duplicate}","sessionId":"${victim}"}\n${claudeText(victim)}`));
  assert.equal(await outcome(duplicate), 'id_mismatch');
  // An escaped key decodes to `sessionId` for JSON.parse but was invisible to the scanner.
  const escapedKey = nextId('00000000-0000-4000-a000-');
  recordSession(escapedKey, 'claude', write(claudeOperatorFile(`${escapedKey}.jsonl`),
    `{"type":"user","sessionId":"${escapedKey}","session\\u0049d":"${victim}"}\n`));
  assert.equal(await outcome(escapedKey), 'id_mismatch');
  // An escaped VALUE at the target key is refused rather than skipped to a later record.
  const escapedValue = nextId('00000000-0000-4000-a000-');
  recordSession(escapedValue, 'claude', write(claudeOperatorFile(`${escapedValue}.jsonl`),
    `{"type":"user","sessionId":"\\u0030${victim.slice(1)}"}\n{"type":"user","sessionId":"${escapedValue}"}\n`));
  assert.equal(await outcome(escapedValue), 'id_mismatch');
  // Codex: a duplicate payload.id in session_meta.
  const thread = nextId('00000000-0000-7000-9000-');
  const meta = `{"type":"session_meta","payload":{"id":"${thread}","id":"${victim}","session_id":"${thread}"}}`;
  recordSession(thread, 'codex', write(codexFile(thread), `${meta}\n`));
  assert.equal(await outcome(thread), 'id_mismatch');
});

test('claude: a symlink escaping into another member tree is refused at the recorded name', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  const foreign = write(claudeMemberFile('10', `${id}.jsonl`), claudeText(id));
  const planted = claudeMemberFile('1', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.symlinkSync(foreign, planted);
  recordSession(id, 'claude', planted);
  // A1.5: the last component is never resolved, so the symlink itself is refused.
  assert.equal(await outcome(id), 'symlink');
});

test('claude: a hardlink of another tree\'s file is refused as multiply linked', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  const foreign = write(claudeMemberFile('10', `${id}.jsonl`), claudeText(id));
  const planted = claudeMemberFile('1', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.linkSync(foreign, planted);
  recordSession(id, 'claude', planted);
  assert.equal(await outcome(id), 'multiply_linked');
});

test('member trees: /10 is its own tree, never /1 (prefix trap), and a non-numeric tree has none', async () => {
  const under = path.join('.claude', 'projects');
  assert.deepEqual(await recordedTreeRoots(claudeMemberFile('10', 'x.jsonl'), [], under), [path.join(USERS, '10', under)]);
  assert.deepEqual(await recordedTreeRoots(claudeMemberFile('1', 'x.jsonl'), [], under), [path.join(USERS, '1', under)]);
  assert.deepEqual(await recordedTreeRoots(path.join(USERS, '1x', under, 'x.jsonl'), [], under), []);
  assert.deepEqual(await recordedTreeRoots(path.join(USERS, '1', 'x.jsonl'), [], null), []);
  const id = nextId('00000000-0000-4000-a000-');
  recordSession(id, 'claude', write(claudeMemberFile('10', `${id}.jsonl`), claudeText(id)));
  assert.equal(await outcome(id), 'ok');
});

test('claude: a path in the users root but outside the provider root of its tree is refused', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  recordSession(id, 'claude', write(path.join(USERS, '1', 'notes', `${id}.jsonl`), claudeText(id)));
  assert.equal(await outcome(id), 'outside_tree');
});

test('non-regular: a directory or a FIFO at the recorded path is never opened', async () => {
  // Claude's legacy-spelling lookup admits only regular files, so it never even pins these.
  const dirId = nextId('00000000-0000-4000-a000-');
  const dir = claudeOperatorFile(`${dirId}.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  recordSession(dirId, 'claude', dir);
  assert.equal(await outcome(dirId), 'missing');
  // Codex takes the recorded path as is: the pinned open refuses the FIFO before opening it.
  const fifoId = nextId('00000000-0000-7000-9000-');
  const fifo = codexFile(fifoId);
  fs.mkdirSync(path.dirname(fifo), { recursive: true });
  execFileSync('mkfifo', [fifo]);
  recordSession(fifoId, 'codex', fifo);
  assert.equal(await outcome(fifoId), 'wrong_kind');
  const dirCodex = nextId('00000000-0000-7000-9000-');
  fs.mkdirSync(codexFile(dirCodex), { recursive: true });
  recordSession(dirCodex, 'codex', codexFile(dirCodex));
  assert.equal(await outcome(dirCodex), 'wrong_kind');
});

test('codex: session_meta id, rollout name, a long header and one past the scan bound', async () => {
  const id = nextId('00000000-0000-7000-9000-');
  recordSession(id, 'codex', write(codexFile(id), codexText(id)));
  assert.equal(await outcome(id), 'ok');
  const forged = nextId('00000000-0000-7000-9000-');
  recordSession(forged, 'codex', write(codexFile(forged), codexText(id)));
  assert.equal(await outcome(forged), 'id_mismatch');
  const misnamed = nextId('00000000-0000-7000-9000-');
  recordSession(misnamed, 'codex', write(path.join(path.dirname(codexFile(misnamed)), `${misnamed}.jsonl`), codexText(misnamed)));
  assert.equal(await outcome(misnamed), 'name_mismatch');
  const late = nextId('00000000-0000-7000-9000-');
  const meta = JSON.stringify({ type: 'session_meta', payload: { pad: 'x'.repeat(70 * 1024), id: late } });
  recordSession(late, 'codex', write(codexFile(late), `${meta}\n`));
  assert.equal(await outcome(late), 'ok', 'a session_meta longer than 64 KiB still binds');
  const big = nextId('00000000-0000-7000-9000-');
  const huge = JSON.stringify({ type: 'session_meta', payload: { pad: 'x'.repeat(HEADER_SCAN_LIMIT_BYTES), id: big } });
  recordSession(big, 'codex', write(codexFile(big), `${huge}\n`));
  assert.equal(await outcome(big), 'header_oversize');
});

test('agy: the brain directory must be the session id', async () => {
  const brain = path.join(SANDBOX_HOME, AGY_BRAIN_UNDER_HOME);
  const transcriptIn = (dir: string) => path.join(brain, dir, '.system_generated', 'logs', 'transcript.jsonl');
  const text = fs.readFileSync(path.join(FIXTURES, 'antigravity.jsonl'), 'utf8');
  const id = nextId('00000000-0000-4000-9000-');
  recordSession(id, 'antigravity', write(transcriptIn(id), text));
  assert.equal(await outcome(id), 'ok');
  const other = nextId('00000000-0000-4000-9000-');
  recordSession(other, 'antigravity', write(transcriptIn(`${other}-x`), text));
  assert.equal(await outcome(other), 'id_mismatch');
});

test('vendor: the file must be <sessionId>.jsonl under the provider root; cursor/opencode are unsupported', async () => {
  const root = path.join(SANDBOX_HOME, '.nassaj-vendor-sessions', 'kimi', 'ce97e852666bc48e239320856e29f3d2');
  const text = fs.readFileSync(path.join(FIXTURES, 'kimi.jsonl'), 'utf8');
  const id = `kimi_${nextId('00000000-0000-4000-8000-')}`;
  recordSession(id, 'kimi', write(path.join(root, `${id}.jsonl`), text));
  assert.equal(await outcome(id), 'ok');
  const misnamed = `kimi_${nextId('00000000-0000-4000-8000-')}`;
  recordSession(misnamed, 'kimi', write(path.join(root, `${misnamed}-copy.jsonl`), text));
  assert.equal(await outcome(misnamed), 'name_mismatch');
  const cursorId = nextId('00000000-0000-4000-8000-');
  recordSession(cursorId, 'cursor', null);
  assert.equal(await outcome(cursorId), 'unsupported_provider');
});

test('openRecordedTranscript (post-authorisation) applies the same tree and id checks', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  const file = write(claudeOperatorFile(`${id}.jsonl`), claudeText(nextId('00000000-0000-4000-a000-')));
  const result = await openRecordedTranscript({ session_id: id, provider: 'claude', jsonl_path: file }, 'history');
  assert.deepEqual(result, { reason: 'id_mismatch' });
});

async function refusalOf(run: () => Promise<unknown>): Promise<PinnedRefusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PinnedOpenError) return error.reason;
    throw error;
  }
  assert.fail('the pinned open was expected to refuse');
}

test('pinned-fd: symlink, relative path, /proc missing and a swap between lstat and open are refused', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'pinned-'));
  const file = write(path.join(dir, 'a.jsonl'), 'a\n');
  const link = path.join(dir, 'link.jsonl');
  fs.symlinkSync(file, link);
  assert.equal(await refusalOf(() => openPinned(link, 'file')), 'symlink');
  assert.equal(await refusalOf(() => openPinned('relative.jsonl', 'file')), 'not_absolute');
  assert.equal(await refusalOf(() => openPinned(file, 'file', { procFdDir: path.join(dir, 'no-proc') })), 'proc_unavailable');
  assert.equal(await refusalOf(() => openPinned(file, 'file', { via: write(path.join(dir, 'b.jsonl'), 'b\n') })), 'path_mismatch');
  let step = 0;
  const swap = () => {
    step += 1;
    if (step === 2) fs.renameSync(write(path.join(dir, 'c.jsonl'), 'c\n'), file);
  };
  assert.equal(await refusalOf(() => openPinned(file, 'file', { checkpoint: swap })), 'changed_during_open');
  const released: number[] = [];
  const pinned = await openPinned(file, 'file', { singleLink: true, release: async (h) => { released.push(h.fd); await h.close(); } });
  await pinned.handle.close();
  assert.deepEqual(released, []);
});

test('artifact dirs: listed and opened through the pinned descriptor; symlinked dirs and children refused', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  const file = write(claudeOperatorFile(`${id}.jsonl`), claudeText(id));
  const subagents = path.join(path.dirname(file), id, 'subagents');
  write(path.join(subagents, 'agent-a.jsonl'), '{}\n');
  const outside = write(path.join(SANDBOX_HOME, 'outside', 'agent-b.jsonl'), '{}\n');
  fs.symlinkSync(outside, path.join(subagents, 'agent-b.jsonl'));
  fs.linkSync(path.join(subagents, 'agent-a.jsonl'), path.join(SANDBOX_HOME, 'outside', 'agent-a-link.jsonl'));
  write(path.join(subagents, 'workflows', 'wf_1', 'journal.jsonl'), '{}\n');
  recordSession(id, 'claude', file);
  const transcript = await openSessionTranscript(id, ownerId, 'history');
  assert.ok(isTranscriptHandle(transcript));
  const dir = await openSessionArtifactDir(transcript, 'subagents');
  assert.ok(dir instanceof SessionArtifactDir);
  try {
    assert.deepEqual((await dir.list()).sort(), ['agent-a.jsonl', 'agent-b.jsonl', 'workflows']);
    assert.deepEqual(await dir.openFile('agent-b.jsonl'), { reason: 'symlink' });
    assert.deepEqual(await dir.openFile('agent-a.jsonl'), { reason: 'multiply_linked' });
    assert.deepEqual(await dir.openFile('../x.jsonl'), { reason: 'not_absolute' });
    const journal = await dir.openFile('workflows/wf_1/journal.jsonl');
    assert.deepEqual(journal, { reason: 'not_absolute' }, 'children are at most two segments deep');
  } finally {
    await dir.close();
  }
  const workflows = await openSessionArtifactDir(transcript, 'workflows');
  assert.ok(workflows instanceof SessionArtifactDir);
  const journal = await workflows.openFile('wf_1/journal.jsonl');
  assert.ok('handle' in journal);
  await workflows.close();
  await transcript.fd.close();
});

test('artifact dirs: a symlinked session directory is refused', async () => {
  const id = nextId('00000000-0000-4000-a000-');
  const file = write(claudeOperatorFile(`${id}.jsonl`), claudeText(id));
  const elsewhere = path.join(SANDBOX_HOME, 'elsewhere', id);
  fs.mkdirSync(path.join(elsewhere, 'subagents'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(path.dirname(file), id));
  recordSession(id, 'claude', file);
  const transcript = await openSessionTranscript(id, ownerId, 'history');
  assert.ok(isTranscriptHandle(transcript));
  assert.deepEqual(await openSessionArtifactDir(transcript, 'subagents'), { reason: 'path_mismatch' });
  await transcript.fd.close();
});

test('history service: both paths read the bound transcript and refuse a forged one', async () => {
  const { sessionsService } = await import('../services/sessions.service.js');
  const { HistoryBudgetError } = await import('../services/history-budget.service.js');
  const { resetHistorySnapshotCacheForTests } = await import('../services/session-history-light.service.js');
  const valid = nextId('00000000-0000-4000-a000-');
  recordSession(valid, 'claude', write(claudeOperatorFile(`${valid}.jsonl`), claudeText(valid)));
  const forged = nextId('00000000-0000-4000-a000-');
  recordSession(forged, 'claude', write(claudeOperatorFile(`${forged}.jsonl`), claudeText(valid)));
  resetHistorySnapshotCacheForTests();
  assert.ok((await sessionsService.fetchHistory(valid, ownerId, {})).messages.length > 0, 'unleased: valid reads');
  assert.equal((await sessionsService.fetchHistory(forged, ownerId, {})).messages.length, 0, 'unleased: forged reads empty');
  await assert.rejects(
    sessionsService.withHistoryLeaseCallback(forged, ownerId, {}, new AbortController().signal, () => {
      throw new Error('consumer must not run');
    }),
    (error: unknown) => error instanceof HistoryBudgetError && error.code === 'HISTORY_SOURCE_UNAVAILABLE',
  );
  let leasedMessages = 0;
  await sessionsService.withHistoryLeaseCallback(valid, ownerId, {}, new AbortController().signal, (payload) => {
    leasedMessages = payload.messages.length;
  });
  assert.ok(leasedMessages > 0, 'leased: valid reads through the adopted descriptor');
});

test('N1: a transcript or directory denied by chmod is refused as unreadable, and history reads nothing', async () => {
  const { sessionsService } = await import('../services/sessions.service.js');
  const { HistoryBudgetError } = await import('../services/history-budget.service.js');
  const { resetHistorySnapshotCacheForTests } = await import('../services/session-history-light.service.js');
  for (const deny of ['file', 'directory'] as const) {
    const id = nextId('00000000-0000-4000-a000-');
    const file = write(path.join(USERS, '1', '.claude', 'projects', `-n1-${deny}`, `${id}.jsonl`), claudeText(id));
    recordSession(id, 'claude', file);
    const target = deny === 'file' ? file : path.dirname(file);
    fs.chmodSync(target, 0o000);
    try {
      assert.equal(await outcome(id), 'unreadable', deny);
      resetHistorySnapshotCacheForTests();
      assert.equal((await sessionsService.fetchHistory(id, ownerId, {})).messages.length, 0, `${deny}: unleased reads empty`);
      await assert.rejects(
        sessionsService.withHistoryLeaseCallback(id, ownerId, {}, new AbortController().signal, () => {
          throw new Error('consumer must not run');
        }),
        (error: unknown) => error instanceof HistoryBudgetError && error.code === 'HISTORY_SOURCE_UNAVAILABLE',
      );
    } finally {
      fs.chmodSync(target, deny === 'file' ? 0o600 : 0o700);
    }
    assert.equal(await outcome(id), 'ok', `${deny}: readable again once access is restored`);
  }
});
