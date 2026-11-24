/**
 * Lifecycle hook of the pooled agy ACP processes (T-2094), wired once from
 * server/index.js: a member must not keep a live agy process in a project they
 * just lost. Grant revocation, decline and owner disable reach pooled
 * processes through warm-credential-processes.js (registered by the runner).
 */

import { killPooledAgyForMember } from './agy-acp-runner.js';

/**
 * Subscribes the pool to project-member removal.
 * @param {{ onMemberRemoved: (l: (e: any) => void) => () => void }} hooks
 * @returns {() => void} unsubscribe
 */
export function wireAgyAcpLifecycle({ onMemberRemoved }) {
  return onMemberRemoved((event) => {
    if (event?.stillHasAccess || !Number.isInteger(event?.userId)) return;
    killPooledAgyForMember(event.userId, { cwdPrefix: event.projectPath, reason: 'member_removed' });
  });
}
