/**
 * T-873(2) — agentStatusService: the two READ-ONLY app-level surfaces behind
 * `GET /api/providers/agents/orphans` and `/agents/:agentId/report`.
 *
 * The service shipped with 381 lines and no test at all, while being the one
 * component here that answers a question ACROSS user boundaries ("which agents
 * are mine?") and joins a CALLER-SUPPLIED id onto a filesystem path. Those are
 * exactly the two places where a quiet mistake becomes a leak, so this file
 * pins them:
 *
 *   - FAIL-CLOSED IDENTITY. null / NaN / fractional / string ids scan NOTHING
 *     and reveal nothing — proven against a fixture that DOES return an agent
 *     for the same, valid, user, so a green run can never mean "nothing to
 *     find".
 *   - OWNERSHIP. A caller sees only agents under sessions they participate in;
 *     another user's agent id, description, path and report stay invisible.
 *   - NO EXISTENCE ORACLE. Someone else's real agent id resolves EXACTLY like a
 *     nonexistent one (null ⇒ the route's 404), so ownership cannot be probed.
 *   - PATH SAFETY. A traversal id is rejected before it is joined onto a path.
 *   - THE DECLARED CAPS (200 sessions / 400 agents) actually bind, and `capped`
 *     tells the truth so "no orphan" is never confused with "stopped looking".
 *   - NO FALSE ORPHAN. An undecidable transcript still being written is dropped,
 *     not reported.
 *
 * Runs against a real migrated DB and real transcript files on disk. The three
 * fixture lines are verbatim disk lines (the same ones pinned in
 * `agent-transcript.reader.test.ts`); only the multi-KB prompt and tool bodies
 * are trimmed, as marked in place there.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  agentStatusService,
  isValidAgentId,
} from '@/modules/providers/services/agent-status.service.js';

const NOW_MS = Date.parse('2026-07-26T15:00:00.000Z');
const QUIET_MS = 5_000;
const OLD_MTIME_MS = NOW_MS - 60 * 60_000; // well past the quiet window

/** VERBATIM — an agent transcript's launch record. */
const FIRST =
  '{"parentUuid":null,"isSidechain":true,"agentId":"ab0bf67f9ea3d0c25","type":"user","message":{"role":"user","content":"«prompt trimmed for the fixture»"},"uuid":"6ff134ce-2c1e-426b-ad58-66bba65bf389","timestamp":"2026-07-26T04:11:11.027Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/** VERBATIM — the final assistant text: the report that was never delivered. */
const FINAL_REPORT =
  '{"parentUuid":"22850cb0-8791-4464-a1da-38b4e7802f61","isSidechain":true,"agentId":"ab0bf67f9ea3d0c25","message":{"model":"claude-opus-5","id":"msg_011CdQRQ6VrKj2cLiJNDG4eN","type":"message","role":"assistant","content":[{"type":"text","text":"Two files from another session appeared — staging mine by name only."}],"stop_reason":null},"type":"assistant","uuid":"2a9b7bdf-ecb5-4a90-8819-34bcf3ae51dd","timestamp":"2026-07-26T09:20:12.134Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/** VERBATIM — the cut marker 63 s later (⇒ `interrupted`, reported regardless). */
const CUT =
  '{"parentUuid":"e4b66b46-9f7e-4760-aced-71fa7f8922be","isSidechain":true,"agentId":"ab0bf67f9ea3d0c25","type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"6c911354-674a-4447-8e4d-d0448bee608f","timestamp":"2026-07-26T09:21:15.950Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/** VERBATIM — a bare `tool_result` tail: undecidable (`no-terminal-marker`). */
const TOOL_RESULT_TAIL =
  '{"parentUuid":"07bf4c9a-f5b2-4165-b595-44c096a61e30","isSidechain":true,"agentId":"a4b86edd162eeebf7","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_012aDEScfE9CbsQvM1vSknU2","type":"tool_result","content":"«tool output trimmed for the fixture»","is_error":false}]},"uuid":"73bef948-f44e-4809-be2d-dadbb00568cb","timestamp":"2026-07-26T10:23:22.943Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

const META = JSON.stringify({
  agentType: 'frontend-dev',
  description: 'إصلاح تشوّه bidi في عرض رسائل RTL',
  toolUseId: 'toolu_01SVHAGH5nqsRk11r8zwa4yT',
  spawnDepth: 1,
  model: 'opus',
});

type AddAgent = { agentId: string; lines: string[]; mtimeMs?: number; meta?: boolean };

type Harness = {
  createUser: (name: string) => number;
  addSession: (args: {
    userId: number;
    sessionId: string;
    agents: AddAgent[];
  }) => Promise<void>;
};

/**
 * Isolated migrated DB whose session rows point INTO a temp project tree, so the
 * service's real derivation (`<projectDir>/<sessionId>/subagents/agent-*.jsonl`)
 * resolves to transcripts we actually write. Nothing is stubbed.
 */
async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-status-'));
  const projectDir = path.join(tempRoot, 'project-encoded');
  await mkdir(projectDir, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'db.sqlite');
  await initializeDatabase();

  const createUser = (name: string): number => userDb.createUser(name, 'hash', 'user').id;

  const addSession = async (args: {
    userId: number;
    sessionId: string;
    agents: AddAgent[];
  }): Promise<void> => {
    const { userId, sessionId, agents } = args;
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(jsonlPath, '', 'utf8');
    sessionsDb.createSession(
      sessionId,
      'claude',
      projectDir,
      undefined,
      undefined,
      undefined,
      jsonlPath,
    );
    getConnection()
      .prepare('INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, ?)')
      .run(sessionId, userId, 'owner');

    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    for (const agent of agents) {
      const file = path.join(subagentsDir, `agent-${agent.agentId}.jsonl`);
      await writeFile(file, `${agent.lines.join('\n')}\n`, 'utf8');
      const secs = (agent.mtimeMs ?? OLD_MTIME_MS) / 1000;
      await utimes(file, secs, secs);
      if (agent.meta !== false) {
        await writeFile(path.join(subagentsDir, `agent-${agent.agentId}.meta.json`), META, 'utf8');
      }
    }
  };

  try {
    await run({ createUser, addSession });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const orphans = (userId: unknown) =>
  agentStatusService.getOrphanedAgents(userId as number | null, {
    now: NOW_MS,
    quietMs: QUIET_MS,
  });

const EMPTY = { agents: [], eligible: 0, scanned: 0, agentsScanned: 0, capped: false };

// ---------------------------------------------------------------------------
// (أ) The ownership gate — fail-closed on identity
// ---------------------------------------------------------------------------

test('the fixture is live: a valid owner DOES see their interrupted agent with its report', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    await addSession({
      userId: alice,
      sessionId: 's-alice',
      agents: [{ agentId: 'ab0bf67f9ea3d0c25', lines: [FIRST, FINAL_REPORT, CUT] }],
    });

    const result = await orphans(alice);
    assert.equal(result.eligible, 1);
    assert.equal(result.scanned, 1);
    assert.equal(result.agentsScanned, 1);
    assert.equal(result.capped, false);
    assert.equal(result.agents.length, 1);

    const agent = result.agents[0];
    assert.equal(agent.agentId, 'ab0bf67f9ea3d0c25');
    assert.equal(agent.sessionId, 's-alice');
    assert.equal(agent.outcome, 'interrupted');
    assert.equal(agent.unknownReason, null);
    assert.equal(agent.hasReport, true);
    assert.equal(
      agent.reportPreview,
      'Two files from another session appeared — staging mine by name only.',
    );
    // The sidecar join key — the whole reason the meta file is read.
    assert.equal(agent.toolUseId, 'toolu_01SVHAGH5nqsRk11r8zwa4yT');
    assert.equal(agent.agentType, 'frontend-dev');
  });
});

test('FAIL-CLOSED: every non-integer identity scans nothing and reveals nothing', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    await addSession({
      userId: alice,
      sessionId: 's-alice',
      agents: [{ agentId: 'ab0bf67f9ea3d0c25', lines: [FIRST, FINAL_REPORT, CUT] }],
    });

    // Each of these would be a leak if it fell through to the scan. The test
    // above proves the same fixture DOES yield an agent for the valid id, so an
    // empty envelope here is a gate, not an empty corpus.
    for (const bogus of [null, undefined, NaN, 1.5, '1', '1; DROP TABLE sessions', {}, [], true]) {
      assert.deepEqual(await orphans(bogus), EMPTY, `identity ${String(bogus)} must be refused`);
      assert.equal(
        await agentStatusService.getAgentReport(bogus as number | null, 'ab0bf67f9ea3d0c25'),
        null,
        `report for identity ${String(bogus)} must be refused`,
      );
    }
  });
});

test('OWNERSHIP: a caller never sees another user\'s agent, in either surface', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    const bob = createUser('bob');
    await addSession({
      userId: alice,
      sessionId: 's-alice',
      agents: [{ agentId: 'ab0bf67f9ea3d0c25', lines: [FIRST, FINAL_REPORT, CUT] }],
    });
    await addSession({ userId: bob, sessionId: 's-bob', agents: [] });

    const bobResult = await orphans(bob);
    assert.deepEqual(bobResult.agents, [], "alice's agent must not leak to bob");
    assert.equal(bobResult.eligible, 1, 'bob is scanned over HIS OWN session only');
    assert.equal(bobResult.agentsScanned, 0);

    // NO EXISTENCE ORACLE: alice's real agent id and a fabricated one are
    // indistinguishable from bob's side — both null ⇒ both 404.
    const foreign = await agentStatusService.getAgentReport(bob, 'ab0bf67f9ea3d0c25');
    const fabricated = await agentStatusService.getAgentReport(bob, 'doesnotexist0000');
    assert.equal(foreign, null);
    assert.deepEqual(foreign, fabricated, 'owned-but-not-mine must be shaped exactly like absent');

    // Alice still gets her own report in full.
    const own = await agentStatusService.getAgentReport(alice, 'ab0bf67f9ea3d0c25');
    assert.ok(own);
    assert.equal(own.sessionId, 's-alice');
    assert.equal(own.outcome, 'interrupted');
    assert.equal(
      own.report,
      'Two files from another session appeared — staging mine by name only.',
    );
    assert.equal(own.reportTruncated, false);
    assert.equal(own.interruptionText, '[Request interrupted by user]');
  });
});

// ---------------------------------------------------------------------------
// (ب) Path safety — a caller-supplied id never reaches a path unvalidated
// ---------------------------------------------------------------------------

test('a malformed agent id is rejected before it is joined onto any path', async () => {
  const traversals = [
    '../../../../etc/passwd',
    '..',
    'a/b',
    'a\\b',
    '.',
    'ab0bf67f9ea3d0c25/../../secret',
    'ab0bf67f9ea3d0c25 ',
    'ab0bf 67f9',
    '',
    'x'.repeat(65),
  ];
  for (const bad of traversals) {
    assert.equal(isValidAgentId(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
  for (const good of ['ab0bf67f9ea3d0c25', 'a-b_C9', 'x'.repeat(64)]) {
    assert.equal(isValidAgentId(good), true);
  }
  assert.equal(isValidAgentId(null), false);
  assert.equal(isValidAgentId(42), false);

  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    await addSession({
      userId: alice,
      sessionId: 's-alice',
      agents: [{ agentId: 'ab0bf67f9ea3d0c25', lines: [FIRST, FINAL_REPORT, CUT] }],
    });
    // Even for a fully authorized caller the id is refused at the service, not
    // just at the route.
    for (const bad of traversals) {
      assert.equal(await agentStatusService.getAgentReport(alice, bad), null);
    }
  });
});

// ---------------------------------------------------------------------------
// (ج) The declared caps actually bind
// ---------------------------------------------------------------------------

test('the 200-session cap binds and is declared (eligible 201, scanned 200, capped)', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    for (let index = 0; index < 201; index += 1) {
      await addSession({
        userId: alice,
        sessionId: `s-${String(index).padStart(4, '0')}`,
        agents: [{ agentId: `agent${String(index).padStart(4, '0')}`, lines: [FIRST, CUT] }],
      });
    }

    const result = await orphans(alice);
    assert.equal(result.eligible, 201, 'all owned sessions are counted');
    assert.equal(result.scanned, 200, 'exactly the cap is inspected');
    assert.equal(result.capped, true, '"no more orphans" must not be implied');
    assert.equal(result.agents.length, 200);
  });
});

test('the 400-agent cap binds and is declared, and stops the scan', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    const agents = Array.from({ length: 401 }, (_, index) => ({
      agentId: `agent${String(index).padStart(4, '0')}`,
      lines: [FIRST, CUT],
      meta: false as const,
    }));
    await addSession({ userId: alice, sessionId: 's-many', agents });

    const result = await orphans(alice);
    assert.equal(result.agentsScanned, 400, 'exactly the cap is read');
    assert.equal(result.agents.length, 400);
    assert.equal(result.capped, true);
  });
});

test('under the caps, `capped` is false — the flag is not permanently on', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    await addSession({
      userId: alice,
      sessionId: 's-alice',
      agents: [{ agentId: 'ab0bf67f9ea3d0c25', lines: [FIRST, CUT] }],
    });
    assert.equal((await orphans(alice)).capped, false);
  });
});

// ---------------------------------------------------------------------------
// (د) No false orphan, no throw
// ---------------------------------------------------------------------------

test('an undecidable transcript still being written is NOT reported as an orphan', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    await addSession({
      userId: alice,
      sessionId: 's-fresh',
      agents: [
        // Undecidable tail, written a moment ago => still being appended to.
        { agentId: 'freshagent00000', lines: [FIRST, TOOL_RESULT_TAIL], mtimeMs: NOW_MS - 1_000 },
        // Same undecidable tail, long quiet => reported, WITH its reason.
        { agentId: 'quietagent00000', lines: [FIRST, TOOL_RESULT_TAIL] },
      ],
    });

    const result = await orphans(alice);
    assert.equal(result.agentsScanned, 2, 'both were read');
    assert.equal(result.agents.length, 1, 'only the quiet one is reported');
    assert.equal(result.agents[0].agentId, 'quietagent00000');
    assert.equal(result.agents[0].outcome, 'unknown');
    assert.equal(result.agents[0].unknownReason, 'no-terminal-marker');
    assert.equal(result.agents[0].hasReport, false);
  });
});

test('a completed agent is not an orphan, and a session with no subagents dir is harmless', async () => {
  await withHarness(async ({ createUser, addSession }) => {
    const alice = createUser('alice');
    await addSession({
      userId: alice,
      sessionId: 's-done',
      agents: [{ agentId: 'donedonedone0000', lines: [FIRST, FINAL_REPORT] }],
    });
    await addSession({ userId: alice, sessionId: 's-bare', agents: [] });

    const result = await orphans(alice);
    assert.equal(result.eligible, 2);
    assert.equal(result.scanned, 2, 'both sessions were inspected');
    assert.deepEqual(result.agents, [], 'a completed agent needs no human attention');

    // The report route still serves a completed agent's text on demand.
    const report = await agentStatusService.getAgentReport(alice, 'donedonedone0000');
    assert.ok(report);
    assert.equal(report.outcome, 'completed');
    assert.equal(
      report.report,
      'Two files from another session appeared — staging mine by name only.',
    );
  });
});

test('a user who owns nothing gets a truthful empty envelope, not an error', async () => {
  await withHarness(async ({ createUser }) => {
    const loner = createUser('loner');
    assert.deepEqual(await orphans(loner), EMPTY);
    assert.equal(await agentStatusService.getAgentReport(loner, 'ab0bf67f9ea3d0c25'), null);
  });
});
