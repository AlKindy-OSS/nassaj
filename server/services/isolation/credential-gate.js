/**
 * credential-gate — the pre-spawn credential gate (ADR-152 A1 §3.5, T-2083).
 *
 * Every model run is admitted here ONCE, before any child process exists:
 *
 *   1. the actor must be a real member (`assertModelRunActor`; null and the
 *      system actor are refused with CREDENTIAL_ACTOR_REQUIRED);
 *   2. the credential PRINCIPAL is resolved — the member, or the grantor of a
 *      usable ADR-152 grant (`resolveCredentialPrincipal`, read live, no cache);
 *   3. the provider's PRESENCE predicate runs against that principal's own tree
 *      or key slot. Presence only: no network call, no cache, no refresh, no
 *      environment variable (inherited credentials are stripped, §3.5).
 *
 * A missing predicate, an unknown provider or a model the predicate cannot
 * place is refused (fail closed). The refusal is CREDENTIAL_NOT_LINKED (409)
 * with a payload the UI renders as "link my account" / "ask a member to share".
 *
 * `resolveModelRunEnv` is the ONE model-run environment seam: gate first, then
 * `resolveProviderEnv`. It replaces `resolveProviderEnvStrict` (removed). PTY
 * terminals never come here: they run on the caller's own tree with grants off,
 * and linking happens there.
 *
 * The presence predicates mirror the readers in each provider's auth module
 * (claude-auth / codex-auth / antigravity-token-reader / cursor login /
 * opencode-auth / vendor-auth); they are spelled out here so
 * the spawn path pulls in no provider module graph.
 */

import fs from 'node:fs';
import path from 'node:path';

// Namespace import on purpose: many test files mock the database barrel with a
// partial export set; a named import would break them at link time.
import * as database from '../../modules/database/index.js';
import { AppError } from '../../shared/utils.js';

import { assertModelRunActor } from './credential-actor.js';
import { resolveCredentialPrincipal } from './credential-principal.js';
import { KNOWN_PROVIDERS } from './known-providers.js';
import { isLocalEngineValue } from './local-engine-pin.js';
import { isLocalModel } from './local-model-config.js';
import { isQwenPlanModel } from './opencode-qwen-plan.js';
import { spawnVendorRunOf } from './opencode-spawn-vendor.js';
import { resolveSlotKey } from './provider-slot-key.js';
import { userConfigDir } from './provision-user-dirs.js';
import { resolveProviderEnv } from './resolve-provider-env.js';
import { terminateStaleWarmProcesses } from './warm-credential-processes.js';

export const CREDENTIAL_NOT_LINKED = 'CREDENTIAL_NOT_LINKED';

/** The two ways out the UI offers, in display order. */
export const CREDENTIAL_NOT_LINKED_ACTIONS = Object.freeze(['link_own', 'request_share']);

/** The Claude engine that is NOT a vendor (the official Anthropic path). */
const OFFICIAL_ENGINE = 'anthropic';

/** Claude settings.json env keys that make a Claude tree linked (claude-auth parity). */
const CLAUDE_SETTINGS_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** OpenCode models that need no credential: opencode's own `-free` tier. */
const OPENCODE_FREE_MODEL = /^opencode\/[^/\s]+-free$/;

/** Provider aliases callers use for the same isolation unit. */
const PROVIDER_ALIASES = Object.freeze({ antigravity: 'agy' });

/** Isolation key → the id the settings UI knows the provider by. */
const UI_PROVIDER_ID = Object.freeze({ agy: 'antigravity' });

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

/** Parsed JSON object at `file`, or null on any failure (missing, unreadable, invalid). */
function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when `slot` holds a key for `principalId` (own scope only; §3.8). */
function hasSlotKey(principalId, slot) {
  try {
    return resolveSlotKey(principalId, slot) !== null;
  } catch {
    return false;
  }
}

/** Claude: OAuth credential file, or a key/token in the member's own settings.json. */
function claudeTreeLinked(principalId) {
  const dir = userConfigDir(principalId, '.claude');
  const oauth = readJsonObject(path.join(dir, '.credentials.json'))?.claudeAiOauth;
  if (nonEmpty(oauth?.accessToken)) return true;
  const env = readJsonObject(path.join(dir, 'settings.json'))?.env;
  return CLAUDE_SETTINGS_KEYS.some((key) => nonEmpty(env?.[key]));
}

/** Codex: auth.json login tokens or a stored OPENAI_API_KEY. */
function codexTreeLinked(principalId) {
  const auth = readJsonObject(path.join(userConfigDir(principalId, '.codex'), 'auth.json'));
  if (!auth) return false;
  if (nonEmpty(auth.OPENAI_API_KEY)) return true;
  const tokens = auth.tokens;
  return ['refresh_token', 'id_token', 'access_token'].some((field) => nonEmpty(tokens?.[field]));
}

/** agy: the OAuth token file under the principal's home. */
function agyTreeLinked(principalId) {
  const file = path.join(userConfigDir(principalId, '.gemini'), 'antigravity-cli', 'antigravity-oauth-token');
  const token = readJsonObject(file)?.token;
  return nonEmpty(token?.access_token) || nonEmpty(token?.refresh_token);
}

/** cursor: cursor-agent's login state under the principal's home. */
function cursorTreeLinked(principalId) {
  const auth = readJsonObject(path.join(userConfigDir(principalId, '.config'), 'cursor', 'auth.json'));
  return nonEmpty(auth?.accessToken) || nonEmpty(auth?.refreshToken);
}

/** OpenCode auth.json entry for `vendor` (or any entry when `vendor` is null). */
function opencodeAuthEntry(principalId, vendor) {
  const auth = readJsonObject(path.join(userConfigDir(principalId, '.local/share/opencode'), 'auth.json'));
  if (!auth) return false;
  const entries = vendor === null ? Object.values(auth) : [auth[vendor]];
  return entries.some((entry) => entry && typeof entry === 'object'
    && Object.values(entry).some((value) => nonEmpty(value) || (value && typeof value === 'object')));
}

/**
 * @typedef {{ actor: number, mode: string, model: string|null, engine: string|null,
 *   honorGrants: boolean }} GateContext
 * @typedef {{ principalId: number, grantedBy: number|null }} Principal
 * @typedef {Principal & { unit: string, ownOnly: boolean }} Admission whose credential a
 *   turn runs on, and the credential unit (and grant rule) it was admitted under.
 * @typedef {{ unit: string, own?: boolean, linked: (principalId: number) => boolean }} Requirement
 */

/** A requirement on the actor's OWN credential only (no grant applies). */
const own = (unit, linked) => ({ unit, own: true, linked });
/** A requirement on the actor's credential, or a grantor's under a usable grant. */
const granted = (unit, linked) => ({ unit, linked });

/**
 * OpenCode's requirement for one model. The data home (auth.json) follows a
 * grant; the per-turn keys Nassaj injects (qwen-plan, spawn vendors) are the
 * sender's own; a credential-free model needs nothing. Anything else needs the
 * auth.json entry of the model's vendor. A model with no vendor is refused.
 * @param {string|null} model
 * @returns {Requirement|null}
 */
function opencodeRequirement(model) {
  if (model === null) return granted('opencode', (id) => opencodeAuthEntry(id, null));
  if (isLocalModel(model) || OPENCODE_FREE_MODEL.test(model)) return own('opencode', () => true);
  if (isQwenPlanModel(model)) return own('qwen', (id) => hasSlotKey(id, 'qwen'));
  const spawnVendor = spawnVendorRunOf(model);
  if (spawnVendor) return own(spawnVendor.slot, (id) => hasSlotKey(id, spawnVendor.slot));
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  const vendor = model.slice(0, slash);
  return granted('opencode', (id) => opencodeAuthEntry(id, vendor));
}

/**
 * The presence predicate per KNOWN_PROVIDER. Each returns the requirement the
 * run must meet, or null when it cannot be placed (fail closed).
 * @type {Readonly<Record<string, (ctx: GateContext) => Requirement|null>>}
 */
export const CREDENTIAL_PREDICATES = Object.freeze({
  claude: (ctx) => {
    // ADR-227: a caller-owned local model server spends no Anthropic credential
    // and no vendor key. Own-only: sharing a local server waits for T-1807. The
    // run profile proves the server is the caller's before any spawn.
    if (isLocalEngineValue(ctx.engine) || (ctx.engine === null && isLocalModel(ctx.model))) {
      return own('local', () => true);
    }
    if (ctx.engine === null || ctx.engine === OFFICIAL_ENGINE) return granted('claude', claudeTreeLinked);
    // A vendor engine drives the Claude body on the CALLER's own key of that
    // vendor (ADR-037; apply-claude-engine-provider-env keyOwner 'caller'), so
    // no grant applies here — the gate must match what the run spends (qa M2).
    return ['kimi', 'deepseek', 'glm'].includes(ctx.engine)
      ? own(ctx.engine, (id) => hasSlotKey(id, ctx.engine))
      : null;
  },
  codex: () => granted('codex', codexTreeLinked),
  agy: () => granted('agy', agyTreeLinked),
  cursor: () => granted('cursor', cursorTreeLinked),
  opencode: (ctx) => opencodeRequirement(ctx.model),
  kimi: () => granted('kimi', (id) => hasSlotKey(id, 'kimi')),
  deepseek: () => granted('deepseek', (id) => hasSlotKey(id, 'deepseek')),
  glm: () => granted('glm', (id) => hasSlotKey(id, 'glm')),
  qwen: () => own('qwen', (id) => hasSlotKey(id, 'qwen')),
  // T-2086/ADR-224: the dsh body spends the member's OWN deepseek key slot —
  // like the deepseek engine above, no grant ever admits a dsh turn. ADR-227 /
  // T-2108: a chat pinned to the caller's local server, or a new chat on a local
  // model, spends no DeepSeek key; the runtime proves the server is the caller's.
  dsh: (ctx) => (isLocalEngineValue(ctx.engine) || (ctx.engine === null && isLocalModel(ctx.model))
    ? own('local', () => true)
    : own('deepseek', (id) => hasSlotKey(id, 'deepseek'))),
});

/** The username of `userId`, or null. Never the email (qa condition 10). */
function usernameOf(userId) {
  try {
    const name = database.userDb?.getUserById?.(Number(userId))?.username;
    return nonEmpty(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Builds the CREDENTIAL_NOT_LINKED refusal.
 * @param {string} provider isolation key
 * @param {Principal|null} principal null when no requirement could be placed
 * @returns {AppError}
 */
export function credentialNotLinkedError(provider, principal) {
  const uiProvider = UI_PROVIDER_ID[provider] ?? provider;
  const grantor = principal?.grantedBy ?? null;
  const grantorUsername = grantor === null ? null : usernameOf(grantor);
  const details = {
    code: CREDENTIAL_NOT_LINKED,
    provider: uiProvider,
    reason: grantor === null ? 'not_linked' : 'grantor_not_linked',
    ...(grantorUsername ? { grantorUsername } : {}),
    actions: [...CREDENTIAL_NOT_LINKED_ACTIONS],
    settingsAnchor: `agents/${uiProvider}`,
    messageAr: grantor === null
      ? 'لم تربط حساباً لهذا المزوّد بعد. اربط حسابك، أو اطلب من عضو أن يشارك اعتماده معك.'
      : 'العضو الذي شارك معك اعتماده لم يعد مربوطاً بهذا المزوّد. اربط حسابك، أو اطلب مشاركة من عضو آخر.',
  };
  const message = grantor === null
    ? `You have not linked an account for ${uiProvider}. Link your own account, or ask a member to share theirs.`
    : `The member who shared ${uiProvider} with you is no longer linked. Link your own account, or ask for a share.`;
  return new AppError(message, { code: CREDENTIAL_NOT_LINKED, statusCode: 409, details });
}

/** True for a CREDENTIAL_NOT_LINKED refusal from this gate. */
export function isCredentialNotLinked(error) {
  return Boolean(error) && typeof error === 'object' && /** @type {any} */ (error).code === CREDENTIAL_NOT_LINKED;
}

/**
 * The client-safe payload of a CREDENTIAL_NOT_LINKED refusal, or null.
 * @param {unknown} error
 * @returns {Record<string, unknown>|null}
 */
export function credentialNotLinkedPayload(error) {
  if (!isCredentialNotLinked(error)) return null;
  const details = /** @type {any} */ (error).details;
  return details && typeof details === 'object' ? { ...details } : null;
}

const normalizeText = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * Admits one model turn: terminates any warm process of this member and
 * provider that runs on a principal other than the one resolved now (AT3),
 * then checks presence. Returns whose credential the turn runs on.
 *
 * @param {{ actor: unknown, provider: string, mode?: string, model?: string|null,
 *   engine?: string|null, honorGrants?: boolean }} input
 * @returns {Admission}
 * @throws {AppError} CREDENTIAL_ACTOR_REQUIRED (500) or CREDENTIAL_NOT_LINKED (409)
 */
export function assertCredentialLinked({ actor, provider, mode = 'chat', model = null, engine = null, honorGrants = true }) {
  const memberId = assertModelRunActor(actor);
  const key = PROVIDER_ALIASES[provider] ?? provider;
  const predicate = KNOWN_PROVIDERS.includes(key) ? CREDENTIAL_PREDICATES[key] : undefined;
  /** @type {GateContext} */
  const ctx = { actor: memberId, mode, model: normalizeText(model), engine: normalizeText(engine), honorGrants };
  const requirement = typeof predicate === 'function' ? predicate(ctx) : null;
  if (!requirement) throw credentialNotLinkedError(key, null);

  const ownOnly = Boolean(requirement.own) || !honorGrants;
  const resolved = ownOnly
    ? { principalId: memberId, grantedBy: null }
    : resolveCredentialPrincipal(memberId, requirement.unit);
  const principal = {
    principalId: Number(resolved.principalId),
    grantedBy: resolved.grantedBy === null ? null : Number(resolved.grantedBy),
  };
  // Revocation reaches warm sessions at the next turn (§3.5): a reusable live
  // process of this credential unit still on another principal ends first.
  terminateStaleWarmProcesses({ userId: memberId, unit: requirement.unit });
  // The refusal names the credential actually missing: a Claude turn on the glm
  // engine needs the glm key, an OpenCode qwen-plan turn the qwen key.
  if (!requirement.linked(principal.principalId)) throw credentialNotLinkedError(requirement.unit, principal);
  return { ...principal, unit: requirement.unit, ownOnly };
}

/**
 * The model-run environment: the gate, then the isolated environment of the
 * principal it admitted. The single seam for every model-run spawn (replaces
 * `resolveProviderEnvStrict`).
 *
 * @param {unknown} actor the member running the turn
 * @param {import('./resolve-provider-env.js').ProviderName} provider
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {import('./resolve-provider-env.js').ProviderMode} [mode]
 * @param {{ model?: string|null, engine?: string|null, honorGrants?: boolean }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function resolveModelRunEnv(actor, provider, baseEnv = process.env, mode = 'chat', options = {}) {
  const honorGrants = options.honorGrants !== false;
  assertCredentialLinked({ actor, provider, mode, model: options.model, engine: options.engine, honorGrants });
  return resolveProviderEnv(assertModelRunActor(actor), provider, baseEnv, mode, { honorGrants });
}

/**
 * The engine a Claude turn on `sessionId` is pinned to, or null (official or
 * unknown). A read failure answers null: the run profile re-checks with the
 * authoritative pin before any spawn.
 * @param {string|null|undefined} sessionId
 * @returns {string|null}
 */
function storedEnginePin(sessionId) {
  if (!sessionId) return null;
  try {
    return normalizeText(database.sessionsDb?.getSessionEnginePin?.(sessionId)?.engine);
  } catch {
    return null;
  }
}

/**
 * Turn admission for an entry point that knows the session but not the final
 * engine (chat WebSocket, REST /api/agent): a Claude turn is checked against the
 * client's engine, else the session's stored pin. The run profile repeats the
 * check with the authoritative engine before the child process.
 *
 * @param {{ actor: unknown, provider: string, mode?: string, model?: string|null,
 *   clientEngine?: string|null, sessionId?: string|null }} input
 * @returns {Admission}
 */
export function admitCredentialTurn({ actor, provider, mode = 'chat', model = null, clientEngine = null, sessionId = null }) {
  // T-2108: a dsh turn reads only the stored pin (its client sends no engine).
  const engine = provider === 'claude' ? (normalizeText(clientEngine) ?? storedEnginePin(sessionId))
    : (provider === 'dsh' ? storedEnginePin(sessionId) : null);
  return assertCredentialLinked({ actor, provider, mode, model, engine });
}

/** Exposed for the static guard: every KNOWN_PROVIDER has a predicate. */
export function hasCredentialPredicate(provider) {
  return typeof CREDENTIAL_PREDICATES[PROVIDER_ALIASES[provider] ?? provider] === 'function';
}
