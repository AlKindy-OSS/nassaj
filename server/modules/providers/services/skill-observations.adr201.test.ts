/**
 * ADR-201 qa M1 — the skill-observation readers open transcripts through the
 * pinned reader (openRecordedTranscript / openSessionArtifactDir / openBoundFile)
 * instead of realpath + open-by-name. Each case below was read by the old code:
 *   - a symlink at the recorded name (to a same-tree file under the right name);
 *   - a hardlink of another member's transcript at the recorded name;
 *   - (guard only: the old parser already marked it ambiguous) a file under the
 *     session's name whose leading record names another session;
 *   - a symlinked `subagents` directory and a hardlinked subagent file;
 *   - a Codex child rollout that is a hardlink.
 * The control session reads normally. Record shapes are those of the service
 * test (Claude `tool_use` Skill calls, Codex `session_meta` + `function_call`).
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('M1: skill observations never read a transcript the pinned reader refuses', async (t) => {
  const fixture = await fs.mkdtemp('/var/tmp/skill-observations-adr201-');
  const originalHome = os.homedir;
  os.homedir = () => fixture;
  const previousDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(fixture, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  const db = await import('@/modules/database/index.js');
  const { readSessionSkills } = await import('./skill-observations.service.js');
  const sharing = await import('@/services/provider-sharing.js');
  db.closeConnection();
  await db.initializeDatabase();
  sharing._resetProviderSharingCache();
  try {
    const alice = db.userDb.createUser('m1-alice', 'hash-a', 'user').id;
    const mallory = db.userDb.createUser('m1-mallory', 'hash-m', 'user').id;
    const workspace = path.join(fixture, 'workspace');
    await fs.mkdir(workspace);
    const projectsOf = (user: number) => path.join(fixture, '.nassaj-users', String(user), '.claude', 'projects', 'fixture');
    const projects = projectsOf(alice);
    const foreign = projectsOf(mallory);
    await fs.mkdir(projects, { recursive: true });
    await fs.mkdir(foreign, { recursive: true });
    const call = (id: string, skill: string, session: string) => ({
      type: 'assistant', sessionId: session, timestamp: '2026-10-12T12:00:00Z',
      message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
    });
    const text = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const register = (session: string, file: string, provider = 'claude') => {
      db.sessionsDb.createSession(session, provider, workspace, undefined, undefined, undefined, file);
      db.participantsDb.recordSpawn(session, alice);
    };
    const attempts = async (session: string, provider = 'claude') =>
      (await readSessionSkills(session, provider, alice)).summary.invocationAttempts;

    await t.test('control: a genuine transcript is read', async () => {
      const file = path.join(projects, 'm1-control.jsonl');
      await fs.writeFile(file, text([call('c1', 'zqcontrol', 'm1-control')]));
      register('m1-control', file);
      assert.equal(await attempts('m1-control'), 1);
    });

    await t.test('a symlink at the recorded name is refused, even to a same-tree file of that name', async () => {
      const elsewhere = path.join(projects, 'other-dir', 'm1-link.jsonl');
      await fs.mkdir(path.dirname(elsewhere), { recursive: true });
      await fs.writeFile(elsewhere, text([call('l1', 'zqlinked', 'm1-link')]));
      const recorded = path.join(projects, 'm1-link.jsonl');
      await fs.symlink(elsewhere, recorded);
      register('m1-link', recorded);
      assert.equal(await attempts('m1-link'), 0);
    });

    await t.test('a hardlink of another member\'s transcript is refused', async () => {
      const theirs = path.join(foreign, 'm1-hard.jsonl');
      await fs.writeFile(theirs, text([call('h1', 'zqhardlinked', 'm1-hard')]));
      const recorded = path.join(projects, 'm1-hard.jsonl');
      await fs.link(theirs, recorded);
      register('m1-hard', recorded);
      assert.equal(await attempts('m1-hard'), 0);
    });

    await t.test('a file under the session\'s name with another session id in its header is refused', async () => {
      // The leading id-bearing record names another session; later records claim this one.
      const recorded = path.join(projects, 'm1-forged.jsonl');
      await fs.writeFile(recorded, text([{ type: 'ai-title', aiTitle: 't', sessionId: 'm1-victim' },
        call('f1', 'zqforged', 'm1-forged')]));
      register('m1-forged', recorded);
      assert.equal(await attempts('m1-forged'), 0);
    });

    await t.test('a symlinked subagents dir and a hardlinked subagent file are never read', async () => {
      const parent = path.join(projects, 'm1-agents.jsonl');
      await fs.writeFile(parent, text([call('p1', 'zqparent', 'm1-agents')]));
      register('m1-agents', parent);
      const planted = path.join(foreign, 'planted-subagents');
      await fs.mkdir(planted, { recursive: true });
      await fs.writeFile(path.join(planted, 'agent-x1.jsonl'), text([call('x1', 'zqplantedagent', 'm1-agents')]));
      await fs.mkdir(path.join(projects, 'm1-agents'), { recursive: true });
      await fs.symlink(planted, path.join(projects, 'm1-agents', 'subagents'));
      assert.equal(await attempts('m1-agents'), 1, 'only the parent\'s own call');

      const parent2 = path.join(projects, 'm1-agents2.jsonl');
      await fs.writeFile(parent2, text([call('p2', 'zqparent2', 'm1-agents2')]));
      register('m1-agents2', parent2);
      const subagents = path.join(projects, 'm1-agents2', 'subagents');
      await fs.mkdir(subagents, { recursive: true });
      const theirs = path.join(foreign, 'agent-y1.jsonl');
      await fs.writeFile(theirs, text([call('y1', 'zqhardagent', 'm1-agents2')]));
      await fs.link(theirs, path.join(subagents, 'agent-y1.jsonl'));
      assert.equal(await attempts('m1-agents2'), 1, 'only the parent\'s own call');
    });

    await t.test('a Codex child rollout that is a hardlink is not read', async () => {
      const directory = path.join(fixture, '.nassaj-users', String(alice), '.codex', 'sessions', '2026', '10', '12');
      const foreignDir = path.join(fixture, '.nassaj-users', String(mallory), '.codex', 'sessions', '2026', '10', '12');
      await fs.mkdir(directory, { recursive: true });
      await fs.mkdir(foreignDir, { recursive: true });
      const native = (payload: unknown) => ({ type: 'response_item', timestamp: '2026-10-12T12:00:00Z', payload });
      const root = path.join(directory, 'rollout-m1-codex-root.jsonl');
      await fs.writeFile(root, text([
        { type: 'session_meta', payload: { id: 'm1-codex-root', session_id: 'm1-codex-root', thread_source: 'user' } },
        native({ type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-m1',
          arguments: JSON.stringify({ task_name: 'worker' }) }),
        native({ type: 'function_call_output', call_id: 'spawn-m1', output: JSON.stringify({ agent_id: 'm1-codex-child' }) }),
      ]));
      const theirs = path.join(foreignDir, 'rollout-m1-codex-child.jsonl');
      await fs.writeFile(theirs, text([
        { type: 'session_meta', payload: { id: 'm1-codex-child', parent_thread_id: 'm1-codex-root',
          session_id: 'm1-codex-root', thread_source: 'subagent' } },
        native({ type: 'function_call', name: 'read_file', call_id: 'child-read',
          arguments: JSON.stringify({ path: path.join(fixture, 'zqhardcodex', 'SKILL.md') }) }),
      ]));
      await fs.link(theirs, path.join(directory, 'rollout-m1-codex-child.jsonl'));
      register('m1-codex-root', root, 'codex');
      const projection = await readSessionSkills('m1-codex-root', 'codex', alice);
      assert.equal(projection.coverage.scannedSources, 1, 'the hardlinked child is never scanned');
    });
  } finally {
    db.closeConnection(); os.homedir = originalHome;
    if (previousDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDb;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
