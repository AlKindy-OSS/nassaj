import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('real session projections: ACL, canonical owner/provider, children, pagination, replay and project cache', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-observations-'));
  const originalHome = os.homedir;
  os.homedir = () => fixture;
  const previousDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(fixture, 'auth.db');
  // Existing empty file prevents initializeDatabase's legacy-database import fallback.
  await fs.writeFile(process.env.DATABASE_PATH, '');
  const db = await import('@/modules/database/index.js');
  const { readSessionSkills, readProjectSkills } = await import('./skill-observations.service.js');
  const sharing = await import('@/services/provider-sharing.js');
  db.closeConnection();
  await db.initializeDatabase();
  sharing._resetProviderSharingCache();
  try {
    const alice = db.userDb.createUser('skill-alice', 'hash-a', 'user').id;
    const bob = db.userDb.createUser('skill-bob', 'hash-b', 'user').id;
    const workspace = path.join(fixture, 'workspace');
    await fs.mkdir(workspace);
    const home = path.join(fixture, '.nassaj-users', String(alice), '.claude');
    const projects = path.join(home, 'projects', 'fixture');
    const skillPath = path.join(home, 'skills', 'foo', 'SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, '---\nname: foo\n---\nFixture skill.');
    await fs.mkdir(projects, { recursive: true });
    const call = (id: string, name = 'Skill', input: unknown = { skill: 'foo' }, session = 'session-a') => ({
      type: 'assistant', sessionId: session, timestamp: '2026-09-06T12:00:00Z',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    const result = (id: string, is_error = false, session = 'session-a') => ({ type: 'user', sessionId: session,
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'result' }] } });
    const writeSession = async (session: string, rows: unknown[], owner = alice, provider = 'claude') => {
      const file = path.join(projects, `${session}.jsonl`);
      await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      db.sessionsDb.createSession(session, provider, workspace, undefined, undefined, undefined, file);
      db.participantsDb.recordSpawn(session, owner);
      return file;
    };
    const parent = await writeSession('session-a', [call('skill-1'), result('skill-1'),
      call('read-1', 'Read', { file_path: skillPath }), result('read-1'),
      call('agent-1', 'Agent', { description: 'first' }), call('agent-2', 'Agent', { description: 'second' })]);
    await writeSession('orphan', [call('orphan-call', 'Skill', { skill: 'foo' }, 'orphan')]);
    const { getConnection } = db;
    getConnection().prepare('UPDATE sessions SET project_path = NULL WHERE session_id = ?').run('orphan');
    const children = path.join(projects, 'session-a', 'subagents');
    await fs.mkdir(children, { recursive: true });
    for (const [child, bridge] of [['child1', 'agent-1'], ['child2', 'agent-2']]) {
      await fs.writeFile(path.join(children, `agent-${child}.meta.json`), JSON.stringify({ agentType: 'backend-dev', toolUseId: bridge }));
      await fs.writeFile(path.join(children, `agent-${child}.jsonl`), JSON.stringify(call(`call-${child}`)) + '\n');
    }
    await t.test('cold project stats disclose unavailable, authorization rejects cross-user and provider mismatch', async () => {
      assert.equal(readProjectSkills(workspace, alice).coverage.state, 'unavailable');
      await assert.rejects(readSessionSkills('orphan', 'claude', bob), { statusCode: 404 });
      await assert.rejects(readSessionSkills('session-a', 'codex', alice), { statusCode: 404 });
      await assert.rejects(readSessionSkills('session-a', 'claude', null), { statusCode: 404 });
    });
    await t.test('same-role child instances link to distinct exact cards; invocation/read share identity', async () => {
      const projection = await readSessionSkills('session-a', 'claude', alice);
      assert.equal(projection.summary.observedDistinct, 1);
      assert.equal(projection.summary.invocationAttempts, 3);
      assert.equal(projection.summary.invocationSucceeded, 1);
      assert.equal(projection.summary.readSucceeded, 1);
      assert.equal(projection.summary.totalActual, null);
      assert.deepEqual(projection.observations.filter((item) => item.actorKind === 'subagent').map((item) => item.actorToolCallId).sort(), ['agent-1', 'agent-2']);
      assert.equal(new Set(projection.observations.filter((item) => item.actorKind === 'subagent').map((item) => item.actorId)).size, 2);
      assert.ok(!JSON.stringify(projection).includes(fixture));
      const replay = await readSessionSkills('session-a', 'claude', alice);
      assert.deepEqual(replay.summary, projection.summary);
      const stats = readProjectSkills(workspace, alice);
      assert.deepEqual(stats.summary, projection.summary);
      assert.equal(readProjectSkills(workspace, alice, { since: Date.parse('2026-09-07') }).summary.observedDistinct, 0);
    });
    await t.test('owner/path mismatch and unsupported bodies fail closed', async () => {
      await writeSession('misowned', [call('secret', 'Skill', { skill: 'secret' }, 'misowned')], bob);
      assert.equal((await readSessionSkills('misowned', 'claude', bob)).coverage.state, 'unavailable');
      await writeSession('unsupported', [], alice, 'hermes');
      assert.equal((await readSessionSkills('unsupported', 'hermes', alice)).coverage.state, 'unsupported');
    });
    await t.test('pagination summary is global and cursors are scope-bound', async () => {
      await writeSession('large', Array.from({ length: 205 }, (_, index) => call(`many-${index}`, 'Skill', { skill: 'foo' }, 'large')));
      const first = await readSessionSkills('large', 'claude', alice);
      assert.ok(first.observations.length > 0 && first.observations.length <= 200);
      assert.equal(first.summary.invocationAttempts, 205);
      assert.ok(first.coverage.nextCursor);
      const next = await readSessionSkills('large', 'claude', alice, { cursor: first.coverage.nextCursor! });
      assert.equal(next.observations.length, 205 - first.observations.length);
      assert.equal(next.summary.invocationAttempts, 205);
      await assert.rejects(readSessionSkills('session-a', 'claude', alice, { cursor: first.coverage.nextCursor! }), { statusCode: 409 });
    });
    await t.test('fork-prefix events are excluded instead of double counted', async () => {
      await writeSession('fork', [{ ...call('skill-1', 'Skill', { skill: 'foo' }, 'fork'), forkedFrom: { sessionId: 'session-a', messageUuid: 'uuid' } },
        call('own', 'Skill', { skill: 'foo' }, 'fork')]);
      const projection = await readSessionSkills('fork', 'claude', alice);
      assert.equal(projection.summary.invocationAttempts, 1);
      assert.ok(projection.coverage.reasons.includes('ambiguous_origin'));
    });
    await t.test('oversized line is discarded without suppressing following native evidence', async () => {
      const file = await writeSession('oversized', []);
      await fs.writeFile(file, JSON.stringify({ data: 'a'.repeat(300 * 1024) }) + '\n' + JSON.stringify(call('valid', 'Skill', { skill: 'foo' }, 'oversized')) + '\n');
      const projection = await readSessionSkills('oversized', 'claude', alice);
      assert.equal(projection.summary.invocationAttempts, 1);
      assert.ok(projection.coverage.reasons.includes('line_limit'));
    });
    await t.test('catalog symlink outside owner/workspace is not followed', async () => {
      const other = path.join(fixture, 'other-owner-skills', 'sensitive-name');
      await fs.mkdir(other, { recursive: true });
      await fs.writeFile(path.join(other, 'SKILL.md'), '---\nname: sensitive-name\n---\n');
      await fs.mkdir(path.join(workspace, '.agents'));
      await fs.symlink(path.dirname(other), path.join(workspace, '.agents', 'skills'));
      await writeSession('symlink', [call('external', 'Read', { file_path: path.join(workspace, '.agents', 'skills', 'sensitive-name', 'SKILL.md') }, 'symlink')]);
      const projection = await readSessionSkills('symlink', 'claude', alice);
      assert.equal(projection.summary.observedDistinct, 0);
      assert.ok(!JSON.stringify(projection).includes('sensitive-name'));
    });
    await t.test('same-key concurrent cold requests share projection; registry remap invalidates cache and cursor', async () => {
      const oldPath = await writeSession('concurrent', [call('one', 'Skill', { skill: 'foo' }, 'concurrent')]);
      const [first, second] = await Promise.all([
        readSessionSkills('concurrent', 'claude', alice), readSessionSkills('concurrent', 'claude', alice),
      ]);
      assert.deepEqual(first, second);
      getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run('/not/owned/concurrent.jsonl', 'concurrent');
      assert.equal((await readSessionSkills('concurrent', 'claude', alice)).coverage.state, 'unavailable');
      getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(oldPath, 'concurrent');
      assert.equal((await readSessionSkills('concurrent', 'claude', alice)).summary.invocationAttempts, 1);
    });
    await t.test('child-only append, cursor generation and rotation update canonical observations', async () => {
      const originalNow = Date.now;
      const first = await readSessionSkills('large', 'claude', alice);
      await fs.appendFile(path.join(children, 'agent-child1.jsonl'), JSON.stringify(result('call-child1')) + '\n');
      Date.now = () => originalNow() + 3000;
      try {
        const updated = await readSessionSkills('session-a', 'claude', alice);
        assert.equal(updated.summary.invocationSucceeded, 2);
        await readSessionSkills('large', 'claude', alice);
        await assert.rejects(readSessionSkills('large', 'claude', alice, { cursor: first.coverage.nextCursor! }), { statusCode: 409 });
        await fs.writeFile(parent, JSON.stringify(call('replacement')) + '\n');
        Date.now = () => originalNow() + 6000;
        const rotated = await readSessionSkills('session-a', 'claude', alice);
        assert.ok(rotated.coverage.reasons.includes('source_changed'));
        assert.ok(!rotated.observations.some((item) => item.evidence === 'read'));
        assert.ok(rotated.observations.filter((item) => item.actorKind === 'subagent').every((item) => item.actorToolCallId === null));
      } finally { Date.now = originalNow; }
    });
    await t.test('Codex structured evidence, exact linked child and unsupported shapes remain distinct', async () => {
      const codexHome = path.join(fixture, '.nassaj-users', String(alice), '.codex');
      const directory = path.join(codexHome, 'sessions', '2026', '09', '06');
      const definition = path.join(codexHome, 'skills', 'codex-skill', 'SKILL.md');
      await fs.mkdir(path.dirname(definition), { recursive: true });
      await fs.writeFile(definition, '---\nname: codex-skill\n---\n');
      await fs.mkdir(directory, { recursive: true });
      const native = (payload: unknown) => ({ type: 'response_item', timestamp: '2026-09-06T12:00:00Z', payload });
      const root = path.join(directory, 'rollout-codex-root.jsonl');
      const child = path.join(directory, 'rollout-codex-child.jsonl');
      const rows = [
        { type: 'session_meta', payload: { id: 'codex-root', session_id: 'codex-root', thread_source: 'user' } },
        native({ type: 'function_call', namespace: 'functions', name: 'exec_command', call_id: 'read-codex', arguments: JSON.stringify({ cmd: `cat ${definition}` }) }),
        native({ type: 'function_call_output', call_id: 'read-codex', output: JSON.stringify({ exit_code: 0, output: 'skill body' }) }),
        native({ type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-codex', arguments: JSON.stringify({ task_name: 'worker' }) }),
        native({ type: 'function_call_output', call_id: 'spawn-codex', output: JSON.stringify({ agent_id: 'codex-child' }) }),
      ];
      await fs.writeFile(root, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      await fs.writeFile(child, [
        { type: 'session_meta', payload: { id: 'codex-child', parent_thread_id: 'codex-root', session_id: 'codex-root', thread_source: 'subagent' } },
        native({ type: 'function_call', name: 'read_file', call_id: 'child-read', arguments: JSON.stringify({ path: definition }) }),
        native({ type: 'function_call_output', call_id: 'child-read', output: JSON.stringify({ isError: false }) }),
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      db.sessionsDb.createSession('codex-root', 'codex', workspace, undefined, undefined, undefined, root);
      db.participantsDb.recordSpawn('codex-root', alice);
      const projection = await readSessionSkills('codex-root', 'codex', alice);
      assert.equal(projection.summary.readSucceeded, 2);
      assert.equal(projection.summary.observedDistinct, 1);
      assert.equal(projection.observations.find((item) => item.actorKind === 'subagent')?.actorToolCallId, 'spawn-codex');
      const fork = path.join(directory, 'rollout-codex-fork.jsonl');
      await fs.writeFile(fork, [
        { type: 'session_meta', payload: { id: 'codex-fork', forked_from_id: 'codex-root', thread_source: 'user' } }, rows[1], rows[2],
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      db.sessionsDb.createSession('codex-fork', 'codex', workspace, undefined, undefined, undefined, fork);
      db.participantsDb.recordSpawn('codex-fork', alice);
      const forkResult = await readSessionSkills('codex-fork', 'codex', alice);
      assert.equal(forkResult.summary.observedDistinct, 0);
      assert.ok(forkResult.coverage.reasons.includes('ambiguous_origin'));
    });
    await t.test('admission rejects concurrent different-session scans without poisoning cache', async () => {
      const ids = ['admission1', 'admission2', 'admission3'];
      for (const id of ids) await writeSession(id, [call('admission', 'Skill', { skill: 'foo' }, id)]);
      const results = await Promise.all(ids.map((id) => readSessionSkills(id, 'claude', alice)));
      assert.equal(results.filter((item) => item.coverage.reasons.includes('scan_budget')).length, 2);
      const resumed = await readSessionSkills(ids[1], 'claude', alice);
      assert.equal(resumed.summary.invocationAttempts, 1);
    });
    await t.test('cursor cannot replay after same-key projection recreation at the same numeric generation', async () => {
      const file = await writeSession('epoch', Array.from({ length: 205 }, (_, i) => call(`epoch-${i}`, 'Skill', { skill: 'foo' }, 'epoch')));
      const old = await readSessionSkills('epoch', 'claude', alice);
      assert.ok(old.coverage.nextCursor);
      getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run('/missing/epoch.jsonl', 'epoch');
      await readSessionSkills('epoch', 'claude', alice);
      getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(file, 'epoch');
      await readSessionSkills('epoch', 'claude', alice);
      await assert.rejects(readSessionSkills('epoch', 'claude', alice, { cursor: old.coverage.nextCursor! }), { statusCode: 409 });
    });
    await t.test('cache access rechecks revoked participation and cross-principal cursors', async () => {
      await writeSession('revoked', Array.from({ length: 205 }, (_, i) => call(`revoke-${i}`, 'Skill', { skill: 'foo' }, 'revoked')));
      getConnection().prepare('UPDATE sessions SET project_path = NULL WHERE session_id = ?').run('revoked');
      db.participantsDb.recordSpawn('revoked', bob);
      const cached = await readSessionSkills('revoked', 'claude', bob);
      assert.ok(cached.coverage.nextCursor);
      await assert.rejects(readSessionSkills('revoked', 'claude', alice, { cursor: cached.coverage.nextCursor! }), { statusCode: 409 });
      getConnection().prepare('DELETE FROM session_participants WHERE session_id = ? AND user_id = ?').run('revoked', bob);
      await assert.rejects(readSessionSkills('revoked', 'claude', bob, { cursor: cached.coverage.nextCursor! }), { statusCode: 404 });
      await assert.rejects(readSessionSkills('revoked', 'claude', bob), { statusCode: 404 });
    });
    assert.ok(await fs.stat(parent));
  } finally {
    db.closeConnection(); os.homedir = originalHome;
    if (previousDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDb;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
