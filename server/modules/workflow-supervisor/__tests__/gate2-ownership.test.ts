/**
 * GATE2 — fail-closed identity/ownership authorization (ADR-053 §ج-3, حرج-2).
 * THE ToS BLOCKER. This is the acceptance test the ADR mandates before any
 * launch code ships. It proves, against a REAL migrated DB, that:
 *
 *   1. a non-integer / missing userId is DENIED (no launch, no owner fallback),
 *   2. a userId that does NOT own / is not a member of the project is DENIED —
 *      INCLUDING the decisive PUBLIC-project case (a visibility predicate would
 *      ALLOW it; the strict ownership predicate must DENY it),
 *   3. the creator IS allowed, and an explicit member IS allowed,
 *   4. on DENY the env resolver is NEVER invoked (nothing is launched, and there
 *      is no unset-and-run on the owner/system quota).
 *
 * The ownership predicate is the REAL DB one (isProjectPathOwnedOrMemberedBy);
 * the env resolver is a spy so we can assert it is not touched on a deny.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  projectMembersDb,
  userDb,
} from '@/modules/database/index.js';
import { authorizeLaunch } from '@/modules/workflow-supervisor/ownership-guard.js';

async function withDb(run: () => Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-gate2-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'db.sqlite');
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const createUser = (name: string): number => userDb.createUser(name, 'hash', 'user').id;

/** Real ownership predicate bound to the live DB. */
const realOwnership = (projectPath: string, userId: number): boolean =>
  projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, userId);

/** A spy env resolver: records calls so a deny can assert it was never invoked. */
function spyResolver() {
  const calls: Array<{ userId: number }> = [];
  const resolveEnv = (userId: number): NodeJS.ProcessEnv => {
    calls.push({ userId });
    return { CLAUDE_CONFIG_DIR: `/home/dev/.nassaj-users/${userId}/.claude` };
  };
  return { resolveEnv, calls };
}

function makeIntent(over: Record<string, unknown>): Record<string, unknown> {
  return {
    wfLaunchId: 'launch-1',
    userId: 1,
    projectPath: '/tmp/proj',
    scriptOrPrompt: 'do work',
    requestedAt: new Date().toISOString(),
    ...over,
  };
}

test('GATE2: non-integer userId is DENIED and the env resolver is never called', async () => {
  await withDb(async () => {
    for (const bad of [null, undefined, 'abc', '123', 1.5, {}]) {
      const spy = spyResolver();
      const res = authorizeLaunch(makeIntent({ userId: bad }), {
        isOwnedOrMembered: realOwnership,
        resolveEnv: spy.resolveEnv,
      });
      assert.equal(res.allow, false, `userId=${JSON.stringify(bad)} must be denied`);
      assert.equal(spy.calls.length, 0, 'resolver must not run on deny (no owner fallback)');
    }
  });
});

test('GATE2: a PUBLIC project the user does not own is DENIED (visibility would allow, ownership must not)', async () => {
  await withDb(async () => {
    const owner = createUser('owner');
    const stranger = createUser('stranger');
    const projectPath = '/tmp/public-proj';
    const { project } = projectsDb.createProjectPath(projectPath, null, owner);
    // Make it PUBLIC — a visibility predicate returns true for ANY user here.
    projectsDb.setProjectVisibility(project!.project_id, 'public');

    // Sanity: the VISIBILITY predicate WOULD allow the stranger (the wrong guard).
    assert.equal(
      projectsDb.isProjectPathVisibleToUser(projectPath, stranger),
      true,
      'precondition: visibility predicate allows a stranger on a public project',
    );

    // GATE2 uses the STRICT OWNERSHIP predicate and must DENY the stranger.
    const spy = spyResolver();
    const res = authorizeLaunch(makeIntent({ userId: stranger, projectPath }), {
      isOwnedOrMembered: realOwnership,
      resolveEnv: spy.resolveEnv,
    });
    assert.equal(res.allow, false, 'stranger must be denied on a public project');
    assert.equal(spy.calls.length, 0, 'resolver must not run — no launch on the owner quota');
  });
});

test('GATE2: the project CREATOR is allowed and gets the isolated env', async () => {
  await withDb(async () => {
    const owner = createUser('owner');
    const projectPath = '/tmp/owned-proj';
    projectsDb.createProjectPath(projectPath, null, owner);

    const spy = spyResolver();
    const res = authorizeLaunch(makeIntent({ userId: owner, projectPath }), {
      isOwnedOrMembered: realOwnership,
      resolveEnv: spy.resolveEnv,
    });
    assert.equal(res.allow, true, 'creator must be allowed');
    if (res.allow) {
      assert.equal(res.env.CLAUDE_CONFIG_DIR, `/home/dev/.nassaj-users/${owner}/.claude`);
    }
    assert.equal(spy.calls.length, 1, 'resolver runs exactly once on allow');
  });
});

test('GATE2: an explicit project MEMBER is allowed; a non-member is denied', async () => {
  await withDb(async () => {
    const owner = createUser('owner');
    const member = createUser('member');
    const nonMember = createUser('nonmember');
    const projectPath = '/tmp/private-proj';
    const { project } = projectsDb.createProjectPath(projectPath, null, owner);
    // Private so only creator + explicit members qualify.
    projectsDb.setProjectVisibility(project!.project_id, 'private');
    projectMembersDb.add(project!.project_id, member, 'member', owner);

    const allow = authorizeLaunch(makeIntent({ userId: member, projectPath }), {
      isOwnedOrMembered: realOwnership,
      resolveEnv: () => ({}),
    });
    assert.equal(allow.allow, true, 'explicit member must be allowed');

    const spy = spyResolver();
    const deny = authorizeLaunch(makeIntent({ userId: nonMember, projectPath }), {
      isOwnedOrMembered: realOwnership,
      resolveEnv: spy.resolveEnv,
    });
    assert.equal(deny.allow, false, 'non-member must be denied on a private project');
    assert.equal(spy.calls.length, 0, 'resolver must not run on the non-member deny');
  });
});

test('GATE2: a throwing ownership predicate fails CLOSED (deny, not open)', async () => {
  await withDb(async () => {
    const spy = spyResolver();
    const res = authorizeLaunch(makeIntent({ userId: 5, projectPath: '/tmp/x' }), {
      isOwnedOrMembered: () => {
        throw new Error('db exploded');
      },
      resolveEnv: spy.resolveEnv,
    });
    assert.equal(res.allow, false, 'a DB error must fail closed to deny');
    assert.equal(spy.calls.length, 0, 'no launch on a fail-closed deny');
  });
});

// Direct DB-predicate assertions (belt-and-braces on the SQL itself).
test('isProjectPathOwnedOrMemberedBy: strict ownership semantics (no public bypass, no participant bypass)', async () => {
  await withDb(async () => {
    const owner = createUser('o');
    const stranger = createUser('s');
    const pPublic = '/tmp/p-public';
    const pPrivate = '/tmp/p-private';
    const { project: pubProj } = projectsDb.createProjectPath(pPublic, null, owner);
    const { project: privProj } = projectsDb.createProjectPath(pPrivate, null, owner);
    projectsDb.setProjectVisibility(pubProj!.project_id, 'public');
    projectsDb.setProjectVisibility(privProj!.project_id, 'private');

    // owner: true on both.
    assert.equal(projectsDb.isProjectPathOwnedOrMemberedBy(pPublic, owner), true);
    assert.equal(projectsDb.isProjectPathOwnedOrMemberedBy(pPrivate, owner), true);
    // stranger: FALSE even on the public one (no visibility bypass).
    assert.equal(projectsDb.isProjectPathOwnedOrMemberedBy(pPublic, stranger), false);
    assert.equal(projectsDb.isProjectPathOwnedOrMemberedBy(pPrivate, stranger), false);
    // non-integer / empty path => false.
    assert.equal(projectsDb.isProjectPathOwnedOrMemberedBy(pPublic, null), false);
    assert.equal(projectsDb.isProjectPathOwnedOrMemberedBy('', owner), false);

    // A session-participant (but not member/creator) must NOT be granted: seed a
    // participant row and confirm the ownership predicate still denies.
    const participant = createUser('p');
    getConnection()
      .prepare('INSERT INTO sessions (session_id, provider, project_path) VALUES (?, ?, ?)')
      .run('sess-1', 'claude', pPrivate);
    getConnection()
      .prepare('INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, ?)')
      .run('sess-1', participant, 'participant');
    assert.equal(
      projectsDb.isProjectPathOwnedOrMemberedBy(pPrivate, participant),
      false,
      'participation alone must NOT confer launch ownership',
    );
  });
});
