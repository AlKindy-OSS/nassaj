import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, participantsDb, projectsDb, sessionAgentsDb, sessionsDb, userDb } from '@/modules/database/index.js';

let getSessionAgentsCalls = 0;
mock.module('@/services/transcript-parser.js', {
  namedExports: {
    getSessionAgents: async () => {
      getSessionAgentsCalls += 1;
      return [];
    },
  },
});

const { participantsService } = await import('./participants.service.js');

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'participants-service-'));
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  closeConnection();
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('project participant summary returns humans and already-parsed agents without visiting transcript paths', async () => {
  await withIsolatedDatabase(async () => {
    getSessionAgentsCalls = 0;
    const owner = userDb.createUser('participants_service_owner', 'hash', 'user');
    const projectPath = '/workspace/project-participants-service';
    const project = projectsDb.createProjectPath(projectPath, 'Participants', owner.id).project!;

    // A directory is intentionally supplied where a transcript file would be.
    // The project summary must stay a DB-only read; parsing this path would fail
    // or block the sidebar despite the cached agent row being sufficient.
    sessionsDb.createSession('participants-service-active', 'claude', projectPath, undefined, undefined, undefined, projectPath);
    sessionsDb.createSession('participants-service-archived', 'claude', projectPath);
    sessionsDb.updateSessionIsArchived('participants-service-archived', true);
    participantsDb.recordSpawn('participants-service-active', owner.id);
    sessionAgentsDb.replaceForSession(
      'participants-service-active',
      [{ agent_name: 'claude-sonnet', agent_kind: 'model', invocation_count: 4 }],
      123,
    );
    sessionAgentsDb.replaceForSession(
      'participants-service-archived',
      [{ agent_name: 'archived-agent', agent_kind: 'model', invocation_count: 1 }],
      123,
    );

    const result = await participantsService.getProjectParticipants(project.project_id);

    assert.deepEqual(result.users.map((user) => user.userId), [owner.id]);
    assert.deepEqual(result.agents, [
      {
        agent_name: 'claude-sonnet',
        agent_kind: 'model',
        invocation_count: 4,
        agent_model: null,
        agent_provider: null,
      },
    ]);
    assert.equal(result.agentsSource, 'cache');
    assert.equal(getSessionAgentsCalls, 0, 'sidebar summary must not parse project transcripts');
  });
});

test('project participant summary labels an empty agent cache and rejects unknown projects', async () => {
  await withIsolatedDatabase(async () => {
    getSessionAgentsCalls = 0;
    const owner = userDb.createUser('participants_service_empty_owner', 'hash', 'user');
    const projectPath = '/workspace/project-participants-empty-cache';
    const project = projectsDb.createProjectPath(projectPath, 'Empty cache', owner.id).project!;
    sessionsDb.createSession('participants-service-empty-cache', 'claude', projectPath);
    participantsDb.recordSpawn('participants-service-empty-cache', owner.id);

    const result = await participantsService.getProjectParticipants(project.project_id);

    assert.deepEqual(result.users.map((user) => user.userId), [owner.id]);
    assert.deepEqual(result.agents, []);
    assert.equal(result.agentsSource, 'cache');
    assert.equal(getSessionAgentsCalls, 0);

    await assert.rejects(
      () => participantsService.getProjectParticipants('missing-project'),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PROJECT_NOT_FOUND',
    );
  });
});
