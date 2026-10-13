/**
 * Composition of the session-share feature (ADR-196 T-1970, ADR-205 T-2013)
 * from the production repositories. The management router, the legacy
 * snapshot reader, the live guest routes and the sweeper receive only these
 * injected functions, which keeps them testable without a real database connection.
 */
import {
  createSessionSharesStore, findOwningProject, getConnection, projectsDb, sessionsDb, userDb,
} from '@/modules/database/index.js';
import { resolveStrictSpawnOwnerUserId } from '@/modules/database/repositories/participants.db.js';
import { onSessionSharesRevoked } from '@/modules/database/session-shares.js';
import { isSessionAccessibleByUser } from '@/modules/providers/index.js';

import { createSessionShareManagementRouter, createSessionSharePublicHandler } from '../routes/session-shares.js';
import { createShareViewHandler } from '../routes/share-view.js';

import { liveProjection } from './session-share-live-projection.js';
import { loadAttachment } from './session-share-live-serve.js';
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
 * Builds the runtime pieces. Session archive/delete drops the session's live
 * projection through the revoke hook; the last manual live revoke drops it
 * through the management router.
 * @param {object} options verifyUser, audit(action, userId, metadata), writer middleware,
 *   withWriter(operation) for background writes, publicOrigin, deviceCookieName,
 *   deviceCookiesEnabled
 * @returns {{ managementRouter, publicHandler, shareViewHandler, startSweeper }}
 */
export function createSessionShareRuntime(options) {
  onSessionSharesRevoked((sessionId) => liveProjection.drop(sessionId));
  const recordView = (id, count, at) => options.withWriter(() => getStore().addViews(id, count, at));
  const managementRouter = createSessionShareManagementRouter({
    getStore, policy: sessionSharePolicyDeps, verifyUser: options.verifyUser, audit: options.audit,
    writer: options.writer, publicOrigin: options.publicOrigin,
    deviceCookieName: options.deviceCookieName, deviceCookiesEnabled: options.deviceCookiesEnabled,
    dropProjection: (sessionId) => liveProjection.drop(sessionId),
  });
  const publicHandler = createSessionSharePublicHandler({
    getStore, policy: sessionSharePolicyDeps, publicOrigin: options.publicOrigin, recordView,
  });
  const shareViewHandler = createShareViewHandler({
    getStore, policy: sessionSharePolicyDeps, publicOrigin: options.publicOrigin, recordView,
    projection: liveProjection, loadAttachment,
  });
  const startSweeper = () => startSessionShareSweeper({
    getStore, policy: sessionSharePolicyDeps, withWriter: options.withWriter,
  });
  return { managementRouter, publicHandler, shareViewHandler, startSweeper };
}
