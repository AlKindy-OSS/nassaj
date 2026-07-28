/**
 * Launch-intent schema + strict validator (ADR-053 §ج-1).
 *
 * A launch intent is the ONLY thing the chat path writes; it is web-originated
 * (a user clicked "run a workflow" in the browser) and therefore UNTRUSTED. The
 * supervisor never acts on a field it has not re-validated. This module owns the
 * shape and the syntactic validation; SEMANTIC authorization (does this user own
 * the project?) lives in ownership.ts and is applied by the supervisor AFTER
 * this passes — the two are deliberately separate gates (§ج-3 distinguishes
 * "respect the given var" from "derive/authorize the identity").
 */

/** The launch intent the chat bridge writes atomically to disk. */
export type LaunchIntent = {
  /** Unique launch id (also the scope unit suffix). Must match /^[A-Za-z0-9_-]+$/. */
  wfLaunchId: string;
  /** Authenticated user id from the socket JWT. MUST be a real integer. */
  userId: number;
  /** Absolute project directory the workflow runs in (cwd for `claude -p`). */
  projectPath: string;
  /** The prompt/script text handed to `claude -p`. */
  scriptOrPrompt: string;
  /** Optional model override. */
  model?: string | null;
  /** Optional reasoning-effort override. */
  effort?: string | null;
  /** ISO timestamp the intent was written. */
  requestedAt: string;
};

/** The closed set of delivery policies (§د). Anything else is rejected. */
export const HANDOFF_POLICIES = ['card-only', 'auto-turn', 'on-demand'] as const;
export type HandoffPolicy = (typeof HANDOFF_POLICIES)[number];

/**
 * The serialized spec of a durable task (§أ-1). The FULL spec is captured at
 * request time (never a raw command) so there is no ambiguity between "intent"
 * and "inline execution" — the mistake that made Layer 2 double-execute (B-129).
 */
export type DurableTaskSpec = {
  /** The prompt/script text handed to `claude -p`. */
  scriptOrPrompt: string;
  /** Optional model override. */
  model: string | null;
  /** Optional reasoning-effort override. */
  effort: string | null;
  /** Delivery-cost governance (§د). Default is card-only (T-830). */
  handoffPolicy: HandoffPolicy;
  /** The injected turn is ALWAYS leaf-only (الشرط 2). Constant true. */
  leafOnly: true;
};

/**
 * Durable Task (schema_version "2", §أ-1) — the explicit background task the NEW
 * launch route writes. It EXTENDS LaunchIntent with the delivery-intent context
 * ({conversation, origin message, full spec, handoff policy}) so a later monitor
 * can deliver the result to the exact conversation that requested it.
 *
 * SECURITY: `conversationId`/`originMessageId` are WEB-ORIGINATED and untrusted;
 * `conversationId` becomes a real filesystem path `<projectDir>/<id>.jsonl`
 * (transcript-parser) at delivery time, so a value like `../../etc` would be a
 * path traversal. Both are therefore validated with the SAME strict charset as
 * `taskId` (§أ-1: any field outside the template ⇒ reject).
 */
export type DurableTask = {
  schema_version: '2';
  /** = wfLaunchId; the unit suffix. Strict charset (no path/unit injection). */
  taskId: string;
  /** Authenticated user id from the JWT. MUST be a real integer (isolation base). */
  userId: number;
  /** Absolute project directory (cwd for `claude -p`). */
  projectPath: string;
  /** Target conversation session id — strict charset (builds the jsonl path). */
  conversationId: string;
  /** The message that requested the task — strict charset (audit + dedup). */
  originMessageId: string;
  /** The fully-serialized spec (never a raw command). */
  spec: DurableTaskSpec;
  /** ISO timestamp the task was requested. */
  requestedAt: string;
};

/**
 * Result of validating an untrusted intent blob. When the blob is a
 * schema_version "2" durable task, `task` carries the full DurableTask AND
 * `intent` carries a normalized LaunchIntent VIEW of it (taskId→wfLaunchId,
 * spec.scriptOrPrompt→scriptOrPrompt, …) so the existing launch pipeline
 * (GATE2 → concurrency → launchScope) consumes it UNCHANGED.
 */
export type IntentValidation =
  | { ok: true; intent: LaunchIntent; task?: DurableTask }
  | { ok: false; reason: string };

/** wfLaunchId / conversationId / originMessageId charset: safe for a filesystem
 * path AND a systemd unit name (no traversal, no unit-name injection). */
const WF_LAUNCH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Size caps for the DISK validator (C5 — do not rely on the route's caps for a
 * tampered on-disk intent). Mirrors the route's MAX_PROMPT_BYTES / 128. */
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OPT_STRING = 128;
const MAX_PROJECT_PATH = 4096;

/**
 * C5 (T-820 audit) — HARDENED absolute-path check for the DISK validator, so it
 * does NOT lean on GATE2's path normalization or Node's spawn to reject a hostile
 * projectPath. Rejects: non-absolute, `..` traversal segments, NUL bytes, C0/DEL
 * control chars, and over-long paths. `projectPath` is not a web id field (it has
 * no strict charset), so these explicit rejections are its own defense.
 */
function isHardenedAbsolutePath(p: unknown): p is string {
  if (typeof p !== 'string') {
    return false;
  }
  const s = p.trim();
  if (s.length === 0 || s.length > MAX_PROJECT_PATH || !s.startsWith('/')) {
    return false;
  }
  // Reject NUL/C0 control chars and DEL without a literal-control regex.
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) {
      return false;
    }
  }
  // Reject any `..` path segment (traversal), regardless of position.
  const segments = s.split('/');
  if (segments.some((seg) => seg === '..')) {
    return false;
  }
  return true;
}

/** Allowed top-level keys of a v2 DurableTask; any extra key ⇒ reject (§أ-1). */
const DURABLE_TASK_KEYS = new Set([
  'schema_version',
  'taskId',
  'userId',
  'projectPath',
  'conversationId',
  'originMessageId',
  'spec',
  'requestedAt',
]);

/** Allowed keys inside DurableTask.spec; any extra key ⇒ reject (§أ-1). */
const DURABLE_TASK_SPEC_KEYS = new Set([
  'scriptOrPrompt',
  'model',
  'effort',
  'handoffPolicy',
  'leafOnly',
]);

/**
 * Syntactic validation of an untrusted intent object. Returns a discriminated
 * result — NEVER throws — so the supervisor can log-and-skip a malformed file
 * without crashing its loop.
 *
 * Branches on `schema_version`: a "2" blob is validated as a DurableTask with
 * STRICT charset on every web-originated field (الشرط 3 / §أ-1); anything else
 * is validated as a legacy v1 LaunchIntent (the decommissioned Layer-2 bridge +
 * its tests), whose behavior is preserved byte-for-byte.
 *
 * Enforced invariants (all fail-closed):
 *   - `userId` is an INTEGER (a string "123" or "abc" or missing => reject; the
 *     per-user config-dir isolation keys off a real integer id).
 *   - the id fields match the strict charset (no path traversal, no unit-name
 *     injection).
 *   - `projectPath` is a non-empty absolute path.
 *   - `scriptOrPrompt` is a non-empty string.
 * `model`/`effort` are optional strings; anything else is coerced to null.
 */
export function validateIntent(raw: unknown): IntentValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'intent is not an object' };
  }
  const o = raw as Record<string, unknown>;

  if (o.schema_version === '2') {
    return validateDurableTask(o);
  }
  return validateLegacyIntent(o);
}

/** Legacy v1 validation — preserved exactly (dead Layer-2 bridge + its tests). */
function validateLegacyIntent(o: Record<string, unknown>): IntentValidation {
  // userId MUST be a real integer — not a numeric string. Number.isInteger is
  // the same fail-closed gate the isolation seam and DB predicates use.
  if (!Number.isInteger(o.userId)) {
    return { ok: false, reason: 'userId is not an integer' };
  }
  const userId = o.userId as number;

  if (typeof o.wfLaunchId !== 'string' || !WF_LAUNCH_ID_RE.test(o.wfLaunchId)) {
    return { ok: false, reason: 'wfLaunchId missing or invalid charset' };
  }

  if (
    typeof o.projectPath !== 'string' ||
    o.projectPath.trim().length === 0 ||
    !o.projectPath.startsWith('/')
  ) {
    return { ok: false, reason: 'projectPath missing or not absolute' };
  }

  if (typeof o.scriptOrPrompt !== 'string' || o.scriptOrPrompt.trim().length === 0) {
    return { ok: false, reason: 'scriptOrPrompt missing or empty' };
  }

  const requestedAt =
    typeof o.requestedAt === 'string' && o.requestedAt.trim().length > 0
      ? o.requestedAt
      : new Date(0).toISOString();

  return {
    ok: true,
    intent: {
      wfLaunchId: o.wfLaunchId,
      userId,
      projectPath: o.projectPath,
      scriptOrPrompt: o.scriptOrPrompt,
      model: typeof o.model === 'string' ? o.model : null,
      effort: typeof o.effort === 'string' ? o.effort : null,
      requestedAt,
    },
  };
}

/**
 * STRICT v2 DurableTask validation (§أ-1). Every web-originated field is
 * fail-closed: integer userId, strict charset on taskId/conversationId/
 * originMessageId, absolute projectPath, closed handoffPolicy enum, leafOnly
 * LITERALLY true, and NO key outside the template (top-level or in spec).
 */
function validateDurableTask(o: Record<string, unknown>): IntentValidation {
  // Reject any smuggled top-level key before trusting anything else.
  for (const key of Object.keys(o)) {
    if (!DURABLE_TASK_KEYS.has(key)) {
      return { ok: false, reason: `unexpected DurableTask field: ${key}` };
    }
  }

  // C5 (T-820 audit): the disk validator itself enforces `userId > 0`, unifying
  // its contract with the strict env-resolver's ("integer POSITIVE"); a 0/-5 id
  // no longer slips through the syntactic gate to lean on GATE2/the wrapper.
  if (!Number.isInteger(o.userId) || (o.userId as number) <= 0) {
    return { ok: false, reason: 'userId is not a positive integer' };
  }
  const userId = o.userId as number;

  if (typeof o.taskId !== 'string' || !WF_LAUNCH_ID_RE.test(o.taskId)) {
    return { ok: false, reason: 'taskId missing or invalid charset' };
  }

  // C5: HARDENED projectPath — reject `..`/NUL/control chars, not just non-absolute.
  if (!isHardenedAbsolutePath(o.projectPath)) {
    return { ok: false, reason: 'projectPath missing, not absolute, or unsafe' };
  }

  // conversationId/originMessageId build a real jsonl path downstream — strict.
  if (typeof o.conversationId !== 'string' || !WF_LAUNCH_ID_RE.test(o.conversationId)) {
    return { ok: false, reason: 'conversationId missing or invalid charset' };
  }
  if (typeof o.originMessageId !== 'string' || !WF_LAUNCH_ID_RE.test(o.originMessageId)) {
    return { ok: false, reason: 'originMessageId missing or invalid charset' };
  }

  if (!o.spec || typeof o.spec !== 'object') {
    return { ok: false, reason: 'spec missing or not an object' };
  }
  const spec = o.spec as Record<string, unknown>;
  for (const key of Object.keys(spec)) {
    if (!DURABLE_TASK_SPEC_KEYS.has(key)) {
      return { ok: false, reason: `unexpected spec field: ${key}` };
    }
  }

  if (typeof spec.scriptOrPrompt !== 'string' || spec.scriptOrPrompt.trim().length === 0) {
    return { ok: false, reason: 'spec.scriptOrPrompt missing or empty' };
  }
  // C5: byte cap in the DISK validator too (a tampered file must not carry an
  // unbounded prompt just because it skipped the route's cap).
  if (Buffer.byteLength(spec.scriptOrPrompt, 'utf8') > MAX_PROMPT_BYTES) {
    return { ok: false, reason: 'spec.scriptOrPrompt too large' };
  }
  // C5: size caps on optional string fields (reject rather than silently coerce a
  // huge value to null — a tampered file should be refused, not normalized).
  if (typeof spec.model === 'string' && spec.model.length > MAX_OPT_STRING) {
    return { ok: false, reason: 'spec.model too large' };
  }
  if (typeof spec.effort === 'string' && spec.effort.length > MAX_OPT_STRING) {
    return { ok: false, reason: 'spec.effort too large' };
  }

  // handoffPolicy: default card-only when absent; a PRESENT value must be in the
  // closed set (T-830 default; §د cost governance).
  let handoffPolicy: HandoffPolicy = 'card-only';
  if (spec.handoffPolicy !== undefined && spec.handoffPolicy !== null) {
    if (
      typeof spec.handoffPolicy !== 'string' ||
      !(HANDOFF_POLICIES as readonly string[]).includes(spec.handoffPolicy)
    ) {
      return { ok: false, reason: 'spec.handoffPolicy not in the closed set' };
    }
    handoffPolicy = spec.handoffPolicy as HandoffPolicy;
  }

  // leafOnly MUST be literally true (الشرط 2 — a durable turn is never allowed to
  // spawn background work). Absent is treated as the mandated default true.
  if (spec.leafOnly !== undefined && spec.leafOnly !== true) {
    return { ok: false, reason: 'spec.leafOnly must be literally true' };
  }

  const requestedAt =
    typeof o.requestedAt === 'string' && o.requestedAt.trim().length > 0
      ? o.requestedAt
      : new Date(0).toISOString();

  const model = typeof spec.model === 'string' ? spec.model : null;
  const effort = typeof spec.effort === 'string' ? spec.effort : null;

  const task: DurableTask = {
    schema_version: '2',
    taskId: o.taskId,
    userId,
    projectPath: o.projectPath,
    conversationId: o.conversationId,
    originMessageId: o.originMessageId,
    spec: { scriptOrPrompt: spec.scriptOrPrompt, model, effort, handoffPolicy, leafOnly: true },
    requestedAt,
  };

  // Normalized LaunchIntent VIEW so the existing pipeline consumes v2 unchanged.
  return {
    ok: true,
    intent: {
      wfLaunchId: task.taskId,
      userId,
      projectPath: task.projectPath,
      scriptOrPrompt: task.spec.scriptOrPrompt,
      model,
      effort,
      requestedAt,
    },
    task,
  };
}
