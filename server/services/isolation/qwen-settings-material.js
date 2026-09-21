// Qwen Code per-user provider registry (ADR-101 §3, ADR-105's account/setup split).
//
// WHY THIS FILE EXISTS — measured, not inferred (2026-09-07, qwen-code 0.23.0):
// a headless turn in an isolated ~/.qwen with no settings.json does not reach the
// model at all. It exits 1 with num_turns 0 and
//   "No auth type is selected. Please configure an auth type (e.g. via settings
//    or `--auth-type`) before running in non-interactive mode."
// Injecting BAILIAN_*_API_KEY + OPENAI_BASE_URL into the child environment —
// which qwen-cli.js already does — is NOT sufficient on its own: with
// `--auth-type openai` and no registry the CLI asks for OPENAI_API_KEY instead,
// because the model list (and the `envKey` indirection that names the BAILIAN_*
// variable) lives in settings.json, not in the environment.
//
// Four probes pinned the contract. A registry WITHOUT the auth-type selection
// fails; an auth-type selection WITHOUT the registry fails; both together reach
// Alibaba's edge (a deliberately invalid key returns its own 401). `name`,
// `generationConfig`, `model` and `providerMetadata` are all optional — the
// minimal entry below is what was measured, so nothing here invents a value
// nassaj cannot source (B-235).
//
// THE CREDENTIAL NEVER ENTERS THIS FILE. qwen-cli.js's header states the
// invariant ("never put in argv, a Qwen settings file, a transcript, or a log
// entry") and this module is written to honour it: it emits `envKey`, the NAME
// of the variable the CLI should read, and qwen-cli.js supplies the value
// through the child environment at spawn. The operator's own ~/.qwen/settings.json
// does carry the key in an `env` block, which is exactly why provision-user-dirs
// links that file for nobody — a link would hand one person's subscription to
// every member (ADR-105). Any such key found in a member's file is reaped here.

import fs from 'node:fs';
import path from 'node:path';

export const QWEN_SETTINGS_FILENAME = 'settings.json';

/**
 * Where Qwen Code keeps its user state below HOME (ADR-101/T-1374). Declared
 * here rather than imported from provision-user-dirs so this module stays
 * dependency-free: the launcher reaches it on the spawn path, and pulling the
 * provisioner in would drag the database and opencode-config graph behind it.
 */
export const QWEN_HOME_SUBDIR = '.qwen';

/** The auth type the CLI's OpenAI-compatible route is selected by. */
export const QWEN_SELECTED_AUTH_TYPE = 'openai';

/** The provider id the CLI's own OpenAI-compatible registry is keyed under. */
export const QWEN_PROVIDER_ID = 'openai';

/**
 * The credential variable names that must never be persisted here. The same set
 * qwen-cli.js strips from the inherited environment before injecting the one
 * actor-bound key, so a value cannot leak into this file by either route.
 */
const FORBIDDEN_ENV_KEYS = Object.freeze([
  'BAILIAN_CODING_PLAN_API_KEY',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
]);

const SETTINGS_FILE_MODE = 0o600;

/** Canonical form for the drift comparison only — key order is not semantic. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readExisting(settingsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Absent, unreadable or not an object: start from nothing. A member's
    // unparseable hand-edit is replaced rather than preserved, because a
    // half-read settings file is what produced the silent launch this closes.
    return {};
  }
}

/**
 * Drops any persisted credential from the member's own `env` block, leaving
 * their unrelated settings intact. Returns the (possibly new) settings object.
 */
function stripPersistedCredentials(settings) {
  const env = settings.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    delete settings.env;
    return settings;
  }
  for (const name of FORBIDDEN_ENV_KEYS) {
    delete env[name];
  }
  if (Object.keys(env).length === 0) {
    delete settings.env;
  }
  return settings;
}

/**
 * Builds the settings object a Qwen turn needs, merged over whatever the member
 * already has so their own preferences survive.
 *
 * @param {object} existing the member's current settings (already credential-free)
 * @param {{ baseUrl: string, envKey: string }} runtime resolveQwenRuntime's answer
 *   for this member's plan and region
 * @param {Array<{ value: string }>} models qwenModelsForPlan(plan).OPTIONS
 * @returns {object} the settings to persist
 */
export function buildQwenSettings(existing, runtime, models) {
  const settings = stripPersistedCredentials({ ...existing });
  const security = settings.security && typeof settings.security === 'object' ? settings.security : {};
  const auth = security.auth && typeof security.auth === 'object' ? security.auth : {};

  return {
    ...settings,
    $version: 4,
    security: { ...security, auth: { ...auth, selectedType: QWEN_SELECTED_AUTH_TYPE } },
    modelProviders: {
      ...(settings.modelProviders && typeof settings.modelProviders === 'object'
        && !Array.isArray(settings.modelProviders) ? settings.modelProviders : {}),
      [QWEN_PROVIDER_ID]: models.map((model) => ({
        id: model.value,
        baseUrl: runtime.baseUrl,
        envKey: runtime.envKey,
      })),
    },
  };
}

/**
 * Establishes `<qwenHome>/settings.json` for one member. Idempotent: a file that
 * already carries this exact registry is left alone, so a spawn does not rewrite
 * it every turn. Writes 0600 (umask-safe, never a transient group-readable
 * window) — readable and writable by the member's own CLI, which persists its
 * own preferences here, and by nobody else.
 *
 * Best-effort by design: a failure is reported to the caller, which already
 * refuses the turn on its own credential and install gates. Nothing here throws.
 *
 * @param {string} qwenHome the member's isolated `~/.qwen`
 * @param {{ baseUrl: string, envKey: string }} runtime
 * @param {Array<{ value: string }>} models
 * @returns {boolean} whether the registry is correct on disk afterwards
 */
export function materializeQwenSettings(qwenHome, runtime, models) {
  if (typeof qwenHome !== 'string' || qwenHome === '') return false;
  if (!runtime?.baseUrl || !runtime?.envKey) return false;
  if (!Array.isArray(models) || models.length === 0) return false;

  const settingsPath = path.join(qwenHome, QWEN_SETTINGS_FILENAME);
  try {
    const desired = buildQwenSettings(readExisting(settingsPath), runtime, models);
    let current;
    try {
      current = canonical(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch {
      current = null;
    }
    if (current === canonical(desired)) {
      return true;
    }
    fs.mkdirSync(qwenHome, { recursive: true });
    // A hostile or dangling symlink in this position would otherwise be written
    // THROUGH. rmSync drops the directory entry; it never follows.
    if (fs.lstatSync(settingsPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.rmSync(settingsPath, { force: true });
    }
    fs.writeFileSync(settingsPath, `${JSON.stringify(desired, null, 2)}\n`, { mode: SETTINGS_FILE_MODE });
    fs.chmodSync(settingsPath, SETTINGS_FILE_MODE);
    return true;
  } catch (err) {
    console.error('[qwen-settings-material] could not establish the provider registry', {
      qwenHome,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
