/**
 * apply-claude-local-engine-env — runs the Claude Code body on a local model
 * server the CALLER registered (ADR-227, T-2098; amends ADR-163's
 * `claude × local = blocked_by_us`). Sibling of apply-claude-engine-provider-env
 * and the same verdict shape, but a separate path: `local` is not an
 * ELIGIBLE_ENGINE_PROVIDER, is never inferred from history, and is authorized by
 * full ORIGIN (scheme + host + port), never by host.
 *
 * Rules, each fail-closed (a refusal sets nothing in `env`):
 *   - the Claude local switch on (local-model-config claudeLocalEngineEnabled,
 *     default off) and the caller under no credential grant (sharing waits for T-1807);
 *   - the server row is the caller's own, read fresh (never from generated files);
 *   - a pinned session resumes only on the pinned server, by its owner, at the
 *     origin it was pinned on (a moved server is refused, not followed);
 *   - every resolved address is PRIVATE (loopback, RFC1918, tailnet, IPv6
 *     ULA/loopback), re-checked at spawn time, over https too, and the CLI gets
 *     the vetted IP literal, never the name (sh3); https by name is refused;
 *   - the model's context window is known and holds the measured Claude Code base
 *     prompt plus the output cap plus a margin; a `claude-*` id is refused because
 *     the CLI ignores CLAUDE_CODE_MAX_CONTEXT_TOKENS for it.
 *
 * Measured against claude 2.1.312 on llama-swap (T-2098 stage 2): with a stored
 * claude.ai login and no ANTHROPIC_AUTH_TOKEN the CLI sent the OAuth bearer to the
 * custom base URL. So the token is ALWAYS set (the server key or a fixed,
 * non-secret placeholder) and the caller runs the child on a credential-free
 * config dir (engine-pin-config-dir.js).
 *
 * @typedef {{status:'none'}} LocalNotRequested
 * @typedef {{ pin:string, serverId:string, ownerId:number, providerId:string, model:string,
 *   origin:string, address:string, connectOrigin:string, contextWindow:number,
 *   outputTokens:number }} LocalEngine `origin` is the REGISTERED origin (pin digest);
 *   `connectOrigin` is the same origin on the vetted literal `address` (ANTHROPIC_BASE_URL)
 * @typedef {{status:'applied', provider:'local', hosts:Set<string>, origins:Set<string>,
 *   local:LocalEngine}} LocalApplied
 * @typedef {{status:'unavailable', provider:'local', reason:string}} LocalUnavailable
 * @typedef {LocalNotRequested|LocalApplied|LocalUnavailable} LocalEngineVerdict
 */

import { isIP } from 'node:net';

import { normalizeAuthorizedOrigin } from './anthropic-base-url-guard.js';
import { LOCAL_ENGINE_ROUTE_OVERRIDE_KEYS } from './engine-anthropic-credential-guard.js';
import {
  LOCAL_ENGINE,
  formatLocalEnginePin,
  isLocalEngineValue,
  isLocalModelId,
  localOriginDigest,
  parseLocalEnginePin,
} from './local-engine-pin.js';

/**
 * Claude Code's fixed base prompt (system prompt + 12 tool schemas), rounded up.
 * Measured on the first request of a fresh session: gpt-oss-20b 7,266-7,287,
 * qwen3.6-35b 9,185-9,213, gemma-4-26b 10,977 tokens; 12,000 is the largest
 * measurement plus ~9% for tokenizer variance and CLI growth.
 */
export const CLAUDE_LOCAL_BASE_PROMPT_TOKENS = 12000;
/**
 * Output reservation. The CLI default (32,000) on a 32k window triggered
 * compaction at ~10.7k tokens; 4,096 removed it in the measured task.
 */
export const CLAUDE_LOCAL_OUTPUT_CAP_TOKENS = 4096;
/** Floor for an owner-set maxOutput, so a reply is never squeezed to nothing. */
export const CLAUDE_LOCAL_MIN_OUTPUT_TOKENS = 1024;
/** Room for the first user message and tool results on top of the base prompt. */
export const CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS = 2000;
/** Bearer sent to a server without a key; never a secret, never an Anthropic value. */
export const LOCAL_NO_KEY_PLACEHOLDER = 'nassaj-local-no-key';
/** Local generation is slow; measured turns reached 76 s before the first token. */
export const LOCAL_API_TIMEOUT_MS = '600000';

/** Every model knob the CLI reads; all map to the one local model id. */
const MODEL_ENV_KEYS = Object.freeze([
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_AUTO_MODE_MODEL', 'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
]);

/** Inherited routes that would take the run anywhere but the server. */
const STRIPPED_ROUTE_KEYS = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  ...LOCAL_ENGINE_ROUTE_OVERRIDE_KEYS,
]);

/**
 * Every env key this module writes or strips; the derived config dir drops them
 * from the member's user settings (project settings carrying a route override
 * are refused by the spawn guard instead, since nassaj does not rewrite them).
 */
export const LOCAL_ENGINE_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', ...MODEL_ENV_KEYS,
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
  'CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_ATTRIBUTION_HEADER', 'API_TIMEOUT_MS', ...LOCAL_ENGINE_ROUTE_OVERRIDE_KEYS,
]);

/**
 * Config-dir entries a local run gets privately instead of linked from the member
 * tree: its zip-cache plugin mode rewrites `plugins/`, which ordinary Claude chats
 * read (T-2098 qa round 2).
 */
export const LOCAL_ENGINE_PRIVATE_ENTRIES = Object.freeze(['plugins']);

/**
 * Smallest context window a Claude-body run accepts for a given output cap.
 * @param {number} outputTokens
 * @returns {number}
 */
export function minimumClaudeLocalContextWindow(outputTokens) {
  return CLAUDE_LOCAL_BASE_PROMPT_TOKENS + outputTokens + CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS;
}

const DEP_KEYS = Object.freeze(['enabled', 'runnable', 'listServers', 'getSecret', 'resolvePrivate', 'cliVersionProven']);

/**
 * Caches a fulfilled async load; a rejected one is forgotten so the next call
 * retries (T-2098 qa item 8: one transient import failure must not refuse every
 * later local spawn until restart).
 * @template T
 * @param {() => Promise<T>} factory
 * @returns {() => Promise<T>}
 */
export function memoizeUntilRejected(factory) {
  /** @type {Promise<T>|null} */
  let pending = null;
  return () => {
    pending ??= factory().catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/**
 * Production dependencies, loaded on first use so every importer of the run
 * profile stays free of the database and connector graph until a local run.
 * @returns {Promise<Record<string, Function>>}
 */
const loadDefaultDeps = memoizeUntilRejected(() => Promise.all([
  import('./local-model-config.js'),
  import('./provider-secrets-store.js'),
  import('../../modules/connectors/index.js'),
  import('./claude-local-cli-proof.js'),
  import('../../modules/providers/index.js'),
]).then(([config, secrets, connectors, proof, providers]) => ({
  enabled: config.claudeLocalEngineEnabled,
  runnable: config.claudeLocalModelsRunnable,
  listServers: config.authorizedLocalModelServers,
  getSecret: secrets.getLocalModelSecret,
  resolvePrivate: (url) => connectors.resolvePrivateLocalModelAddress(url),
  cliVersionProven: async () => proof.isClaudeLocalVersionProven(await providers.readInstalledHarnessVersion('claude')),
})));

const VERSION_GATED_DEP_KEYS = Object.freeze(['enabled', 'runnable', 'listServers', 'getSecret', 'resolvePrivate', 'isVersionProven']);

/**
 * T-2107/T-2108: the production dependencies of a body whose CLI version gate is
 * bound to the exact executable of the launch (Codex, DSH), loaded on first local
 * use only. `pick` supplies the body's own switch and grant rule.
 * @param {string} body proof registry of the body (claude-local-cli-proof.js)
 * @param {(config: Record<string, Function>) => {enabled: Function, runnable: Function}} pick
 * @returns {() => Promise<Record<string, Function>>}
 */
export function versionGatedLocalDeps(body, pick) {
  return memoizeUntilRejected(() => Promise.all([
    import('./local-model-config.js'),
    import('./provider-secrets-store.js'),
    import('../../modules/connectors/index.js'),
    import('./claude-local-cli-proof.js'),
  ]).then(([config, secrets, connectors, proof]) => ({
    ...pick(config),
    listServers: config.authorizedLocalModelServers,
    getSecret: secrets.getLocalModelSecret,
    resolvePrivate: (url) => connectors.resolvePrivateLocalModelAddress(url),
    isVersionProven: (version) => proof.isLocalCliVersionProven(body, version),
  })));
}

/**
 * Injected dependencies win; missing ones come from `loadDefaults`. The CLI gate
 * is bound to the exact version of the executable this launch will run.
 * @param {Record<string, Function>} deps
 * @param {() => Promise<Record<string, Function>>} loadDefaults
 * @param {string|null|undefined} cliVersion
 * @returns {Promise<Record<string, Function>>}
 */
export async function resolveVersionGatedDeps(deps, loadDefaults, cliVersion) {
  const d = VERSION_GATED_DEP_KEYS.every((key) => typeof deps[key] === 'function') ? deps : { ...(await loadDefaults()), ...deps };
  return { ...d, cliVersionProven: async () => Boolean(await d.isVersionProven(cliVersion)) };
}

/**
 * Injected dependencies win; missing ones come from production.
 * @param {Record<string, Function>} deps
 * @returns {Promise<Record<string, Function>>}
 */
async function resolveDeps(deps) {
  if (DEP_KEYS.every((key) => typeof deps[key] === 'function')) return deps;
  return { ...(await loadDefaultDeps()), ...deps };
}

/**
 * @param {string} reason
 * @returns {LocalUnavailable}
 */
const refuse = (reason) => ({ status: 'unavailable', provider: LOCAL_ENGINE, reason });

/**
 * Origin of a stored base URL (`…/v1` stripped). Null when the URL carries any
 * other path, query or credentials: the guard authorizes bare origins only.
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function localServerOrigin(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (path !== '' && path !== '/v1') return null;
  url.pathname = '/';
  return normalizeAuthorizedOrigin(url.href) === null ? null : url.origin;
}

/**
 * Picks the server for the request: the pinned one, or the one the model id names.
 * @returns {{server:object}|LocalUnavailable}
 */
function selectServer(servers, userId, pin, requestedModel) {
  if (pin && pin.ownerId !== Number(userId)) return refuse('owner_mismatch');
  const server = pin
    ? servers.find((row) => row.id === pin.serverId)
    : servers.find((row) => requestedModel.startsWith(`${row.providerId}/`));
  if (!server) return refuse('server_not_found');
  if (Number(server.ownerId) !== Number(userId)) return refuse('owner_mismatch');
  return { server };
}

/**
 * Output tokens a run reserves for a model: the cap, lowered by the owner's
 * `maxOutput`, never below the floor. Body-neutral (T-2107: Codex reserves the same).
 * @param {{maxOutput?: unknown}} model
 * @returns {number}
 */
export function localModelOutputTokens(model) {
  const ownerCap = Number.isSafeInteger(model.maxOutput) && model.maxOutput > 0 ? model.maxOutput : Infinity;
  return Math.max(CLAUDE_LOCAL_MIN_OUTPUT_TOKENS, Math.min(CLAUDE_LOCAL_OUTPUT_CAP_TOKENS, ownerCap));
}

/**
 * T-2098 stage 3b: the ONE static vetting of a local model for the Claude body,
 * used by the spawn (selectModel) and by the picker overlay. No I/O.
 * @param {{id: string, contextWindow?: unknown, maxOutput?: unknown}} model
 * @returns {'ok'|'model_id_reserved'|'context_unknown'|'context_too_small'}
 */
export function claudeLocalModelEligibility(model) {
  if (/^claude-/iu.test(model.id)) return 'model_id_reserved';
  const window = model.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) return 'context_unknown';
  if (window < minimumClaudeLocalContextWindow(localModelOutputTokens(model))) return 'context_too_small';
  return 'ok';
}

/**
 * True for a model id the CLI cannot receive (whitespace or control characters).
 * @param {string} id
 * @returns {boolean}
 */
export function isUnusableLocalModelId(id) {
  return /[\s\x00-\x1f\x7f]/u.test(id);
}

/**
 * Picks and vets the model on the server with the body's static eligibility.
 * @param {(model: object) => string} eligibility 'ok' or a refusal reason
 * @returns {{model:object, outputTokens:number}|LocalUnavailable}
 */
function selectModel(server, requestedModel, eligibility) {
  if (requestedModel && !requestedModel.startsWith(`${server.providerId}/`)) return refuse('pin_conflict');
  const id = requestedModel ? requestedModel.slice(server.providerId.length + 1) : server.models[0]?.id;
  const model = server.models.find((row) => row.id === id);
  if (!model) return refuse('model_not_found');
  const verdict = eligibility(model);
  if (verdict !== 'ok') return refuse(verdict);
  if (isUnusableLocalModelId(model.id)) return refuse('model_not_found');
  return { model, outputTokens: localModelOutputTokens(model) };
}

/**
 * True when an origin is https by NAME: certificate checks need the name, so the
 * CLI cannot be handed a literal address (ADR-227 sh3); refused until the relay.
 * @param {string} origin bare registered origin
 * @returns {boolean}
 */
export function requiresTlsRelay(origin) {
  const host = new URL(origin).hostname.replace(/^\[|\]$/gu, '');
  return origin.startsWith('https:') && isIP(host) === 0;
}

/**
 * The registered origin re-addressed to a vetted IP literal (IPv6 bracketed),
 * keeping its scheme and port.
 * @param {string} origin bare registered origin
 * @param {string} address IP literal
 * @returns {string}
 */
export function literalOriginFor(origin, address) {
  const url = new URL(origin);
  url.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return url.origin;
}

/**
 * sh3 (ADR-227 Decision 5): resolves the registered host ONCE, requires every
 * answer to be private (resolvePrivate), and returns the literal the CLI will
 * connect to, so the CLI never resolves a name itself. https by name is refused
 * before any lookup: certificate checks need the name.
 * @returns {Promise<{address:string, connectOrigin:string}|LocalUnavailable>}
 */
async function vetServerAddress(d, server, origin) {
  if (requiresTlsRelay(origin)) return refuse('tls_name_requires_relay');
  let resolved;
  try {
    resolved = await d.resolvePrivate(server.baseUrl);
  } catch {
    return refuse('address_not_private');
  }
  const address = typeof resolved?.address === 'string' ? resolved.address : '';
  const family = isIP(address);
  if (family === 0 || family !== resolved.family) return refuse('address_not_private');
  return { address, connectOrigin: literalOriginFor(origin, address) };
}

/**
 * Writes the measured working env for a resolved local engine.
 * @param {NodeJS.ProcessEnv} env
 * @param {{connectOrigin:string, token:string, model:string, contextWindow:number, outputTokens:number}} input
 */
function writeLocalEnv(env, { connectOrigin, token, model, contextWindow, outputTokens }) {
  for (const key of STRIPPED_ROUTE_KEYS) delete env[key];
  env.ANTHROPIC_BASE_URL = connectOrigin;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.ANTHROPIC_API_KEY = '';
  for (const key of MODEL_ENV_KEYS) env[key] = model;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // T-2098 qa item 4, measured in the sealed namespace (claude 2.1.312 --debug):
  // plugins enabled from claude-plugins-official (managed settings) made the
  // headless plugin install `git clone` that marketplace from github.com on every
  // run, nonessential traffic off or not. Zip-cache mode skips marketplaces it
  // cannot serve, so a local run contacts its server and nothing else (0 DNS
  // queries measured); the official-marketplace auto-install is off as well.
  env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1';
  env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE = '1';
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(outputTokens);
  // The per-request billing header varies per CLI build and defeats the
  // llama.cpp prompt cache (measured cache_read 0 → full prefix with it off).
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  if (typeof env.API_TIMEOUT_MS !== 'string' || env.API_TIMEOUT_MS.trim() === '') {
    env.API_TIMEOUT_MS = LOCAL_API_TIMEOUT_MS;
  }
}

/**
 * Shape of the request: no local engine, a refusal, or the parsed model and pin.
 * T-2107 qa high 6: on a pinned chat with no explicit re-pick (`qualifyBareModel`),
 * a bare model id is kept as `bareModel` for the pinned server to qualify.
 * @returns {{status:'none'}|LocalUnavailable|{requestedModel:string, pin:object|null, bareModel:string|null}}
 */
function readLocalRequest(input) {
  const requestedModel = typeof input.requestedModel === 'string' ? input.requestedModel.trim() : '';
  const pin = input.storedPin ? parseLocalEnginePin(input.storedPin) : null;
  if (input.storedPin && !pin) return refuse('pin_conflict');
  if (!pin && !isLocalModelId(requestedModel)) return { status: 'none' };
  if (pin && requestedModel && !isLocalModelId(requestedModel)) {
    return input.qualifyBareModel === true ? { requestedModel: '', pin, bareModel: requestedModel } : refuse('pin_conflict');
  }
  return { requestedModel, pin, bareModel: null };
}

/**
 * The pinned server's full id for a bare model it lists; null otherwise.
 * @param {{providerId: string, models: Array<{id: string}>}} server
 * @param {string} bareModel
 * @returns {string|null}
 */
function qualifyOnServer(server, bareModel) {
  return server.models.some((row) => row.id === bareModel) ? `${server.providerId}/${bareModel}` : null;
}

/**
 * Locates the vetted server, model and literal address for an admitted request.
 * @returns {Promise<{local:LocalEngine, secret:unknown}|LocalUnavailable>}
 */
async function locateLocalEngine(d, userId, { requestedModel, pin, bareModel }, eligibility) {
  const chosen = selectServer(d.listServers(userId), userId, pin, requestedModel);
  if ('status' in chosen) return chosen;
  const { server } = chosen;
  const model = bareModel ? qualifyOnServer(server, bareModel) : requestedModel;
  if (model === null) return refuse('pin_conflict');
  const vetted = selectModel(server, model, eligibility);
  if ('status' in vetted) return vetted;
  const origin = localServerOrigin(server.baseUrl);
  if (origin === null) return refuse('base_url_unsupported');
  if (pin && pin.originDigest !== localOriginDigest(origin)) return refuse('origin_changed');
  const target = await vetServerAddress(d, server, origin);
  if ('status' in target) return target;
  // T-2098 qa item 2: only an address of the set the member's last connection test vetted.
  const verified = Array.isArray(server.verifiedAddresses) ? server.verifiedAddresses : [];
  if (!verified.includes(target.address)) return refuse('address_changed');
  const ownerId = Number(server.ownerId);
  const local = {
    pin: formatLocalEnginePin({ serverId: server.id, ownerId, origin }),
    serverId: server.id,
    ownerId,
    providerId: server.providerId,
    model: vetted.model.id,
    origin,
    address: target.address,
    connectOrigin: target.connectOrigin,
    contextWindow: vetted.model.contextWindow,
    outputTokens: vetted.outputTokens,
  };
  return { local, secret: d.getSecret(server.ownerId, server.id) };
}

/**
 * T-2107: the body-neutral half of a local-engine spawn, shared by the Claude and
 * Codex bodies so the vetting, the pin and the eligibility gates exist once. The
 * body supplies its dependencies (its own switch, grant rule and CLI version gate)
 * and its static model eligibility. Loads `loadDeps` only for a local request.
 * @param {{ userId: string|number, requestedModel?: string|null, storedPin?: string|null,
 *   qualifyBareModel?: boolean }} input `qualifyBareModel`: the chat is pinned and the
 *   model was not re-picked, so a bare id listed on the pinned server is that server's
 * @param {() => Promise<Record<string, Function>>} loadDeps
 * @param {(model: object) => string} eligibility
 * @returns {Promise<LocalNotRequested|LocalUnavailable|{status:'resolved', local:LocalEngine, secret:string}>}
 */
export async function resolveLocalEngine(input, loadDeps, eligibility) {
  const request = readLocalRequest(input);
  if ('status' in request) return request;
  const d = await loadDeps();
  if (!d.enabled()) return refuse('feature_disabled');
  if (!d.runnable(input.userId)) return refuse('grant_not_supported');
  // T-2098 qa item 3: credential behaviour is CLI-version dependent (ADR-227).
  if (!(await d.cliVersionProven())) return refuse('cli_version_unproven');
  const located = await locateLocalEngine(d, input.userId, request, eligibility);
  if ('status' in located) return located;
  const { secret } = located;
  if (typeof secret === 'string' && /[\r\n]/u.test(secret)) return refuse('key_invalid');
  return { status: 'resolved', local: located.local, secret: typeof secret === 'string' ? secret : '' };
}

/**
 * Decides — without throwing — whether this spawn runs on a local server, and
 * applies the env when it can be honoured. `env` is mutated only on `applied`.
 *
 * @param {NodeJS.ProcessEnv} env spawn env to mutate IN PLACE (already cloned)
 * @param {{ userId: string|number, requestedModel?: string|null, storedPin?: string|null }} input
 *   `storedPin` is the session's local pin (or null for a new session)
 * @param {Record<string, Function>} [deps] test seam (enabled, runnable, listServers,
 *   getSecret, resolvePrivate, cliVersionProven)
 * @returns {Promise<LocalEngineVerdict>}
 */
export async function applyClaudeLocalEngineEnv(env, input, deps = {}) {
  const resolved = await resolveLocalEngine(input, () => resolveDeps(deps), claudeLocalModelEligibility);
  if (resolved.status !== 'resolved') return resolved;
  const { local } = resolved;
  writeLocalEnv(env, { ...local, token: resolved.secret || LOCAL_NO_KEY_PLACEHOLDER });
  return {
    status: 'applied',
    provider: LOCAL_ENGINE,
    hosts: new Set(),
    origins: new Set([normalizeAuthorizedOrigin(local.connectOrigin)]),
    local,
  };
}

/** User-facing detail per refusal reason; never names a key or an address. */
const REASON_DETAIL = Object.freeze({
  feature_disabled: 'Claude Code on local model servers is turned off on this installation.',
  grant_not_supported: 'Local model servers cannot be used under a shared credential yet.',
  server_not_found: 'The local model server this chat uses is not registered to your account.',
  owner_mismatch: 'This chat runs on a local model server that belongs to another member.',
  origin_changed: "The local model server's address changed after this chat started.",
  model_not_found: 'The requested model is not listed on that local model server.',
  model_id_reserved: 'A local model id may not start with "claude-".',
  context_unknown: "The model's context window is unknown; set it in the server settings.",
  context_too_small: `The model's context window is smaller than Claude Code needs `
    + `(${minimumClaudeLocalContextWindow(CLAUDE_LOCAL_OUTPUT_CAP_TOKENS)} tokens).`,
  address_not_private: 'The server does not resolve to a private address (loopback, LAN or tailnet).',
  base_url_unsupported: 'The server address must be a bare origin, optionally ending in /v1.',
  cli_version_unproven: 'The installed Claude Code version has not passed the local-server credential proof yet.',
  address_changed: 'The server now answers on a different address than the last connection test; test the connection again.',
  tls_name_requires_relay: 'An https server must be registered by its IP address; https by host name is not supported yet.',
  pin_conflict: 'This chat is pinned to a different engine than the one requested.',
  key_invalid: "The server's stored key is malformed.",
});

/**
 * Typed refusal, same code as a vendor engine that cannot be honoured.
 * @param {LocalUnavailable} verdict
 * @param {Readonly<Record<string, string>>} [bodyDetail] body-specific wording that
 *   replaces the Claude text for some reasons (T-2107)
 * @returns {Error & {code:string, engineProvider:string, reason:string}}
 */
export function localEngineUnavailableError(verdict, bodyDetail = {}) {
  const detail = bodyDetail[verdict.reason] ?? REASON_DETAIL[verdict.reason] ?? 'The local model server cannot be used.';
  const error = new Error(
    `تعذّر تشغيل المحادثة على خادم النموذج المحلي، ولم تُشغَّل على أي مزوّد آخر. Refusing to run elsewhere. ${detail}`,
  );
  return Object.assign(error, {
    code: 'ENGINE_PROVIDER_UNAVAILABLE', engineProvider: LOCAL_ENGINE, reason: verdict.reason,
  });
}

/**
 * Call-site helper: applies the local env or throws ENGINE_PROVIDER_UNAVAILABLE.
 * Returns null when no local engine was requested.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ userId: string|number, requestedModel?: string|null, storedPin?: string|null }} input
 * @param {Record<string, Function>} [deps]
 * @returns {Promise<{engineHosts:Set<string>, engineOrigins:Set<string>, local:LocalEngine}|null>}
 */
export async function applyClaudeLocalEngineEnvOrThrow(env, input, deps = {}) {
  const verdict = await applyClaudeLocalEngineEnv(env, input, deps);
  if (verdict.status === 'unavailable') throw localEngineUnavailableError(verdict);
  if (verdict.status === 'none') return null;
  return { engineHosts: verdict.hosts, engineOrigins: verdict.origins, local: verdict.local };
}

/**
 * ADR-227: does this spawn take the local-engine path? Only a session already
 * pinned to a local server, or a BRAND-NEW session that names a local model.
 * A local model on any other existing session (official, vendor, cloud or unknown
 * pin) is refused — `local` is never inferred, and a cloud chat never moves to a
 * local server (nor a local chat to the cloud: the local resolver refuses a
 * non-local model on a local pin). Shared by the Claude and Codex bodies (T-2107).
 * @param {{sessionId?: string|null, storedEngine?: string|null, requestedModel?: string|null,
 *   clientEngine?: string|null}} input
 * @returns {boolean}
 * @throws {Error} ENGINE_PROVIDER_UNAVAILABLE (pin_conflict)
 */
export function takesLocalEnginePath({ sessionId = null, storedEngine = null, requestedModel = null, clientEngine = null }) {
  const localPinned = parseLocalEnginePin(storedEngine) !== null;
  const localRequested = isLocalModelId(requestedModel);
  if (!localPinned && !localRequested) return false;
  const conflictingClient = typeof clientEngine === 'string' && clientEngine.trim() !== ''
    && !isLocalEngineValue(clientEngine.trim());
  if (!localPinned && (sessionId || conflictingClient)) {
    throw localEngineUnavailableError(refuse('pin_conflict'));
  }
  return true;
}
