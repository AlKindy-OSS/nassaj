/**
 * B-1564: history readers open a stored transcript path only when it
 * realpath-resolves under its provider's root (Claude projects, Codex sessions,
 * agy brains). A path outside every root, a symlink inside a root that escapes
 * it, and a missing file all read as "no transcript" — an empty history, never
 * a crash, never a read of the named file. A valid path still reads.
 *
 * Transcripts are the real-derived share fixtures (__fixtures__/session-share,
 * `/home/operator` placeholders), laid out where each live reader looks.
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, participantsDb, sessionsDb, userDb } from '@/modules/database/index.js';

import { getAgyBrainDir } from '../list/antigravity/agy-brain-dir.js';
import { AntigravitySessionsProvider } from '../list/antigravity/antigravity-sessions.provider.js';
import { CodexSessionsProvider } from '../list/codex/codex-sessions.provider.js';
import { HistoryBudgetError } from '../services/history-budget.service.js';
import { resetHistorySnapshotCacheForTests } from '../services/session-history-light.service.js';
import { sessionsService } from '../services/sessions.service.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'services', '__fixtures__', 'session-share');
/** Outside every provider root: a sibling of the sandbox HOME. */
const OUTSIDE = fs.mkdtempSync(path.join(path.dirname(SANDBOX_HOME), 'nassaj-outside-'));
process.on('exit', () => fs.rmSync(OUTSIDE, { recursive: true, force: true }));

await initializeDatabase();
const ownerId = userDb.createUser('containment-owner', 'hash-o', 'user').id;

type Layout = 'valid' | 'outside' | 'symlink' | 'missing';

/** Copies `fixture` to `target`, or lays out the case's defect at `target`. */
function place(layout: Layout, target: string, fixture: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (layout === 'valid') {
    fs.copyFileSync(path.join(FIXTURES, fixture), target);
    return target;
  }
  if (layout === 'missing') return target;
  const foreign = path.join(OUTSIDE, `${layout}-${path.basename(path.dirname(target))}`, path.basename(target));
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), foreign);
  if (layout === 'outside') return foreign;
  fs.symlinkSync(foreign, target);
  return target;
}

/** Paths opened through fs.createReadStream while `body` runs. */
async function openedDuring(body: () => Promise<void>): Promise<string[]> {
  const original = fs.createReadStream;
  const opened: string[] = [];
  (fs as { createReadStream: unknown }).createReadStream = (file: fs.PathLike, ...rest: unknown[]) => {
    opened.push(String(file));
    return (original as (...args: unknown[]) => fs.ReadStream)(file, ...rest);
  };
  try {
    await body();
  } finally {
    fs.createReadStream = original;
  }
  return opened;
}

const assertNoForeignRead = (opened: string[]): void => {
  assert.deepEqual(opened.filter((file) => fs.existsSync(file) && fs.realpathSync(file).startsWith(OUTSIDE)), []);
};

/** Claude session id per layout (`000…a000…0013` is the fixture's own id for the valid case). */
const CLAUDE_IDS: Record<Layout, string> = {
  valid: '00000000-0000-4000-a000-000000000013',
  outside: '00000000-0000-4000-a000-000000000101',
  symlink: '00000000-0000-4000-a000-000000000102',
  missing: '00000000-0000-4000-a000-000000000103',
};

/** The Claude fixture re-keyed to `sessionId` (the reader keeps only rows of its own session). */
function claudeFixtureFor(sessionId: string): string {
  const name = `claude-${sessionId}.jsonl`;
  const target = path.join(OUTSIDE, 'fixtures', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = fs.readFileSync(path.join(FIXTURES, 'claude.jsonl'), 'utf8').replaceAll(CLAUDE_IDS.valid, sessionId);
  fs.writeFileSync(target, text);
  return path.relative(FIXTURES, target);
}

for (const layout of ['valid', 'outside', 'symlink', 'missing'] as const) {
  test(`claude history: ${layout} stored path`, async () => {
    const sessionId = CLAUDE_IDS[layout];
    const projects = path.join(SANDBOX_HOME, '.claude', 'projects', '-home-operator-Project-General');
    const file = place(layout, path.join(projects, `${sessionId}.jsonl`), claudeFixtureFor(sessionId));
    sessionsDb.createSession(sessionId, 'claude', '/home/operator/Project/General', undefined, undefined, undefined, file);
    participantsDb.recordSpawn(sessionId, ownerId);
    resetHistorySnapshotCacheForTests();

    let messages: unknown[] = [];
    const opened = await openedDuring(async () => {
      messages = (await sessionsService.fetchHistory(sessionId, ownerId, {})).messages;
    });
    assertNoForeignRead(opened);
    if (layout === 'valid') {
      assert.ok(JSON.stringify(messages).includes('كيف استفيد من هذي وانا داخل نساج'), 'the valid transcript still reads');
    } else {
      assert.equal(messages.length, 0, 'an uncontained or missing transcript reads as empty');
    }
  });
}

test('claude bounded history: an uncontained stored path is refused before the lease opens it', async () => {
  const sessionId = CLAUDE_IDS.outside;
  await assert.rejects(
    sessionsService.withHistoryLeaseCallback(sessionId, ownerId, {}, new AbortController().signal, () => {
      throw new Error('consumer must not run');
    }),
    (error: unknown) => error instanceof HistoryBudgetError && error.code === 'HISTORY_SOURCE_UNAVAILABLE',
  );
});

test('claude history: a subagent file symlinked outside its subagents dir is not read', async () => {
  const sessionId = CLAUDE_IDS.valid;
  const projects = path.join(SANDBOX_HOME, '.claude', 'projects', '-home-operator-Project-General');
  const lines = fs.readFileSync(path.join(projects, `${sessionId}.jsonl`), 'utf8').trimEnd().split('\n');
  const toolResult = lines.map((line) => JSON.parse(line)).find((row) => Array.isArray(row.message?.content)
    && row.message.content.some((part: { type?: string }) => part.type === 'tool_result'));
  assert.ok(toolResult, 'fixture carries a tool_result row');
  toolResult.toolUseResult = { agentId: 'escape' };
  fs.appendFileSync(path.join(projects, `${sessionId}.jsonl`), `${JSON.stringify(toolResult)}\n`);
  const foreign = path.join(OUTSIDE, 'agent-escape.jsonl');
  fs.writeFileSync(foreign, `${lines[0]}\n`);
  fs.mkdirSync(path.join(projects, sessionId, 'subagents'), { recursive: true });
  fs.symlinkSync(foreign, path.join(projects, sessionId, 'subagents', 'agent-escape.jsonl'));
  resetHistorySnapshotCacheForTests();

  const opened = await openedDuring(async () => {
    assert.ok((await sessionsService.fetchHistory(sessionId, ownerId, {})).messages.length > 0);
  });
  assertNoForeignRead(opened);
  assert.ok(!opened.some((file) => file.endsWith('agent-escape.jsonl')));
});

const CODEX_IDS: Record<Layout, string> = {
  valid: '00000000-0000-7000-9000-000000000001',
  outside: '00000000-0000-7000-9000-000000000101',
  symlink: '00000000-0000-7000-9000-000000000102',
  missing: '00000000-0000-7000-9000-000000000103',
};

for (const layout of ['valid', 'outside', 'symlink', 'missing'] as const) {
  test(`codex history: ${layout} stored path`, async () => {
    const sessionId = CODEX_IDS[layout];
    const file = place(layout, path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '09', '01',
      `rollout-2026-09-01T17-24-33-${sessionId}.jsonl`), 'codex.jsonl');
    sessionsDb.createSession(sessionId, 'codex', '/home/operator/Project/nassaj-dev', undefined, undefined, undefined, file);

    let messages: unknown[] = [];
    const opened = await openedDuring(async () => {
      messages = (await new CodexSessionsProvider().fetchHistory(sessionId, {})).messages;
    });
    assertNoForeignRead(opened);
    if (layout === 'valid') {
      assert.ok(JSON.stringify(messages).includes('ليش ماني قادر ابدأ محادثة'), 'the valid rollout still reads');
    } else {
      assert.equal(messages.length, 0, 'an uncontained or missing rollout reads as empty');
    }
  });
}

const AGY_IDS: Record<Layout, string> = {
  valid: '00000000-0000-4000-9000-000000000017',
  outside: '00000000-0000-4000-9000-000000000101',
  symlink: '00000000-0000-4000-9000-000000000102',
  missing: '00000000-0000-4000-9000-000000000103',
};

for (const layout of ['valid', 'outside', 'symlink', 'missing'] as const) {
  test(`agy history: ${layout} stored path`, async () => {
    const sessionId = AGY_IDS[layout];
    const file = place(layout, path.join(getAgyBrainDir(null), sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
      'antigravity.jsonl');
    sessionsDb.createSession(sessionId, 'antigravity', '/home/operator/Project/General', undefined, undefined, undefined, file);

    let messages: unknown[] = [];
    const opened = await openedDuring(async () => {
      messages = (await new AntigravitySessionsProvider().fetchHistory(sessionId, {})).messages;
    });
    assertNoForeignRead(opened);
    if (layout === 'valid') {
      assert.ok(messages.length > 0, 'the valid brain transcript still reads');
    } else {
      assert.equal(messages.length, 0, 'an uncontained or missing transcript reads as empty');
    }
  });
}

test('member trees: a transcript under a numbered member tree reads; a non-member dir there does not', async () => {
  const sessionId = '00000000-0000-4000-a000-000000000104';
  const fixture = claudeFixtureFor(sessionId);
  const member = path.join(SANDBOX_HOME, '.nassaj-users', '2', '.claude', 'projects', '-home-operator-Project-General');
  const stray = path.join(SANDBOX_HOME, '.nassaj-users', 'shared', '.claude', 'projects', '-home-operator-Project-General');
  for (const [dir, readable] of [[stray, false], [member, true]] as const) {
    fs.rmSync(path.join(SANDBOX_HOME, '.nassaj-users'), { recursive: true, force: true });
    const file = place('valid', path.join(dir, `${sessionId}.jsonl`), fixture);
    // ADR-201 A2: discovery never re-points a row into another tree; start fresh.
    getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    sessionsDb.createSession(sessionId, 'claude', '/home/operator/Project/General', undefined, undefined, undefined, file);
    participantsDb.recordSpawn(sessionId, ownerId);
    resetHistorySnapshotCacheForTests();
    const { messages } = await sessionsService.fetchHistory(sessionId, ownerId, {});
    assert.equal(messages.length > 0, readable, dir);
  }
});
