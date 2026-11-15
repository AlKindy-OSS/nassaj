/**
 * local-engine-pin — the engine-pin value of a Claude session that runs on a
 * caller-owned local model server (ADR-227, amending ADR-163/ADR-088).
 *
 * The pin is ONE string in `sessions.engine_provider`:
 *
 *     local:<serverId>:<ownerId>:<originDigest>
 *
 * so it rides the existing single writer (`sessionsDb.setSessionEnginePin`) and
 * its first-verdict-wins CAS unchanged, and every code path that does not know
 * about local engines fails closed on it: `applyClaudeEngineProviderEnv` reports
 * `not_an_engine`, the credential gate finds no requirement, and history
 * inference never yields it (`local` is not in ELIGIBLE_ENGINE_PROVIDERS).
 *
 * The digest is a SHA-256 prefix of the server's normalized origin at pin time,
 * so a server whose address was changed after the chat began is detected
 * (the chat would otherwise follow the row to a different machine). The origin
 * itself is not stored: the value is visible to session readers.
 */

import crypto from 'node:crypto';

import { LOCAL_ENGINE, LOCAL_MODEL_PROVIDER_PREFIX, isLocalModelId } from '../../../shared/localEngine.js';

import { normalizeAuthorizedOrigin } from './anthropic-base-url-guard.js';

// T-2098 stage 3b: one declaration for server and client (shared/localEngine.ts).
export { LOCAL_ENGINE, LOCAL_MODEL_PROVIDER_PREFIX, isLocalModelId };

const PIN_PATTERN = /^local:([A-Za-z0-9-]{1,64}):([1-9][0-9]{0,15}):([0-9a-f]{32})$/u;

/**
 * SHA-256 prefix (128 bits) of a normalized origin. Throws on an origin the
 * guard would not accept, so a pin can never be built from one.
 * @param {string} origin
 * @returns {string}
 */
export function localOriginDigest(origin) {
  const normalized = normalizeAuthorizedOrigin(origin);
  if (normalized === null) throw new Error('A local engine origin must be scheme://host:port with no path.');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Builds the pin value for a resolved local engine.
 * @param {{ serverId: string, ownerId: number, origin: string }} input
 * @returns {string}
 */
export function formatLocalEnginePin({ serverId, ownerId, origin }) {
  const pin = `${LOCAL_ENGINE}:${serverId}:${ownerId}:${localOriginDigest(origin)}`;
  if (!PIN_PATTERN.test(pin)) throw new Error('Invalid local engine pin components.');
  return pin;
}

/**
 * Parses an exact pin value; anything else (including the bare `local` an
 * OpenCode session stores) is null.
 * @param {unknown} value
 * @returns {{ serverId: string, ownerId: number, originDigest: string }|null}
 */
export function parseLocalEnginePin(value) {
  if (typeof value !== 'string') return null;
  const match = PIN_PATTERN.exec(value);
  if (!match) return null;
  const ownerId = Number(match[2]);
  if (!Number.isSafeInteger(ownerId)) return null;
  return { serverId: match[1], ownerId, originDigest: match[3] };
}

/**
 * True for a local pin or the bare local engine id.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLocalEngineValue(value) {
  return value === LOCAL_ENGINE || parseLocalEnginePin(value) !== null;
}

/**
 * T-2098 qa item 7: the ONE reader that turns a stored engine value into what may
 * leave the server (DTOs, user-facing labels, failure ledgers): a composite local
 * pin becomes the bare `local`; every other value passes through; absent is null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function publicEngineValue(value) {
  if (typeof value !== 'string' || value === '') return null;
  return parseLocalEnginePin(value) !== null ? LOCAL_ENGINE : value;
}

/** Typed refusal code of an engine-unaware Claude spawn site (ADR-227). */
export const LOCAL_ENGINE_SPAWN_UNSUPPORTED = 'LOCAL_ENGINE_SPAWN_UNSUPPORTED';

/**
 * ADR-227: spawn sites that run Claude WITHOUT the run profile (background
 * workflow tasks, supervisor roles) would run on official Anthropic. From a
 * local-pinned conversation, or for a local model id, they refuse explicitly.
 * @param {{ storedEngine?: string|null, model?: string|null, site: string }} input
 *   the conversation's engine pin, the requested model, a human label of the site
 * @returns {(Error & {code: string})|null} the refusal, or null to proceed
 */
export function localEngineSpawnRefusal({ storedEngine = null, model = null, site }) {
  if (!isLocalEngineValue(storedEngine) && !isLocalModelId(model)) return null;
  const error = new Error(
    `This chat runs on a local model server; a ${site} cannot run there yet, and it was not `
      + 'started on any other provider. تعذّر التشغيل على خادم النموذج المحلي ولم يُشغَّل على مزوّد آخر.',
  );
  return Object.assign(error, { code: LOCAL_ENGINE_SPAWN_UNSUPPORTED });
}

/** Typed refusal code of an engine re-stamp across a local pin (ADR-227, T-2107). */
export const ENGINE_RESTAMP_LOCAL_PIN = 'ENGINE_RESTAMP_LOCAL_PIN';

/**
 * ADR-227: a chat never moves between a local model server and any other engine,
 * by a spawn or by the authenticated re-stamp route. Body-neutral: it reads only
 * the stored and the requested engine values. Past local turns are booked at zero
 * through the pin (T-2103), so a re-stamp would also re-attribute them.
 * @param {unknown} fromEngine the stored pin (null when none)
 * @param {unknown} toEngine the requested engine
 * @returns {boolean} true when the re-stamp must be refused
 */
export function restampCrossesLocalPin(fromEngine, toEngine) {
  if (fromEngine === toEngine) return false;
  return isLocalEngineValue(fromEngine) || isLocalEngineValue(toEngine);
}
