// command-board-custom.js — T-948 / ADR-067 (Phase 2)
//
// أوامر مخصّصة يعرّفها المالك في «لوحة الأوامر». تُدمج في الكتالوج وتُنفَّذ عبر
// نفس مسار executeActionRow/spawn الثابت (shell:false، cwd = APP_ROOT، env نظيف).
//
// SECURITY MODEL (qa-critic mandatory conditions — veto on violation)
// ==================================================================
// Threat model: an attacker holding an ACTIVE owner session (stored XSS —
// B-158/B-159). So even "owner" input is treated as hostile. Custom commands
// move the code-review barrier of the frozen allowlist to an OPERATIONAL grant,
// so the executable restriction below is the load-bearing safety valve.
//
//   • cmd is restricted to a FROZEN EXECUTABLE_ALLOWLIST with a per-executable
//     argument policy. Interpreters (bash/sh/zsh/dash/node/python*/perl/ruby/
//     deno/bun/…) are additionally on a FROZEN INTERPRETER_DENYLIST and are
//     rejected before the allowlist is even consulted. Anything not on the
//     allowlist is rejected fail-closed. There is NO shell anywhere.
//   • The ONLY seeded executable is `npm run <script>` where <script> must be a
//     script that already EXISTS in the repo package.json — validated at
//     DEFINITION time AND again at EXECUTION time — and is not on a frozen
//     denylist of long-running / release-class scripts. Because package.json
//     scripts are commit-gated, this preserves the code-review barrier: an
//     attacker can only trigger an existing, reviewed npm script, never inject a
//     new command. `npm exec`/`npm x` and any flag argument (leading `-`) are
//     rejected. Adding another executable is a CODE change + a qa-critic review,
//     never data.
//   • args are literal strings validated against a strict token pattern with a
//     length cap; there is ZERO interpolation from any message/session/reason/
//     request field — the argv is fully determined by the stored definition.
//   • Hard caps: at most MAX_CUSTOM_COMMANDS commands; bounded key/label/arg
//     lengths and count.
//   • Every create/update/delete is audited by the route with the acting user.
//   • fail-closed everywhere: corrupt config, unknown key, disallowed cmd, or a
//     missing/denylisted script → reject; never a permissive fallback.

import fs from 'fs';
import path from 'path';

import { appConfigDb } from '../modules/database/index.js';
import { getAction, APP_ROOT } from './server-actions.js';

/** app_config key holding the JSON array of owner-defined custom commands. */
export const CUSTOM_COMMANDS_CONFIG_KEY = 'command_board_custom_commands';

// ── Caps (frozen) ────────────────────────────────────────────────────────────
export const MAX_CUSTOM_COMMANDS = 20;
const MAX_KEY_LEN = 64;
const MAX_LABEL_LEN = 80;
const MAX_ARGS = 8;
const MAX_ARG_LEN = 64;

// Non-detached actions run to completion bounded by this hard cap (matches the
// route's foreground timeout). Server-controlled — never owner input.
export const CUSTOM_ACTION_TIMEOUT_MS = 120_000;

const VALID_ROLES = new Set(['owner', 'admin', 'user']);

// Keys that could collide with Object prototype members. `__proto__` already
// fails SAFE_KEY (leading underscore), but `constructor`/`prototype` match the
// lowercase pattern; reject them explicitly so a stored key can never resolve to
// an inherited property anywhere it is used as an object index (defence in depth
// on top of the array-based store + hasOwnProperty lookups).
const RESERVED_DANGEROUS_KEYS = Object.freeze(
  new Set(['__proto__', 'prototype', 'constructor'])
);

// key: starts with a lowercase letter, then lowercase/digits/-/_. Bounded. Must
// not collide with a static action type (checked separately).
const SAFE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
// label: printable, bounded; Arabic + Latin letters, digits, spaces, and a small
// set of punctuation. No control characters, no angle brackets, no quotes.
const SAFE_LABEL = /^[\p{L}\p{N} _.:()/-]{1,80}$/u;
// cmd: a bare lowercase executable name — never a path (no "/", no ".").
const SAFE_CMD = /^[a-z][a-z0-9_-]{0,31}$/;
// generic argv token: no leading "-", no whitespace, no shell metacharacters.
// NOTE: this generic filter is DELIBERATELY permissive — it allows "/", ".", "="
// so that path-shaped and key=value args stay usable. It is therefore NOT a
// sufficient gate on its own: every executable added to EXECUTABLE_ALLOWLIST MUST
// ship its own per-executable argument policy (as npm does — `run <script>` only,
// existence-checked, denylist-checked). Never rely on SAFE_ARG alone to constrain
// a new executable's argv.
const SAFE_ARG = /^[A-Za-z0-9:_.=/][A-Za-z0-9:_.=/-]{0,63}$/;
// npm script name (kept strict; the real gate is existence in package.json).
const SAFE_NPM_SCRIPT = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;

// Interpreters / shells / privilege tools that must NEVER be an executable, even
// if a future allowlist entry is added. Checked BEFORE the allowlist.
const INTERPRETER_DENYLIST = Object.freeze(
  new Set([
    'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash',
    'node', 'nodejs', 'deno', 'bun', 'ts-node', 'tsx',
    'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'lua', 'rscript',
    'env', 'eval', 'exec', 'sudo', 'su', 'doas', 'ssh', 'scp',
    'nc', 'ncat', 'netcat', 'socat', 'xargs', 'find', 'awk', 'gawk', 'sed',
    'make', 'cmake', 'docker', 'kubectl', 'pm2', 'systemctl', 'git', 'curl', 'wget',
  ])
);

// npm scripts that exist but must never become an owner button: long-running /
// server-spawning / release-class / build-class. FROZEN.
//
// REVIEW ON EVERY package.json CHANGE: this denylist is a positive list of the
// scripts that exist TODAY and must stay non-runnable. Adding ANY new script to
// package.json requires re-auditing this set — a new long-running / release /
// deploy / build script that lands here undenied becomes a one-click owner
// button. The build-class scripts are especially load-bearing: `build:client`
// and `build:server` rewrite the LIVE-SERVED dist/ and dist-server/ trees on
// the public deployment origin, so a button that runs them is a production state change.
const NPM_SCRIPT_DENYLIST = Object.freeze(
  new Set([
    'dev', 'server', 'server:dev', 'server:dev-watch', 'client', 'preview',
    'start', 'release', 'prepublishonly', 'prepublishOnly', 'prepare',
    'postinstall', 'update:platform',
    // build-class: rewrite live-served dist/dist-server → production mutation.
    'build', 'build:client', 'build:server', 'prebuild:server', 'typecheck',
  ])
);

// Curated env passthrough for a spawned custom command. The server process env
// may carry secrets (JWT_SECRET, DATABASE_PATH, provider keys); a custom command
// gets ONLY what npm/node need, never those. No request field ever reaches here.
export const ENV_PASSTHROUGH = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR',
  'USER', 'LOGNAME', 'SHELL',
]);

/**
 * Builds the minimal, secret-free env for a spawned command. Exported so the
 * raw-exec path (T-962) reuses the EXACT same passthrough as custom commands —
 * a single source of truth for "which env vars a spawned board command may see"
 * (never JWT_SECRET / DATABASE_PATH / provider keys).
 */
export function cleanSpawnEnv() {
  const env = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * Reads the repo package.json scripts (commit-gated) at call time so the set of
 * runnable scripts is exactly what code review approved. fail-closed: any read/
 * parse error → empty set → every npm command is rejected.
 * @returns {Set<string>}
 */
function readPackageScripts() {
  try {
    const raw = fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const scripts =
      parsed && typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : {};
    return new Set(Object.keys(scripts));
  } catch {
    return new Set();
  }
}

/**
 * FROZEN executable allowlist. Each entry is a per-executable argument policy.
 * validate(args) → { ok, error? , normalizedArgs?, preview? }. Adding an entry is
 * a code change gated on a qa-critic review — never data / never a request.
 */
export const EXECUTABLE_ALLOWLIST = Object.freeze({
  npm: Object.freeze({
    // `npm run <script>` and nothing else.
    validate(args) {
      if (args.length !== 2) return { ok: false, error: 'npm_args_shape' };
      if (args[0] !== 'run') return { ok: false, error: 'npm_subcommand_must_be_run' };
      const script = args[1];
      if (typeof script !== 'string' || !SAFE_NPM_SCRIPT.test(script)) {
        return { ok: false, error: 'npm_script_pattern' };
      }
      const lower = script.toLowerCase();
      if (NPM_SCRIPT_DENYLIST.has(script) || NPM_SCRIPT_DENYLIST.has(lower)) {
        return { ok: false, error: `npm_script_denylisted:${script}` };
      }
      if (!readPackageScripts().has(script)) {
        return { ok: false, error: `npm_script_missing:${script}` };
      }
      return { ok: true, normalizedArgs: ['run', script], preview: `npm run ${script}` };
    },
  }),
});

/**
 * Validates a (cmd, args) pair against the interpreter denylist, the executable
 * allowlist, the generic argv-token rules, and the per-executable policy. Pure;
 * fail-closed. Returns { ok, cmd, normalizedArgs, preview } or { ok:false, error }.
 */
export function validateExecutable(cmd, args) {
  if (typeof cmd !== 'string' || !SAFE_CMD.test(cmd)) {
    return { ok: false, error: 'invalid_cmd' };
  }
  if (INTERPRETER_DENYLIST.has(cmd)) {
    return { ok: false, error: `interpreter_forbidden:${cmd}` };
  }
  // Own-property lookup only (defends against __proto__/constructor resolution).
  const policy = Object.prototype.hasOwnProperty.call(EXECUTABLE_ALLOWLIST, cmd)
    ? EXECUTABLE_ALLOWLIST[cmd]
    : null;
  if (!policy) {
    return { ok: false, error: `cmd_not_allowlisted:${cmd}` };
  }
  if (!Array.isArray(args)) {
    return { ok: false, error: 'args_not_array' };
  }
  if (args.length > MAX_ARGS) {
    return { ok: false, error: 'too_many_args' };
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_ARG_LEN) {
      return { ok: false, error: 'invalid_arg' };
    }
    if (arg.startsWith('-')) {
      return { ok: false, error: 'flag_arg_forbidden' };
    }
    if (!SAFE_ARG.test(arg)) {
      return { ok: false, error: 'invalid_arg' };
    }
  }
  const res = policy.validate(args);
  if (!res.ok) return res;
  return { ok: true, cmd, normalizedArgs: res.normalizedArgs, preview: res.preview };
}

// ── Storage (app_config) ─────────────────────────────────────────────────────

/** Reads + shape-filters the stored custom commands. fail-closed → []. */
function readStore() {
  let parsed = null;
  try {
    const raw = appConfigDb.get(CUSTOM_COMMANDS_CONFIG_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null; // corrupt JSON → treated as empty
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((e) => e && typeof e === 'object' && typeof e.key === 'string');
}

function writeStore(list) {
  appConfigDb.set(CUSTOM_COMMANDS_CONFIG_KEY, JSON.stringify(list));
}

/** Raw stored entries (shape-filtered only). Internal / diagnostics. */
export function getRawCustomCommands() {
  return readStore();
}

/**
 * Validates an owner-supplied definition into a normalized, storable record.
 * @param {{key?:unknown,label?:unknown,cmd?:unknown,args?:unknown,minRole?:unknown}} input
 * @param {{ existingKeys?: Set<string>, forKey?: string }} ctx
 * @returns {{ok:true, value:{key:string,label:string,cmd:string,args:string[],
 *            minRole:string,commandPreview:string}} | {ok:false, error:string}}
 */
export function validateCustomCommandDefinition(input, ctx = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_body' };

  const key = ctx.forKey !== undefined ? ctx.forKey : input.key;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LEN || !SAFE_KEY.test(key)) {
    return { ok: false, error: 'invalid_key' };
  }
  if (RESERVED_DANGEROUS_KEYS.has(key)) {
    return { ok: false, error: 'invalid_key' };
  }
  // Never let a custom key shadow a frozen static action.
  if (getAction(key)) {
    return { ok: false, error: 'key_reserved' };
  }
  if (ctx.existingKeys && ctx.existingKeys.has(key)) {
    return { ok: false, error: 'key_exists' };
  }

  const { label } = input;
  if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LEN || !SAFE_LABEL.test(label)) {
    return { ok: false, error: 'invalid_label' };
  }

  let minRole = 'owner';
  if (input.minRole !== undefined && input.minRole !== null) {
    if (typeof input.minRole !== 'string' || !VALID_ROLES.has(input.minRole)) {
      return { ok: false, error: 'invalid_min_role' };
    }
    minRole = input.minRole;
  }

  const exec = validateExecutable(input.cmd, input.args);
  if (!exec.ok) return { ok: false, error: exec.error };

  return {
    ok: true,
    value: {
      key,
      label,
      cmd: exec.cmd,
      args: exec.normalizedArgs,
      minRole,
      commandPreview: exec.preview,
    },
  };
}

/**
 * Resolves a custom command key to a normalized, FROZEN action definition shaped
 * like a SERVER_ACTIONS entry (so executeActionRow treats it uniformly), or null.
 * Re-validates the executable at resolution time (execution-time gate): a stored
 * command whose script was later removed/denylisted resolves to null (fail-closed).
 * Never shadows a static action.
 */
export function getCustomAction(key) {
  if (typeof key !== 'string') return null;
  if (getAction(key)) return null;
  const def = readStore().find((e) => e.key === key);
  if (!def) return null;
  const exec = validateExecutable(def.cmd, def.args);
  if (!exec.ok) return null;
  const label = typeof def.label === 'string' && def.label.length > 0 ? def.label : key;
  const minRole = typeof def.minRole === 'string' && VALID_ROLES.has(def.minRole) ? def.minRole : 'owner';
  return Object.freeze({
    actionType: key,
    labelKey: label, // literal label (not an i18n key) — client renders custom labels verbatim
    label,
    cmd: exec.cmd,
    args: Object.freeze([...exec.normalizedArgs]),
    gateArgs: undefined, // custom commands have no pre-flight gate
    detachExec: false,
    cwd: APP_ROOT,
    env: cleanSpawnEnv(),
    timeoutMs: CUSTOM_ACTION_TIMEOUT_MS,
    commandPreview: exec.preview,
    minRole,
    custom: true,
  });
}

/** True only for a currently-valid custom command key. */
export const isCustomAction = (key) => getCustomAction(key) !== null;

/**
 * Unified resolver: a static allowlisted action (highest trust) OR a valid custom
 * command. Static wins on any name overlap (custom keys can never shadow static).
 */
export function resolveAction(actionType) {
  const staticAction = getAction(actionType);
  if (staticAction) return staticAction;
  return getCustomAction(actionType);
}

/** True for any known (static OR custom) action type. */
export const isKnownActionType = (actionType) => resolveAction(actionType) !== null;

/**
 * Owner management view: every stored definition with its validity + preview.
 * Includes cmd/args (owner-only endpoint) so the settings page can edit them.
 */
export function listCustomCommandsForOwner() {
  return readStore().map((e) => {
    const exec = validateExecutable(e.cmd, e.args);
    const minRole = typeof e.minRole === 'string' && VALID_ROLES.has(e.minRole) ? e.minRole : 'owner';
    return {
      key: e.key,
      label: typeof e.label === 'string' ? e.label : e.key,
      cmd: typeof e.cmd === 'string' ? e.cmd : null,
      args: Array.isArray(e.args) ? e.args.filter((a) => typeof a === 'string') : [],
      minRole,
      valid: exec.ok,
      commandPreview: exec.ok ? exec.preview : null,
      error: exec.ok ? null : exec.error,
    };
  });
}

/**
 * Client-safe catalog of VALID custom commands for the /actions merge. Symbolic +
 * display only (never the structured argv). Invalid stored commands are hidden.
 */
export function toPublicCustomCatalog() {
  const out = [];
  for (const e of readStore()) {
    const action = getCustomAction(e.key);
    if (!action) continue; // fail-closed: hide anything not currently runnable
    out.push({
      actionType: action.actionType,
      label: action.label,
      commandPreview: action.commandPreview,
      minRole: action.minRole,
      custom: true,
    });
  }
  return out;
}

/** Number of stored custom commands (for the cap / diagnostics). */
export function countCustomCommands() {
  return readStore().length;
}

// ── CRUD (owner-only; the route enforces requireRole('owner') + audit) ────────

/** Creates a custom command. fail-closed on cap / validation. */
export function createCustomCommand(input) {
  const list = readStore();
  if (list.length >= MAX_CUSTOM_COMMANDS) {
    return { ok: false, error: 'too_many_commands' };
  }
  const existingKeys = new Set(list.map((e) => e.key));
  const v = validateCustomCommandDefinition(input, { existingKeys });
  if (!v.ok) return v;
  list.push({
    key: v.value.key,
    label: v.value.label,
    cmd: v.value.cmd,
    args: v.value.args,
    minRole: v.value.minRole,
  });
  writeStore(list);
  return { ok: true, value: v.value };
}

/** Updates an existing custom command (key is immutable). fail-closed. */
export function updateCustomCommand(key, input) {
  const list = readStore();
  const idx = list.findIndex((e) => e.key === key);
  if (idx === -1) return { ok: false, error: 'not_found' };
  const v = validateCustomCommandDefinition({ ...input, key }, { forKey: key });
  if (!v.ok) return v;
  list[idx] = {
    key,
    label: v.value.label,
    cmd: v.value.cmd,
    args: v.value.args,
    minRole: v.value.minRole,
  };
  writeStore(list);
  return { ok: true, value: v.value };
}

/** Deletes a custom command by key. Idempotent. */
export function deleteCustomCommand(key) {
  const list = readStore();
  const next = list.filter((e) => e.key !== key);
  const removed = next.length !== list.length;
  if (removed) writeStore(next);
  return { ok: true, removed };
}
