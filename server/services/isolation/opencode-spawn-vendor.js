/**
 * opencode-spawn-vendor (ADR-200 S8) — Moonshot and DeepSeek carried by OpenCode
 * as spawn-time OpenAI-compatible providers. Behind its own fleet flag
 * NASSAJ_OPENCODE_SPAWN_VENDORS (default OFF, B-1575) AND the unified vendor-key
 * flag: while either is off nothing here is reached, so a `moonshot/*` or
 * `deepseek/*` model keeps the legacy opencode path byte for byte.
 *
 * Routing (B-1551 M2): the provider part of the id is matched without case
 * against `moonshot`, `deepseek` and opencode's built-in models.dev ids
 * (`moonshotai`, `moonshotai-cn`), then rewritten to the canonical id, so no
 * spelling of these vendors reaches the supervised cell or the legacy path.
 *
 * The rules (ADR-200 §4), all fail-closed:
 *   • the key is the SENDER's own slot (`kimi` / `deepseek`) — never a credential
 *     grant, never the operator-wide slot. No key → `missing_key`;
 *   • only the selected model's vendor key reaches the child, as
 *     NASSAJ_MOONSHOT_API_KEY or NASSAJ_DEEPSEEK_API_KEY, set after env
 *     sanitization; both names are host secrets everywhere else;
 *   • the provider block names the key by `{env:…}`, so the config text never
 *     holds the literal key;
 *   • base URLs are code constants on the OpenAI wire (never env, never user
 *     config). No ANTHROPIC_* variable is set: the iron rule is untouched;
 *   • a Claude subscription token is refused again at injection (L2).
 *
 * Residual risk (ADR-062 note): opencode's bash tool inherits the child env, so
 * a prompt-injected model can read the key. Rotation is the remedy.
 */

import { isClaudeSubscriptionToken } from '../../../shared/claudeSubscriptionToken.js';

import { isUnifiedVendorKeysEnabled } from './provider-secrets-store.js';

/** Fleet flag of the OpenCode spawn-time vendor cells (Moonshot, DeepSeek). Default OFF. */
export const SPAWN_VENDORS_FLAG = 'NASSAJ_OPENCODE_SPAWN_VENDORS';

/**
 * B-1575: the spawn-time vendor cells are armed only when
 * NASSAJ_OPENCODE_SPAWN_VENDORS is set to `1/true/yes/on` (unset or any other
 * value is off, like NASSAJ_OPENCODE_QWEN_PLAN) AND unified vendor keys are on.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isOpencodeSpawnVendorsEnabled(env = process.env) {
  const raw = env?.[SPAWN_VENDORS_FLAG];
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  const on = normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  return on && isUnifiedVendorKeysEnabled(env);
}

/** Moonshot's OpenAI-compatible endpoint (same host as the engine pin). */
export const MOONSHOT_OPENCODE_BASE_URL = 'https://api.moonshot.ai/v1';

/**
 * Moonshot's mainland-China OpenAI-compatible endpoint: the host of the
 * models.dev `moonshotai-cn` provider (ADR-200 S8, B-1551 M2). Same vendor and
 * the same sender slot (`kimi`); the member chose this region by picking the id.
 */
export const MOONSHOT_CN_OPENCODE_BASE_URL = 'https://api.moonshot.cn/v1';

/** DeepSeek's OpenAI-compatible endpoint (same host as the engine pin). */
export const DEEPSEEK_OPENCODE_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * Model ids MIRROR KIMI_FALLBACK_MODELS / DEEPSEEK_FALLBACK_MODELS in
 * modules/providers/shared/vendor/vendor-config.ts (measured on the vendors'
 * `/v1/models`). A drift test pins the two; the isolation layer may not import
 * a modules/* internal path.
 */
const MOONSHOT_MODELS = [
  { value: 'kimi-k2.6', label: 'Kimi K2.6' },
  { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { value: 'kimi-k3', label: 'Kimi K3' },
];
const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];

/**
 * @typedef {{
 *   id: 'moonshot'|'moonshot-cn'|'deepseek',
 *   providerId: string,
 *   prefix: string,
 *   aliases: ReadonlyArray<string>,
 *   offered: boolean,
 *   slot: 'kimi'|'deepseek',
 *   keyEnv: string,
 *   baseUrl: string,
 *   label: string,
 *   models: ReadonlyArray<{ value: string, label: string }>,
 * }} SpawnVendor
 */

/**
 * `aliases` are the other provider ids that name the same vendor and region —
 * opencode's built-in models.dev ids — matched case-insensitively and rewritten
 * to `providerId` (B-1551 M2). `offered: false` keeps a row out of the picker
 * while still routing (and guarding) an id that names it.
 * @param {Omit<SpawnVendor, 'prefix'|'models'|'aliases'|'offered'> & {
 *   models: Array<{ value: string, label: string }>, aliases?: string[], offered?: boolean,
 * }} row
 */
function vendor(row) {
  return Object.freeze({
    ...row,
    prefix: `${row.providerId}/`,
    aliases: Object.freeze([...(row.aliases ?? [])]),
    offered: row.offered !== false,
    models: Object.freeze(row.models.map((model) => Object.freeze(model))),
  });
}

/** @type {Readonly<Record<'moonshot'|'moonshot-cn'|'deepseek', SpawnVendor>>} */
export const OPENCODE_SPAWN_VENDORS = Object.freeze({
  moonshot: vendor({
    id: 'moonshot',
    providerId: 'moonshot',
    aliases: ['moonshotai'],
    slot: 'kimi',
    keyEnv: 'NASSAJ_MOONSHOT_API_KEY',
    baseUrl: MOONSHOT_OPENCODE_BASE_URL,
    label: 'Moonshot',
    models: MOONSHOT_MODELS,
  }),
  // Routed, never offered: the `kimi` slot records no region, so the picker
  // lists the international endpoint only. An explicit `moonshotai-cn/*` id
  // still runs guarded, on its own constant host, with the sender's key.
  'moonshot-cn': vendor({
    id: 'moonshot-cn',
    providerId: 'moonshot-cn',
    aliases: ['moonshotai-cn'],
    offered: false,
    slot: 'kimi',
    keyEnv: 'NASSAJ_MOONSHOT_API_KEY',
    baseUrl: MOONSHOT_CN_OPENCODE_BASE_URL,
    label: 'Moonshot China',
    models: MOONSHOT_MODELS,
  }),
  deepseek: vendor({
    id: 'deepseek',
    providerId: 'deepseek',
    slot: 'deepseek',
    keyEnv: 'NASSAJ_DEEPSEEK_API_KEY',
    baseUrl: DEEPSEEK_OPENCODE_BASE_URL,
    label: 'DeepSeek',
    models: DEEPSEEK_MODELS,
  }),
});

/** Every key variable a spawn vendor may set; host secrets for every other run. */
export const OPENCODE_SPAWN_VENDOR_KEY_ENVS = Object.freeze(
  [...new Set(Object.values(OPENCODE_SPAWN_VENDORS).map((row) => row.keyEnv))],
);

/** Longest audit `model` value kept for an id outside the vendor catalog. */
const AUDIT_MODEL_MAX = 128;

/** Refusal codes (fixed, non-secret strings). */
export const SPAWN_VENDOR_REFUSAL = Object.freeze({
  MISSING_KEY: 'missing_key',
  SUBSCRIPTION_TOKEN: 'subscription_token_refused',
  SESSION_ON_GRANT_TREE: 'session_on_grant_tree',
});

/**
 * B-1551 M1: a spawn-vendor turn runs on the SENDER's own opencode data dir,
 * so it cannot resume a conversation stored only in the grantor's data dir
 * (opencode would answer "session not found"). Refused before spawn instead.
 * @param {string} label vendor label (non-secret)
 * @returns {Error}
 */
export function sessionOnGrantTreeRefusal(label) {
  return refusal(
    SPAWN_VENDOR_REFUSAL.SESSION_ON_GRANT_TREE,
    `This conversation is stored in the granting member's data; ${label} runs on your own data.`,
  );
}

/**
 * Splits `provider/model` and finds the vendor whose id or alias equals the
 * provider part, ignoring case (`Moonshot/`, `DEEPSEEK/`, `moonshotai/` …).
 * @param {unknown} model
 * @returns {{ row: SpawnVendor, rest: string }|null}
 */
function matchSpawnVendor(model) {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return null;
  const provider = trimmed.slice(0, slash).toLowerCase();
  const row = Object.values(OPENCODE_SPAWN_VENDORS)
    .find((candidate) => candidate.providerId === provider || candidate.aliases.includes(provider));
  return row ? { row, rest: trimmed.slice(slash + 1) } : null;
}

/**
 * The spawn vendor a model id belongs to — regardless of the flag. The provider
 * part is matched case-insensitively against each vendor id and its aliases.
 * @param {unknown} model
 * @returns {SpawnVendor|null}
 */
export function spawnVendorOfModel(model) {
  return matchSpawnVendor(model)?.row ?? null;
}

/**
 * The id opencode is launched with: the canonical provider id (the inline
 * block's key) and, when the model part names a catalog model in any case, its
 * catalog spelling. Any other model part is kept as given. A non-vendor id is
 * returned unchanged.
 * @param {string} model
 * @returns {string}
 */
export function canonicalSpawnVendorModel(model) {
  const match = matchSpawnVendor(model);
  if (!match) return model;
  const known = match.row.models.find((entry) => entry.value.toLowerCase() === match.rest.toLowerCase());
  return `${match.row.prefix}${known ? known.value : match.rest}`;
}

/**
 * The `model` field of a spawn-vendor audit row: the canonical id when it is in
 * the vendor catalog, else the given id trimmed to 128 characters (B-1551 item 6).
 * @param {unknown} model
 * @returns {string}
 */
export function spawnVendorAuditModel(model) {
  const text = typeof model === 'string' ? model.trim() : '';
  const match = matchSpawnVendor(text);
  const canonical = match ? canonicalSpawnVendorModel(text) : '';
  const known = match?.row.models.some((entry) => canonical === `${match.row.prefix}${entry.value}`);
  return known ? canonical : text.slice(0, AUDIT_MODEL_MAX);
}

/**
 * The spawn vendor of this turn: a matching prefix AND the spawn-vendor flag
 * armed (isOpencodeSpawnVendorsEnabled; the default-ON unified flag alone does
 * not arm this T-unverified cell). Otherwise null: the legacy path is unchanged.
 * @param {unknown} model
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SpawnVendor|null}
 */
export function spawnVendorRunOf(model, env = process.env) {
  return isOpencodeSpawnVendorsEnabled(env) ? spawnVendorOfModel(model) : null;
}

function refusal(code, message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/**
 * Decides a spawn-vendor launch and returns the SENDER's key. `getOwnKey` must
 * read the sender's own slot only (no grant, no shared fallback). The key is
 * never in a message.
 *
 * @param {{
 *   vendor: SpawnVendor,
 *   userId: string|number|null|undefined,
 *   getOwnKey: (userId: string|number, slot: 'kimi'|'deepseek') => string|null|undefined,
 * }} input
 * @returns {{ key: string }}
 * @throws {Error} with a SPAWN_VENDOR_REFUSAL code
 */
export function authorizeSpawnVendorLaunch({ vendor: row, userId, getOwnKey }) {
  if (userId === null || userId === undefined || userId === '') {
    throw refusal(SPAWN_VENDOR_REFUSAL.MISSING_KEY, `${row.label} requires a signed-in member key.`);
  }
  const raw = getOwnKey(userId, row.slot);
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key === '') {
    throw refusal(SPAWN_VENDOR_REFUSAL.MISSING_KEY, `No personal ${row.label} key is saved.`);
  }
  if (isClaudeSubscriptionToken(key)) {
    throw refusal(SPAWN_VENDOR_REFUSAL.SUBSCRIPTION_TOKEN, `The saved ${row.label} key is not a ${row.label} key.`);
  }
  return { key };
}

/**
 * The inline opencode config for one vendor's turn. The key is referenced by
 * `{env:…}`; the literal key is never part of this text.
 * @param {SpawnVendor} row
 * @returns {string}
 */
export function buildSpawnVendorConfigContent(row) {
  const models = Object.fromEntries(row.models.map((model) => [model.value, { name: model.label }]));
  return JSON.stringify({
    share: 'disabled',
    autoupdate: false,
    provider: {
      [row.providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: row.label,
        options: { baseURL: row.baseUrl, apiKey: `{env:${row.keyEnv}}` },
        models,
      },
    },
  });
}

/**
 * The GL-3 allowlist entry of this turn only: providerId → its constant origin.
 * @param {SpawnVendor} row
 * @returns {Record<string, string>}
 */
export function spawnVendorOrigins(row) {
  return { [row.providerId]: row.baseUrl };
}

/**
 * Returns a NEW env with this vendor's key and inline config set. Call ONLY
 * after sanitizeVendorAgentEnv. Every other spawn-vendor key variable is
 * removed, so only the selected vendor's key is ever in the child env.
 * @param {NodeJS.ProcessEnv} env sanitized child env
 * @param {SpawnVendor} row
 * @param {string} key the sender's key
 * @returns {NodeJS.ProcessEnv}
 */
export function withSpawnVendorEnv(env, row, key) {
  const next = { ...env };
  for (const name of OPENCODE_SPAWN_VENDOR_KEY_ENVS) delete next[name];
  next[row.keyEnv] = key;
  next.OPENCODE_CONFIG_CONTENT = buildSpawnVendorConfigContent(row);
  return next;
}
