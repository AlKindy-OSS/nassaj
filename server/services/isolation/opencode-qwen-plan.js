/**
 * opencode-qwen-plan (T-1906) — the Alibaba Qwen Coding Plan carried by OpenCode.
 *
 * A `qwen-plan/<model>` turn runs the pinned opencode binary against the
 * Coding Plan OpenAI-compatible endpoint with the SENDER's personal `sk-sp-*`
 * key. Vendor terms bind the key: personal, interactive use only, no sharing.
 * So every rule below is fail-closed:
 *   • the fleet flag NASSAJ_OPENCODE_QWEN_PLAN must be armed (default OFF);
 *   • the turn must carry the SERVER-set interactive marker (never client-set);
 *   • the key is read from the sender's own slot — never a credential grant;
 *   • only a coding_plan / international profile is compatible;
 *   • the key reaches the child ONLY as NASSAJ_QWEN_PLAN_API_KEY, set after
 *     env sanitization, and the provider block names it by `{env:…}` so the
 *     config text never holds the literal key;
 *   • the base URL is a code constant, never read from env or user config.
 *
 * Residual risk (ADR-062 note): opencode's bash tool inherits the child env,
 * so a prompt-injected model can read and exfiltrate the key. It is mitigated
 * only by disclosure at key entry and by revocation at the vendor console.
 */

/** Fleet flag gating qwen-plan turns. Default OFF. */
export const QWEN_PLAN_FLAG = 'NASSAJ_OPENCODE_QWEN_PLAN';

/** OpenCode provider id the Coding Plan is carried under: models read `qwen-plan/<id>`. */
export const QWEN_PLAN_PROVIDER_ID = 'qwen-plan';
export const QWEN_PLAN_MODEL_PREFIX = `${QWEN_PLAN_PROVIDER_ID}/`;

/** Coding Plan international endpoint (OpenAI wire). Constant — never from env. */
export const QWEN_PLAN_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';

/** The ONLY variable that carries the key into the child. */
export const QWEN_PLAN_KEY_ENV = 'NASSAJ_QWEN_PLAN_API_KEY';

/**
 * Coding Plan models. MIRRORS QWEN_CODING_PLAN_MODELS in
 * modules/providers/list/qwen/qwen.provider.ts — a drift test pins the two.
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
export const QWEN_PLAN_MODELS = Object.freeze([
  { value: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
  { value: 'qwen3-coder-next', label: 'Qwen3 Coder Next' },
  { value: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
  { value: 'qwen3.6-plus', label: 'Qwen3.6 Plus' },
  { value: 'qwen3.5-plus', label: 'Qwen3.5 Plus' },
  { value: 'qwen3-max-2026-01-23', label: 'Qwen3 Max' },
  { value: 'glm-5', label: 'GLM-5' },
  { value: 'glm-4.7', label: 'GLM-4.7' },
  { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
].map((model) => Object.freeze(model)));

/** Refusal codes a qwen-plan launch can end with (fixed, non-secret strings). */
export const QWEN_PLAN_REFUSAL = Object.freeze({
  DISABLED: 'qwen_plan_disabled',
  NOT_INTERACTIVE: 'qwen_plan_not_interactive',
  MISSING_KEY: 'missing_key',
  INCOMPATIBLE_PROFILE: 'incompatible_profile',
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
 * Whether a saved Qwen profile can drive the qwen-plan provider block.
 * @param {{ plan?: string, region?: string, key?: string } | null | undefined} profile
 * @returns {'ok'|'missing_key'|'incompatible_profile'}
 */
export function qwenPlanProfileVerdict(profile) {
  if (!profile || typeof profile.key !== 'string' || profile.key === '') return QWEN_PLAN_REFUSAL.MISSING_KEY;
  if (profile.plan !== 'coding_plan' || profile.region !== 'international') {
    return QWEN_PLAN_REFUSAL.INCOMPATIBLE_PROFILE;
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
 *   interactiveVerified: unknown,
 *   env?: NodeJS.ProcessEnv,
 *   getProfile: (userId: string|number) => { plan: string, region: string, key: string } | null,
 * }} input
 * @returns {{ key: string }}
 */
export function authorizeQwenPlanLaunch(input) {
  if (!isQwenPlanEnabled(input.env ?? process.env)) {
    throw refusal(QWEN_PLAN_REFUSAL.DISABLED, 'Qwen Coding Plan through OpenCode is not enabled.');
  }
  if (input.interactiveVerified !== true) {
    throw refusal(QWEN_PLAN_REFUSAL.NOT_INTERACTIVE, 'Qwen Coding Plan turns must be sent interactively by the key owner.');
  }
  const userId = input.userId;
  if (userId === null || userId === undefined || userId === '') {
    throw refusal(QWEN_PLAN_REFUSAL.MISSING_KEY, 'Qwen Coding Plan requires a signed-in member key.');
  }
  const profile = input.getProfile(userId);
  const verdict = qwenPlanProfileVerdict(profile);
  if (verdict !== 'ok') {
    throw refusal(verdict, verdict === QWEN_PLAN_REFUSAL.MISSING_KEY
      ? 'No personal Qwen Coding Plan key is saved.'
      : 'The saved Qwen key is not an international Coding Plan key.');
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
 * @param {string} key the sender's Coding Plan key
 * @returns {NodeJS.ProcessEnv}
 */
export function withQwenPlanEnv(env, key) {
  return { ...env, [QWEN_PLAN_KEY_ENV]: key, OPENCODE_CONFIG_CONTENT: buildQwenPlanConfigContent() };
}

const REDACTED = '[REDACTED]';
// Coding Plan keys are `sk-sp-` + [A-Za-z0-9._-] (isQwenCodingPlanKey). The
// pattern catches ANY member's key in stored history, where the reader does
// not know whose key it might be; the literal covers the live run's own key.
const CODING_PLAN_KEY_PATTERN = /sk-sp-[A-Za-z0-9._-]{6,}/g;

/**
 * THE redaction function for Coding Plan keys: removes the literal `secret`
 * (when given) and every `sk-sp-…` token. Non-strings pass through unchanged.
 * @template T
 * @param {T} text
 * @param {string|null} [secret]
 * @returns {T}
 */
export function redactQwenPlanSecrets(text, secret = null) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  if (typeof secret === 'string' && secret.length > 0 && out.includes(secret)) {
    out = out.split(secret).join(REDACTED);
  }
  return /** @type {T} */ (out.replace(CODING_PLAN_KEY_PATTERN, REDACTED));
}

/**
 * Line assembler for a child stream: buffers partial chunks and hands back only
 * complete, redacted lines, so a key split across two chunks is still caught.
 * @param {string|null} secret
 * @returns {{ push(chunk: string): string[], flush(): string[] }}
 */
export function createRedactingLineAssembler(secret) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      return lines.map((line) => redactQwenPlanSecrets(line, secret));
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest === '' ? [] : [redactQwenPlanSecrets(rest, secret)];
    },
  };
}
