/**
 * T-1950 — notifyProjectMetadataChanged: a DB-only project change (the project
 * link) reaches connected clients through the shared `projects_updated` queue,
 * with no provider/session attached, and each recipient gets exactly the
 * project set its own authenticated fetch would return (B-PRIV filtering is
 * inherited, not re-implemented).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  stopReconcileScheduler,
  userDb,
} from '@/modules/database/index.js';
import { getProjectsWithSessions } from '@/modules/projects/index.js';
import { notifyProjectMetadataChanged } from '@/modules/providers/services/sessions-watcher.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

const PUBLIC_PATH = '/workspace/t1950-public';
const PRIVATE_PATH = '/workspace/t1950-private';
const BROADCAST_TIMEOUT_MS = 5_000;

type Frame = {
  watchProviders: unknown[];
  updatedSessionIds: unknown[];
  projects: Array<{ fullPath: string; linkUrl: string | null }>;
};

function connectFakeClient(userId: number): { client: RealtimeClientConnection; frames: Frame[] } {
  const frames: Frame[] = [];
  const client: RealtimeClientConnection = {
    readyState: WS_OPEN_STATE,
    userId,
    send(data: string) {
      const parsed = JSON.parse(data) as Frame & { type?: string };
      if (parsed.type === 'projects_updated') frames.push(parsed);
    },
  };
  connectedClients.add(client);
  return { client, frames };
}

async function waitForFrames(...frameLists: Frame[][]): Promise<void> {
  const deadline = Date.now() + BROADCAST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (frameLists.every((frames) => frames.length > 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('notifyProjectMetadataChanged never broadcast projects_updated');
}

const paths = (frame: Frame) => frame.projects.map((project) => project.fullPath).sort();

test('project link change is broadcast per recipient with the recipient-scoped project set', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 't1950-project-metadata-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
  stopReconcileScheduler();

  const stamp = Date.now();
  const ownerId = userDb.createUser(`t1950_owner_${stamp}`, 'hash', 'user').id;
  const strangerId = userDb.createUser(`t1950_stranger_${stamp}`, 'hash', 'user').id;
  const publicId = projectsDb.createProjectPath(PUBLIC_PATH, null, ownerId).project?.project_id ?? '';
  const privateId = projectsDb.createProjectPath(PRIVATE_PATH, null, ownerId).project?.project_id ?? '';
  projectsDb.setProjectVisibility(privateId, 'private');
  projectsDb.setProjectLinkUrl(publicId, 'https://public.example/');
  projectsDb.setProjectLinkUrl(privateId, 'https://private.example/');

  const owner = connectFakeClient(ownerId);
  const stranger = connectFakeClient(strangerId);
  try {
    notifyProjectMetadataChanged();
    await waitForFrames(owner.frames, stranger.frames);

    const ownerFrame = owner.frames[0];
    assert.deepEqual(ownerFrame.watchProviders, [], 'no provider is attached to a project-only change');
    assert.deepEqual(ownerFrame.updatedSessionIds, []);
    assert.equal(
      ownerFrame.projects.find((project) => project.fullPath === PUBLIC_PATH)?.linkUrl,
      'https://public.example/',
      'the new link rides the frame',
    );

    for (const [userId, frame] of [[ownerId, ownerFrame], [strangerId, stranger.frames[0]]] as const) {
      const direct = await getProjectsWithSessions({ skipSynchronization: true, currentUserId: userId, broadcastProgress: false });
      assert.deepEqual(
        paths(frame),
        direct.map((project) => project.fullPath).sort(),
        'the broadcast carries exactly what the recipient may fetch',
      );
    }
    const strangerPrivate = stranger.frames[0].projects.find((project) => project.fullPath === PRIVATE_PATH);
    if (!projectsDb.isProjectVisibleToUser(privateId, strangerId)) {
      assert.equal(strangerPrivate, undefined, 'a private project the stranger cannot see is not leaked');
    }
  } finally {
    connectedClients.delete(owner.client);
    connectedClients.delete(stranger.client);
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
