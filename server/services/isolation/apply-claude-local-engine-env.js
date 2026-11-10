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
 * `maxOutput`, never below the floor.
 * @param {{maxOutput?: unknown}} model
 * @returns {number}
 */
function claudeLocalOutputTokens(model) {
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
  if (window < minimumClaudeLocalContextWindow(claudeLocalOutputTokens(model))) return 'context_too_small';
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
 * Picks and vets the model on the server.
 * @returns {{model:object, outputTokens:number}|LocalUnavailable}
 */
function selectModel(server, requestedModel) {
  if (requestedModel && !requestedModel.startsWith(`${server.providerId}/`)) return refuse('pin_conflict');
  const id = requestedModel ? requestedModel.slice(server.providerId.length + 1) : server.models[0]?.id;
  const model = server.models.find((row) => row.id === id);
  if (!model) return refuse('model_not_found');
  if (/^claude-/iu.test(model.id)) return refuse('model_id_reserved');
  if (isUnusableLocalModelId(model.id)) return refuse('model_not_found');
  const eligibility = claudeLocalModelEligibility(model);
  if (eligibility !== 'ok') return refuse(eligibility);
  return { model, outputTokens: claudeLocalOutputTokens(model) };
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
  const requestedModel = typeof input.requestedModel === 'string' ? input.requestedModel.trim() : '';
  const pin = input.storedPin ? parseLocalEnginePin(input.storedPin) : null;
  if (input.storedPin && !pin) return refuse('pin_conflict');
  if (!pin && !isLocalModelId(requestedModel)) return { status: 'none' };
  if (pin && requestedModel && !isLocalModelId(requestedModel)) return refuse('pin_conflict');
  const d = await resolveDeps(deps);

  if (!d.enabled()) return refuse('feature_disabled');
  if (!d.runnable(input.userId)) return refuse('grant_not_supported');
  // T-2098 qa item 3: credential behaviour is CLI-version dependent (ADR-227).
  if (!(await d.cliVersionProven())) return refuse('cli_version_unproven');

  const chosen = selectServer(d.listServers(input.userId), input.userId, pin, requestedModel);
  if ('status' in chosen) return chosen;
  const { server } = chosen;
  const vetted = selectModel(server, requestedModel);
  if ('status' in vetted) return vetted;

  const origin = localServerOrigin(server.baseUrl);
  if (origin === null) return refuse('base_url_unsupported');
  if (pin && pin.originDigest !== localOriginDigest(origin)) return refuse('origin_changed');
  const target = await vetServerAddress(d, server, origin);
  if ('status' in target) return target;
  // T-2098 qa item 2: only an address of the set the member's last connection test vetted.
  const verified = Array.isArray(server.verifiedAddresses) ? server.verifiedAddresses : [];
  if (!verified.includes(target.address)) return refuse('address_changed');

  const secret = d.getSecret(server.ownerId, server.id);
  if (typeof secret === 'string' && /[\r\n]/u.test(secret)) return refuse('key_invalid');
  const local = {
    pin: formatLocalEnginePin({ serverId: server.id, ownerId: Number(server.ownerId), origin }),
    serverId: server.id,
    ownerId: Number(server.ownerId),
    providerId: server.providerId,
    model: vetted.model.id,
    origin,
    address: target.address,
    connectOrigin: target.connectOrigin,
    contextWindow: vetted.model.contextWindow,
    outputTokens: vetted.outputTokens,
  };
  writeLocalEnv(env, { ...local, token: secret || LOCAL_NO_KEY_PLACEHOLDER });
  return {
    status: 'applied',
    provider: LOCAL_ENGINE,
    hosts: new Set(),
    origins: new Set([normalizeAuthorizedOrigin(target.connectOrigin)]),
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
 * @returns {Error & {code:string, engineProvider:string, reason:string}}
 */
export function localEngineUnavailableError(verdict) {
  const detail = REASON_DETAIL[verdict.reason] ?? 'The local model server cannot be used.';
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
