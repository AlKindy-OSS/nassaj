import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  __resetProjectFenceStateForTests,
  __projectFenceTokenCountsForTests,
  __setProjectFenceRotationFailureForTests,
  __setProjectAliasEnumerationFailureForTests,
  captureProjectFence,
  captureWorkspaceTopologyFence,
  isProjectFenceCurrent,
  isProjectFenceRuntimeReady,
  isWorkspaceTopologyFenceCurrent,
} from '@/modules/database/repositories/project-access.js';
import { projectMembersDb } from '@/modules/database/repositories/project-members.db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import {
  addMember,
  removeMember,
} from '@/modules/projects/index.js';

let root = '';
let sequence = 0;

const createUser = (role: 'owner' | 'admin' | 'user' = 'user'): number => {
  sequence += 1;
  return userDb.createUser(`fence_${sequence}`, 'hash', role).id;
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-fence-'));
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.WORKSPACES_ROOT = root;
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  closeConnection();
  await initializeDatabase();
});

beforeEach(() => __resetProjectFenceStateForTests());

after(() => {
  __resetProjectFenceStateForTests();
  closeConnection();
  delete process.env.DATABASE_PATH;
  delete process.env.WORKSPACES_ROOT;
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  fs.rmSync(root, { recursive: true, force: true });
});

test('subject rotation is project- and user-scoped and does not advance global authorization', () => {
  const userA = createUser();
  const userB = createUser();
  const pathA = fs.mkdtempSync(path.join(root, 'a-'));
  const pathB = fs.mkdtempSync(path.join(root, 'b-'));
  const projectA = projectsDb.createProjectPath(pathA, null, userB).project!.project_id;
  const projectB = projectsDb.createProjectPath(pathB, null, userB).project!.project_id;
  projectMembersDb.add(projectA, userA, 'member', userB);
  projectMembersDb.add(projectB, userA, 'member', userB);

  const fenceA = captureProjectFence(projectA, userA)!;
  const fenceB = captureProjectFence(projectB, userA)!;
  const creatorFence = captureProjectFence(projectA, userB)!;
  const generation = userDb.getRawById(userA)!.authorization_generation;

  assert.equal(projectMembersDb.removeAndRotateProjectAccess(projectA, userA), true);
  assert.equal(isProjectFenceCurrent(fenceA), false);
  assert.equal(isProjectFenceCurrent(fenceB), true, 'another project remains current');
  assert.equal(isProjectFenceCurrent(creatorFence), true, 'another user remains current');
  assert.equal(userDb.getRawById(userA)!.authorization_generation, generation);

  assert.equal(projectMembersDb.addAndRotateProjectAccess(projectA, userA, 'member', userB), true);
  const replacement = captureProjectFence(projectA, userA)!;
  assert.notEqual(replacement.subjectAccessToken, fenceA.subjectAccessToken);
  assert.equal(isProjectFenceCurrent(fenceA), false, 'remove then re-add cannot revive the old token');
  assert.equal(projectMembersDb.addAndRotateProjectAccess(projectA, userA, 'member', userB), false);
  assert.equal(isProjectFenceCurrent(replacement), true, 'an effective no-op does not rotate');
});

test('admin membership removal invalidates only that project despite residual platform access', () => {
  const creator = createUser();
  const admin = createUser('admin');
  const projectPath = fs.mkdtempSync(path.join(root, 'admin-'));
  const projectId = projectsDb.createProjectPath(projectPath, null, creator).project!.project_id;
  projectMembersDb.add(projectId, admin, 'member', creator);
  const before = captureProjectFence(projectId, admin)!;

  assert.equal(projectMembersDb.removeAndRotateProjectAccess(projectId, admin), true);
  assert.equal(isProjectFenceCurrent(before), false);
  assert.ok(captureProjectFence(projectId, admin), 'platform access remains, with a fresh token');
});

test('structure and workspace topology tokens reject registration, archive and ABA recreation', () => {
  const creator = createUser();
  const unregistered = fs.mkdtempSync(path.join(root, 'unregistered-'));
  const topology = captureWorkspaceTopologyFence(unregistered, creator)!;
  assert.equal(topology.kind, 'projectless');

  const created = projectsDb.createProjectPath(unregistered, null, creator).project!;
  assert.equal(isWorkspaceTopologyFenceCurrent(topology), false, 'registration invalidates projectless admission');
  const registered = captureProjectFence(created.project_id, creator)!;
  assert.equal(projectsDb.updateProjectIsArchivedById(created.project_id, true), true);
  assert.equal(isProjectFenceCurrent(registered), false);

  const archived = captureProjectFence(created.project_id, creator)!;
  assert.equal(projectsDb.deleteProjectById(created.project_id), true);
  const replacement = projectsDb.createProjectPath(unregistered, null, creator).project!;
  assert.notEqual(replacement.project_id, created.project_id);
  assert.equal(isProjectFenceCurrent(archived), false, 'delete and recreate cannot revive the old project fence');
});

test('projectless sessions require the requested consent class and canonical rooted path', () => {
  const reader = createUser();
  const participant = createUser();
  const guessed = createUser();
  const sessionId = 'projectless-fence-session';
  const location = fs.mkdtempSync(path.join(root, 'projectless-'));
  const db = getConnection();
  db.prepare("INSERT INTO sessions(session_id,provider,project_path) VALUES(?,'claude',NULL)").run(sessionId);
  db.prepare("INSERT INTO message_authors(session_id,user_id,content_hash,created_at) VALUES(?,?,?,'2026-01-01T00:00:00Z')")
    .run(sessionId, reader, 'a'.repeat(64));
  db.prepare("INSERT INTO session_participants(session_id,user_id,role,attribution) VALUES(?,?,'member','spawn')")
    .run(sessionId, participant);

  assert.ok(captureWorkspaceTopologyFence(location, reader, { sessionId, consent: 'read' }));
  assert.equal(captureWorkspaceTopologyFence(location, reader, { sessionId, consent: 'control' }), null);
  assert.ok(captureWorkspaceTopologyFence(location, participant, { sessionId, consent: 'control' }));
  assert.equal(captureWorkspaceTopologyFence(location, guessed, { sessionId, consent: 'read' }), null);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'project-fence-outside-'));
  const dangling = path.join(root, 'dangling');
  const escape = path.join(root, 'escape');
  fs.symlinkSync(path.join(root, 'missing-target'), dangling);
  fs.symlinkSync(outside, escape);
  try {
    assert.equal(captureWorkspaceTopologyFence(outside, reader), null);
    assert.equal(captureWorkspaceTopologyFence(dangling, reader), null);
    assert.equal(captureWorkspaceTopologyFence(escape, reader), null);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a post-commit rotation fault leaves the committed row but fails readiness closed', () => {
  const creator = createUser();
  const member = createUser();
  const projectPath = fs.mkdtempSync(path.join(root, 'fault-'));
  const projectId = projectsDb.createProjectPath(projectPath, null, creator).project!.project_id;
  const creatorFence = captureProjectFence(projectId, creator)!;

  __setProjectFenceRotationFailureForTests(true);
  assert.equal(projectMembersDb.addAndRotateProjectAccess(projectId, member, 'member', creator), true);
  assert.equal(projectMembersDb.getRole(projectId, member), 'member', 'the database commit is durable');
  assert.equal(isProjectFenceRuntimeReady(), false);
  assert.equal(isProjectFenceCurrent(creatorFence), false);
  assert.equal(captureProjectFence(projectId, creator), null);
  assert.equal(captureProjectFence(projectId, member), null);
});

test('a post-commit alias enumeration failure never throws and fails readiness closed', () => {
  const creator = createUser();
  const projectPath = fs.mkdtempSync(path.join(root, 'alias-fault-'));
  const projectId = projectsDb.createProjectPath(projectPath, null, creator).project!.project_id;
  const fence = captureProjectFence(projectId, creator)!;

  __setProjectAliasEnumerationFailureForTests(true);
  assert.doesNotThrow(() => projectsDb.updateProjectIsArchivedById(projectId, true));
  assert.equal(projectsDb.getProjectById(projectId)?.isArchived, 1, 'the database commit remains durable');
  assert.equal(isProjectFenceRuntimeReady(), false);
  assert.equal(isProjectFenceCurrent(fence), false);
  assert.equal(captureProjectFence(projectId, creator), null);
});

test('flag-off service mutations still fence member ABA and redundant admin access', () => {
  const creator = createUser();
  const member = createUser();
  const admin = createUser('admin');
  const projectPath = fs.mkdtempSync(path.join(root, 'flag-off-'));
  const projectId = projectsDb.createProjectPath(projectPath, null, creator).project!.project_id;
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '0';
  try {
    addMember(projectId, member, 'member', creator);
    const memberFence = captureProjectFence(projectId, member)!;
    removeMember(projectId, member, creator);
    assert.equal(isProjectFenceCurrent(memberFence), false);
    addMember(projectId, member, 'member', creator);
    assert.equal(isProjectFenceCurrent(memberFence), false, 're-add cannot revive the removed fence');

    addMember(projectId, admin, 'member', creator);
    const adminFence = captureProjectFence(projectId, admin)!;
    removeMember(projectId, admin, creator);
    assert.equal(isProjectFenceCurrent(adminFence), false, 'residual platform access needs a fresh token');
    assert.ok(captureProjectFence(projectId, admin));
  } finally {
    process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  }
});

test('canonical aliases fail closed and every alias rotates on structural changes', () => {
  const creator = createUser();
  const real = fs.mkdtempSync(path.join(root, 'alias-real-'));
  const link = path.join(root, 'alias-link');
  fs.symlinkSync(real, link);
  const projectA = projectsDb.createProjectPath(real, null, creator).project!;
  const beforeAlias = captureProjectFence(projectA.project_id, creator)!;
  const projectB = projectsDb.createProjectPath(link, null, creator).project!;
  assert.equal(isProjectFenceCurrent(beforeAlias), false, 'alias registration rotates the existing owner');
  assert.equal(captureWorkspaceTopologyFence(real, creator), null);
  assert.equal(captureWorkspaceTopologyFence(link, creator), null);

  const fenceA = captureProjectFence(projectA.project_id, creator)!;
  const fenceB = captureProjectFence(projectB.project_id, creator)!;
  projectsDb.updateProjectIsArchivedById(projectB.project_id, true);
  assert.equal(isProjectFenceCurrent(fenceA), false);
  assert.equal(isProjectFenceCurrent(fenceB), false);
});

test('session discovery through a canonical alias rotates the existing project fence', () => {
  const creator = createUser();
  const real = fs.mkdtempSync(path.join(root, 'session-alias-real-'));
  const link = path.join(root, 'session-alias-link');
  fs.symlinkSync(real, link);
  const projectA = projectsDb.createProjectPath(real, null, creator).project!;
  const fenceA = captureProjectFence(projectA.project_id, creator)!;

  sessionsDb.createSession('session-alias-discovery', 'claude', link);

  assert.equal(isProjectFenceCurrent(fenceA), false);
  assert.equal(captureWorkspaceTopologyFence(real, creator), null);
  assert.equal(captureWorkspaceTopologyFence(link, creator), null);
});

test('retired subjects and projects are forgotten and current checks never mint entries', () => {
  const creator = createUser();
  const member = createUser();
  const projectPath = fs.mkdtempSync(path.join(root, 'bounded-'));
  const projectId = projectsDb.createProjectPath(projectPath, null, creator).project!.project_id;
  projectMembersDb.addAndRotateProjectAccess(projectId, member, 'member', creator);
  const creatorFence = captureProjectFence(projectId, creator)!;
  const memberFence = captureProjectFence(projectId, member)!;
  assert.deepEqual(__projectFenceTokenCountsForTests(), { projects: 1, subjects: 2, structures: 1 });

  projectMembersDb.removeAndRotateProjectAccess(projectId, member);
  assert.equal(isProjectFenceCurrent(memberFence), false);
  assert.deepEqual(__projectFenceTokenCountsForTests(), { projects: 1, subjects: 1, structures: 1 });
  assert.equal(isProjectFenceCurrent(memberFence), false);
  assert.deepEqual(__projectFenceTokenCountsForTests(), { projects: 1, subjects: 1, structures: 1 });

  projectsDb.deleteProjectById(projectId);
  assert.equal(isProjectFenceCurrent(creatorFence), false);
  assert.deepEqual(__projectFenceTokenCountsForTests(), { projects: 0, subjects: 0, structures: 0 });
  assert.equal(isProjectFenceCurrent(creatorFence), false);
  assert.deepEqual(__projectFenceTokenCountsForTests(), { projects: 0, subjects: 0, structures: 0 });
});
