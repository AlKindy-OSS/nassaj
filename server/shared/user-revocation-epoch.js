/**
 * B-1327 (qa M2): closes the pre-registration window of administrative
 * revocation. A run is visible to revocation only once it registers (monitor
 * registration needs a session id; supervised runs bind on onSession), so a
 * turn launched just before an account is disabled could register afterwards
 * and survive. Every writer is stamped with a logical epoch when created;
 * revocation advances the epoch per user. A registration whose writer predates
 * its user's latest revocation is handed to the bound late-run handler, which
 * aborts it with the same typed reason.
 *
 * Process-local on purpose: runs and writers are process-local too. Unstamped
 * objects (ad-hoc test doubles) are never judged revoked.
 */

import { unwrapWriter } from './writer-target.js';

let clock = 0;
const writerEpochs = new WeakMap();
/** String(userId) → { epoch, reason } of that user's latest revocation. */
const revocations = new Map();
let lateRunHandler = null;

/**
 * Records the creation epoch of a transport writer. Call from every writer
 * constructor (or factory) whose runs may be revoked. Returns the writer.
 * @template T
 * @param {T} writer
 * @returns {T}
 */
export function stampWriterEpoch(writer) {
  if (writer && typeof writer === 'object') writerEpochs.set(writer, clock);
  return writer;
}

/**
 * Marks every writer of `userId` created so far as revoked for `reason`.
 * @param {number|string} userId
 * @param {string} reason typed revocation reason (account_disabled, …)
 */
export function recordUserRevocation(userId, reason) {
  if (userId === null || userId === undefined || String(userId) === '') return;
  clock += 1;
  revocations.set(String(userId), { epoch: clock, reason });
}

/**
 * The revocation reason that applies to `writer` (seen through any proxy), or
 * null when its user was not revoked after the writer was created.
 * @param {unknown} writer
 * @returns {string|null}
 */
export function revocationReasonForWriter(writer) {
  const raw = unwrapWriter(writer);
  if (!raw || typeof raw !== 'object') return null;
  const born = writerEpochs.get(raw);
  const userId = raw.userId;
  if (born === undefined || userId === null || userId === undefined || String(userId) === '') return null;
  const revoked = revocations.get(String(userId));
  return revoked && born < revoked.epoch ? revoked.reason : null;
}

/**
 * Binds the handler that aborts a run registered after its user's revocation.
 * Returns an unbind that only removes this handler.
 * @param {(run: { sessionId: string, provider: string, token: unknown, writer: unknown, reason: string }) => void} handler
 * @returns {() => void}
 */
export function bindLateRevokedRunHandler(handler) {
  lateRunHandler = handler;
  return () => {
    if (lateRunHandler === handler) lateRunHandler = null;
  };
}

/**
 * Called by every registration point. When the writer predates its user's
 * revocation, schedules the abort on the next turn of the event loop (after
 * the provider finished wiring its own session map) and returns true.
 * @param {{ sessionId: string, provider: string, token: unknown, writer: unknown }} run
 * @returns {boolean}
 */
export function abortIfWriterRevoked(run) {
  const reason = revocationReasonForWriter(run?.writer);
  const handler = lateRunHandler;
  if (!reason || !handler || !run?.sessionId) return false;
  setImmediate(() => handler({ ...run, reason }));
  return true;
}
