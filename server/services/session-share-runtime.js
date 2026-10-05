/**
 * Composition of the session-share feature (ADR-196, T-1970 stage 4) from the
 * production repositories. The router, public reader and sweeper receive only
 * these injected functions, which keeps them testable without a real database connection.
 */
import {
  createSessionSharesStore, findOwningProject, getConnection, projectsDb, sessionsDb, userDb,
} from '@/modules/database/index.js';
import { resolveStrictSpawnOwnerUserId } from '@/modules/database/repositories/participants.db.js';
import { isSessionAccessibleByUser } from '@/modules/providers/index.js';

import { createSessionShareManagementRouter, createSessionSharePublicHandler } from '../routes/session-shares.js';

import { createShareOwnerNotifier } from './session-share-policy.js';
import { buildSessionShareSnapshot } from './session-share-snapshot.js';
import { startSessionShareSweeper } from './session-share-sweeper.js';

/** Production lookups shared by the management routes, public reads and the sweeper. */
export const sessionSharePolicyDeps = Object.freeze({
  getSession: (sessionId) => sessionsDb.getSessionById(sessionId) ?? null,
  resolveOwner: (sessionId) => resolveStrictSpawnOwnerUserId(sessionId),
  findProject: (projectPath) => {
    const owner = findOwningProject(projectPath);
    if (!owner) return null;
    const row = projectsDb.getProjectById(owner.project_id);
    return row ? { project_id: row.project_id, isArchived: Boolean(row.isArchived) } : null;
  },
  getActiveUser: (userId) => userDb.getUserById(userId) ?? null,
  /** Username for list labels, including deactivated creators; never other columns. */
  getUserName: (userId) => userDb.getRawById(userId)?.username ?? null,
  isSessionReadable: (sessionId, projectPath, userId) => isSessionAccessibleByUser(sessionId, projectPath, userId, 'read'),
});

const getStore = () => createSessionSharesStore(getConnection());

/**
 * Builds the three runtime pieces.
 * @param {object} options verifyUser, audit(action, userId, metadata), writer middleware,
 *   withWriter(operation) for background writes, publicOrigin, deviceCookieName,
 *   deviceCookiesEnabled
 */
export function createSessionShareRuntime(options) {
  const notify = createShareOwnerNotifier({
    loadOrchestrator: () => import('./notification-orchestrator.js'),
    audit: options.audit,
  });
  const managementRouter = createSessionShareManagementRouter({
    getStore, policy: sessionSharePolicyDeps, verifyUser: options.verifyUser,
    buildSnapshot: (input) => buildSessionShareSnapshot(input), audit: options.audit, notify,
    writer: options.writer, publicOrigin: options.publicOrigin,
    deviceCookieName: options.deviceCookieName, deviceCookiesEnabled: options.deviceCookiesEnabled,
  });
  const publicHandler = createSessionSharePublicHandler({
    getStore, policy: sessionSharePolicyDeps, publicOrigin: options.publicOrigin,
    recordView: (id, count, at) => options.withWriter(() => getStore().addViews(id, count, at)),
  });
  const startSweeper = () => startSessionShareSweeper({
    getStore, policy: sessionSharePolicyDeps, withWriter: options.withWriter,
  });
  return { managementRouter, publicHandler, startSweeper };
}
