/**
 * credential-actor — WHO a credential resolution runs for (ADR-152 A1 §3.4).
 *
 * Every provider environment is built for an explicit actor:
 *   - a real member: a positive integer id (or its canonical decimal string);
 *   - SYSTEM_ACTOR: a frozen, unique object for non-inference work with no
 *     request in scope (version, install, update, empty-catalog probes). It has
 *     a credential-less tree under ~/.nassaj-users/.system/ and NEVER reads the
 *     OS user's own credential tree (D2). It is refused for any model run.
 *
 * Anything else — null, undefined, '', 0, a negative or fractional number, a
 * non-canonical string, an anonymous catalog identity, a look-alike object —
 * throws CREDENTIAL_ACTOR_REQUIRED (500) before any environment is built. There
 * is no fallback to the operator's environment.
 *
 * SYSTEM_ACTOR is identified by IDENTITY, not shape, so request data (JSON,
 * headers, tokens) can never produce it. Which modules may name it is pinned by
 * credential-actor.test.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Namespace import on purpose: many test files mock shared/utils with a partial
// export set; a named import would turn each into a link-time SyntaxError.
import * as utils from '../../shared/utils.js';

/**
 * The system actor. Compared by identity only.
 * @type {Readonly<{ kind: 'system' }>}
 */
export const SYSTEM_ACTOR = Object.freeze({ kind: 'system' });

/** Directory name of the system tree under ~/.nassaj-users (never a user id). */
export const SYSTEM_ACTOR_DIRNAME = '.system';

/** @typedef {number | typeof SYSTEM_ACTOR} CredentialActor */

/** A canonical positive decimal: no sign, no leading zero, no whitespace. */
const CANONICAL_ID = /^[1-9][0-9]*$/;

function actorRequired() {
  const message = 'This action needs a signed-in member to run on. No credential was used.';
  const options = { code: 'CREDENTIAL_ACTOR_REQUIRED', statusCode: 500 };
  // utils.AppError is undefined only under a partial test mock of shared/utils;
  // the refusal must still carry its code there.
  return utils.AppError ? new utils.AppError(message, options) : Object.assign(new Error(message), options);
}

/**
 * @param {unknown} actor
 * @returns {boolean} true only for the SYSTEM_ACTOR object itself
 */
export function isSystemActor(actor) {
  return actor === SYSTEM_ACTOR;
}

/**
 * Normalises an actor or throws CREDENTIAL_ACTOR_REQUIRED.
 * @param {unknown} actor
 * @returns {CredentialActor}
 */
export function normalizeCredentialActor(actor) {
  if (actor === SYSTEM_ACTOR) return SYSTEM_ACTOR;
  if (typeof actor === 'number' && Number.isSafeInteger(actor) && actor > 0) return actor;
  if (typeof actor === 'string' && CANONICAL_ID.test(actor)) {
    const id = Number(actor);
    if (Number.isSafeInteger(id)) return id;
  }
  throw actorRequired();
}

/**
 * True when `actor` names a real member (a positive integer id or its canonical
 * string). Readers use it to answer "not linked" for a caller with no member,
 * instead of reading anyone's tree.
 * @param {unknown} actor
 * @returns {boolean}
 */
export function isMemberActor(actor) {
  if (typeof actor === 'number') return Number.isSafeInteger(actor) && actor > 0;
  return typeof actor === 'string' && CANONICAL_ID.test(actor) && Number.isSafeInteger(Number(actor));
}

/**
 * A real member's id, or CREDENTIAL_ACTOR_REQUIRED. For readers of one
 * member's own tree (brain store, MCP config, …) that have no system answer.
 * @param {unknown} actor
 * @returns {number}
 */
export function requireMemberActor(actor) {
  const normalized = normalizeCredentialActor(actor);
  if (normalized === SYSTEM_ACTOR) throw actorRequired();
  return /** @type {number} */ (normalized);
}

/**
 * The actor of a MODEL RUN: a real member only. SYSTEM_ACTOR has no credential
 * and may never run inference.
 * @param {unknown} actor
 * @returns {number}
 */
export function assertModelRunActor(actor) {
  return requireMemberActor(actor);
}

/**
 * The system actor's private, credential-less home, created 0700 on demand.
 * @returns {string}
 */
export function systemActorHome() {
  const root = path.join(os.homedir(), '.nassaj-users', SYSTEM_ACTOR_DIRNAME);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return root;
}
