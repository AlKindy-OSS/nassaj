/**
 * opencode-qwen-plan (T-1906, ADR-200 S7) — the Alibaba Token Plan carried by OpenCode.
 *
 * A `qwen-plan/<model>` turn runs the pinned opencode binary against the
 * Token Plan OpenAI-compatible endpoint (international region only, D4) with
 * the SENDER's own key. ADR-200 D3/D9 removed the Coding Plan, its consent,
 * its `sk-sp-` rule and the interactive-only guard: automation, resume and
 * API-key turns may spend the key. The rules that stay are fail-closed:
 *   • the fleet flag NASSAJ_OPENCODE_QWEN_PLAN is the kill switch;
 *   • the key is read from the sender's own slot — never a credential grant;
 *   • only a token_plan / international profile is usable; a stored legacy
 *     coding_plan profile reports `legacy_profile` and is never deleted silently;
 *   • the key reaches the child ONLY as NASSAJ_QWEN_PLAN_API_KEY, set after
 *     env sanitization, and the provider block names it by `{env:…}` so the
 *     config text never holds the literal key;
 *   • the base URL is a code constant, never read from env or user config.
 *
 * Residual risk (ADR-062 note): opencode's bash tool inherits the child env,
 * so a prompt-injected model can read and exfiltrate the key. Rotation at the
 * vendor console is the remedy; redaction cannot recall a key already seen.
 */

/** Fleet flag gating qwen-plan turns. Default OFF. */
export const QWEN_PLAN_FLAG = 'NASSAJ_OPENCODE_QWEN_PLAN';

/** OpenCode provider id the Token Plan is carried under: models read `qwen-plan/<id>`. */
export const QWEN_PLAN_PROVIDER_ID = 'qwen-plan';
export const QWEN_PLAN_MODEL_PREFIX = `${QWEN_PLAN_PROVIDER_ID}/`;

/**
 * Token Plan international endpoint (OpenAI wire, D4). Constant — never from
 * env. Same value as the token_plan/international entry of qwen-cli.js.
 */
export const QWEN_PLAN_BASE_URL = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

/** The ONLY variable that carries the key into the child. */
export const QWEN_PLAN_KEY_ENV = 'NASSAJ_QWEN_PLAN_API_KEY';

/**
 * Token Plan models. MIRRORS QWEN_TOKEN_PLAN_MODELS in
 * modules/providers/list/qwen/qwen.provider.ts — a drift test pins the two.
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
export const QWEN_PLAN_MODELS = Object.freeze([
  { value: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
  { value: 'qwen3.6-plus', label: 'Qwen3.6 Plus' },
  { value: 'qwen3.7-max', label: 'Qwen3.7 Max' },
  { value: 'qwen3.8-max-preview', label: 'Qwen3.8 Max Preview' },
  { value: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash' },
  { value: 'deepseek-v3.2', label: 'DeepSeek V3.2' },
  { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { value: 'kimi-k2.6', label: 'Kimi K2.6' },
  { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'glm-5.1', label: 'GLM-5.1' },
  { value: 'glm-5', label: 'GLM-5' },
  { value: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
].map((model) => Object.freeze(model)));

/** Refusal codes a qwen-plan launch can end with (fixed, non-secret strings). */
export const QWEN_PLAN_REFUSAL = Object.freeze({
  DISABLED: 'qwen_plan_disabled',
  MISSING_KEY: 'missing_key',
  LEGACY_PROFILE: 'legacy_profile',
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} whether the qwen-plan flag is armed
 */
export function isQwenPlanEnabled(env = process.env) {
  const raw = env?.[QWEN_PLAN_FLAG];
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * @param {unknown} model
 * @returns {boolean} true for a `qwen-plan/<id>` model id
 */
export function isQwenPlanModel(model) {
  return typeof model === 'string' && model.trim().startsWith(QWEN_PLAN_MODEL_PREFIX);
}

/**
 * Whether a saved Qwen profile can drive the qwen-plan provider block. Any
 * stored profile other than token_plan / international (a Coding Plan record,
 * or a Token Plan record saved for the china region before D4) is a legacy
 * profile: it is reported, never used, and never deleted silently.
 * @param {{ plan?: string, region?: string, key?: string } | null | undefined} profile
 * @returns {'ok'|'missing_key'|'legacy_profile'}
 */
export function qwenPlanProfileVerdict(profile) {
  if (!profile || typeof profile.key !== 'string' || profile.key === '') return QWEN_PLAN_REFUSAL.MISSING_KEY;
  if (profile.plan !== 'token_plan' || profile.region !== 'international') {
    return QWEN_PLAN_REFUSAL.LEGACY_PROFILE;
  }
  return 'ok';
}

function refusal(code, message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/**
 * Decides a qwen-plan launch and returns the sender's key. Throws an Error with
 * a QWEN_PLAN_REFUSAL code on any failed rule. The key is never in a message.
 *
 * @param {{
 *   userId: string|number|null|undefined,
 *   env?: NodeJS.ProcessEnv,
 *   getProfile: (userId: string|number) => { plan: string, region: string, key: string } | null,
 * }} input
 * @returns {{ key: string }}
 */
export function authorizeQwenPlanLaunch(input) {
  if (!isQwenPlanEnabled(input.env ?? process.env)) {
    throw refusal(QWEN_PLAN_REFUSAL.DISABLED, 'Alibaba Token Plan through OpenCode is not enabled.');
  }
  const userId = input.userId;
  if (userId === null || userId === undefined || userId === '') {
    throw refusal(QWEN_PLAN_REFUSAL.MISSING_KEY, 'Alibaba Token Plan requires a signed-in member key.');
  }
  const profile = input.getProfile(userId);
  const verdict = qwenPlanProfileVerdict(profile);
  if (verdict !== 'ok') {
    throw refusal(verdict, verdict === QWEN_PLAN_REFUSAL.MISSING_KEY
      ? 'No personal Alibaba Token Plan key is saved.'
      : 'The saved Qwen key is a legacy profile; delete it and save a Token Plan key.');
  }
  return { key: /** @type {{ key: string }} */ (profile).key };
}

/**
 * The inline opencode config for a qwen-plan turn. The key is referenced by
 * `{env:…}`; the literal key is never part of this text.
 * @returns {string}
 */
export function buildQwenPlanConfigContent() {
  const models = Object.fromEntries(QWEN_PLAN_MODELS.map((model) => [model.value, { name: model.label }]));
  return JSON.stringify({
    share: 'disabled',
    autoupdate: false,
    provider: {
      [QWEN_PLAN_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: QWEN_PLAN_BASE_URL,
          apiKey: `{env:${QWEN_PLAN_KEY_ENV}}`,
        },
        models,
      },
    },
  });
}

/**
 * Returns a NEW env with the key and inline config set. Call ONLY after
 * sanitizeVendorAgentEnv — the sanitizer would otherwise be the last word.
 * @param {NodeJS.ProcessEnv} env sanitized child env
 * @param {string} key the sender's Token Plan key
 * @returns {NodeJS.ProcessEnv}
 */
export function withQwenPlanEnv(env, key) {
  return { ...env, [QWEN_PLAN_KEY_ENV]: key, OPENCODE_CONFIG_CONTENT: buildQwenPlanConfigContent() };
}

const REDACTED = '[REDACTED]';
/** Shorter literals are not treated as secrets: replacing them would shred text. */
const MIN_LITERAL_SECRET_LENGTH = 8;
// Legacy Coding Plan keys are `sk-sp-` + [A-Za-z0-9._-]. Kept as a SECOND layer
// (ADR-200 §8): it catches such a key in stored history even when no reader
// knows whose key it was. The literal list is the first layer.
const CODING_PLAN_KEY_PATTERN = /sk-sp-[A-Za-z0-9._-]{6,}/g;

/**
 * Keeps only usable literal secrets, longest first so a key that contains
 * another key is replaced whole.
 * @param {ReadonlyArray<unknown>|null|undefined} secrets
 * @returns {string[]}
 */
function usableSecrets(secrets) {
  if (!Array.isArray(secrets)) return [];
  const unique = new Set(secrets.filter((secret) => typeof secret === 'string'
    && secret.length >= MIN_LITERAL_SECRET_LENGTH));
  return [...unique].sort((left, right) => right.length - left.length);
}

/**
 * THE redaction function for vendor keys in OpenCode text (ADR-200 §8):
 * removes every literal in `secrets` and every `sk-sp-…` token. Non-strings
 * pass through unchanged.
 * @template T
 * @param {T} text
 * @param {ReadonlyArray<unknown>|null} [secrets]
 * @returns {T}
 */
export function redactLiteralSecrets(text, secrets = null) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const secret of usableSecrets(secrets)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return /** @type {T} */ (out.replace(CODING_PLAN_KEY_PATTERN, REDACTED));
}

/**
 * Line assembler for a child stream: buffers partial chunks and hands back only
 * complete, redacted lines, so a key split across two chunks is still caught.
 * @param {ReadonlyArray<unknown>|null} secrets
 * @returns {{ push(chunk: string): string[], flush(): string[] }}
 */
export function createRedactingLineAssembler(secrets) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      return lines.map((line) => redactLiteralSecrets(line, secrets));
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest === '' ? [] : [redactLiteralSecrets(rest, secrets)];
    },
  };
}
