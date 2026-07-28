// command-board-raw.js — T-948 Phase 3 / ADR-070 (raw-exec, "تنفيذ أي أمر").
//
// ⚖️ DOCUMENTED VETO OVERRIDE. qa-critic placed a FINAL veto on this phase
// (2026-07-24): the command board runs actions suggested by AGENT messages, so a
// poisoned message ⇒ RCE with an active XSS surface (B-158/B-159). The OWNER,
// after being shown the alternatives, explicitly chose to build it (2026-07-25):
// «يكون عام فعليا، على مسؤولية المستخدم، المفروض يراجع الأمر قبل التنفيذ». The
// decision is the owner's and is in force — this module does NOT re-open the
// debate. Its entire job is to make the guarantee the owner required (human
// review) TECHNICALLY RELIABLE, not merely cosmetic.
//
// THREAT MODEL & LOAD-BEARING DEFENCES
// ====================================
// A raw command is an arbitrary shell string — the WHOLE point (pipes, globs,
// redirects). There is NO allowlist that constrains it, so the safety valve is
// entirely "what the human saw is exactly what runs":
//
//   • WYSIWYG: the command text is stored VERBATIM and executed VERBATIM — zero
//     re-quoting, merging, or variable substitution. It is passed as a SINGLE
//     argv element to `bash -c` (spawn shell:false), so the only shell that ever
//     interprets it is bash over the owner's own reviewed bytes; nothing from a
//     request/session/message is ever interpolated into argv or env.
//   • DIGEST BINDING (anti-TOCTOU): execution requires the client to send
//     `confirmationDigest` = sha256(text-shown-to-the-human). The server
//     recomputes sha256 over the STORED text and rejects on mismatch — so the row
//     cannot be swapped between the moment it was displayed and the moment the
//     owner clicked.
//   • MULTI-LINE COMMANDS ARE ALLOWED (T-966): the owner's most common use is
//     pasting a several-line bash script shown in chat, so exactly TWO layout
//     controls are permitted — LINE FEED (U+000A) and TAB (U+0009) — and NOTHING
//     ELSE is relaxed. They are safe here precisely because they render as a real
//     newline/tab in the <pre> review pane (WYSIWYG holds: what the human reads
//     is what bash gets), and bash treats U+000A as a genuine statement
//     separator. A separate LINE CAP (MAX_RAW_COMMAND_LINES) bounds the review
//     burden alongside the length cap.
//   • CARRIAGE RETURN (U+000D) STAYS FORBIDDEN — refused, never silently
//     normalised. A CRLF paste from Windows is REJECTED (distinct
//     `carriage_return_forbidden` code) rather than stripped to LF, because
//     rewriting the owner's bytes before hashing/executing would break the WYSIWYG
//     invariant the whole design rests on ("what you see is what runs"). VT
//     (U+000B), FF (U+000C) and NEL (U+0085) likewise stay forbidden — they are
//     invisible/ambiguous line breaks, not the ordinary newline the owner typed.
//   • TROJAN SOURCE / INVISIBLE-CHAR BAN: rejected at INSERT and again before
//     EXECUTION, by Unicode General_Category (not brittle range lists) — all
//     controls (\p{Cc}: C0/C1/DEL, incl. CR/VT/FF/NEL) EXCEPT the two permitted
//     above (TAB U+0009, LF U+000A), all format chars (\p{Cf}: bidi
//     overrides/embeddings/isolates, zero-width & WORD JOINER, invisible math ops,
//     SOFT HYPHEN, BOM, deprecated TAG chars), line/paragraph separators
//     (\p{Zl}/\p{Zp}), every space EXCEPT ordinary U+0020 (\p{Zs}), plus
//     U+FE00–FE0F variation selectors. Critical in an Arabic RTL UI where such
//     chars make the rendered command differ from the bytes that run; a legitimate
//     command (Arabic text and tashkeel included) needs none of them.
//   • NEVER auto-runs: every row requires an explicit, digest-bound execute.
//   • Secret-free env (shared ENV_PASSTHROUGH with custom commands — never
//     JWT_SECRET/DATABASE_PATH/provider keys), fixed cwd = APP_ROOT, 120s cap
//     enforced by the route (which kills the whole process GROUP, not just bash).
//   • Access requires ALL of: the rawExecEnabled ceiling armed + the requester's
//     role explicitly assigned tier 'raw' (ADR-072 AMENDED 2026-07-26 — raw is
//     assignable to ANY role, no longer owner-only; still no implicit upgrade from
//     a migrated 'general'/'custom'). The raw routes are gated by that TIER
//     (roleCanRun(role,'raw')) with authentication upstream — no coarse owner
//     floor — and prepareRawExecution re-checks canRoleRunRawExec, the single
//     function every execute must pass through.
//   • SELF-DESTRUCTION DENYLIST (B-197): a small, frozen set of shapes that would
//     take THIS server down are refused at insert AND at execute. See
//     RAW_DENY_RULES for the exact scope and its explicit limits.
//
// fail-closed everywhere: corrupt store / bad digest / any forbidden char /
// denylisted shape → reject, never a permissive fallback.

import crypto from 'crypto';

import { appConfigDb } from '../modules/database/index.js';
import { APP_ROOT } from './server-actions.js';
import { cleanSpawnEnv } from './command-board-custom.js';
import { canRoleRunRawExec } from './command-board-config.js';

/** app_config key holding the JSON array of pending raw commands (the queue). */
export const RAW_QUEUE_CONFIG_KEY = 'command_board_raw_queue';

// ── Caps (frozen, server-controlled — never owner/request input) ─────────────
/** Max length of a raw command string. */
export const MAX_RAW_COMMAND_LEN = 4096;
/**
 * Max number of newline-separated lines in a raw command (T-966). Multi-line
 * commands are allowed, but the WYSIWYG safety valve only works if the human
 * actually reads EVERY line before confirming — so the reviewable size is
 * bounded. 100 lines is the ceiling: it comfortably covers a pasted chat code
 * block (which, within the 4096-char length cap, averages ~40 chars/line), while
 * refusing a wall of text that no reviewer meaningfully reads. A script larger
 * than this belongs in a file, not the command board. Counted as (LF count + 1);
 * CR cannot inflate it because CR is rejected outright.
 */
export const MAX_RAW_COMMAND_LINES = 100;
/** Max number of pending raw rows in the queue at once. */
export const MAX_RAW_QUEUE = 20;
/** Foreground timeout for a raw exec (matches the custom-command cap). */
export const RAW_EXEC_TIMEOUT_MS = 120_000;
/** Per-stream captured-output cap returned to the client (bytes). */
export const MAX_RAW_OUTPUT_BYTES = 64 * 1024;

/**
 * Matches ONE forbidden display-forgery / control code point. Defined by Unicode
 * General_Category (`v`-flag set with the permitted whitespace subtracted)
 * instead of a range list that silently rots as Unicode grows — the exact failure
 * mode that let WORD JOINER, U+2028/2029 and the Unicode space block slip past the
 * old ranges. Covered classes, none of which a real command needs:
 *   • \p{Cc} — all C0/C1 controls + DEL, EXCEPT the two permitted layout controls
 *     TAB (U+0009) and LF (U+000A) which are set-subtracted below. Still caught,
 *     deliberately: CR (U+000D), VT (U+000B), FF (U+000C), NEL (U+0085), DEL,
 *     every other C0/C1. A CRLF paste therefore trips on its CR — rejected, not
 *     normalised — preserving WYSIWYG (see the header note on U+000D).
 *   • \p{Cf} — format chars: bidi ALM/LRM/RLM, embeddings/overrides
 *     (U+202A–202E), isolates (U+2066–2069), zero-width (ZWSP/ZWNJ/ZWJ), WORD
 *     JOINER U+2060, invisible math U+2061–2064, SOFT HYPHEN U+00AD, BOM U+FEFF,
 *     deprecated TAG chars, …
 *   • \p{Zl} / \p{Zp} — LINE (U+2028) / PARAGRAPH (U+2029) separators: they
 *     render as a break inside <pre> yet are NOT the LF the owner typed and are no
 *     bash statement separator ⇒ a visual line break the bytes don't contain. Only
 *     genuine LF (U+000A) is the permitted newline.
 *   • \p{Zs} — every Unicode space EXCEPT ordinary U+0020: NBSP U+00A0, the
 *     U+2000–200A block, U+202F, U+205F, U+3000.
 *   • U+FE00–FE0F variation selectors (category Mn — listed explicitly; they
 *     silently alter how the preceding glyph renders).
 * The ONLY whitespace permitted is ordinary space (U+0020), TAB (U+0009) and LF
 * (U+000A) — all three set-subtracted from the class above. Arabic letters (Lo)
 * and harakat/tashkeel (Mn) are in NO rejected class, so legitimate Arabic
 * (including multi-line) commands pass unharmed.
 */
const FORBIDDEN_CHAR_RE = /[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u{FE00}-\u{FE0F}]--[\t\n ]]/v;

/**
 * Returns the index (UTF-16 code-unit) + full code point of the FIRST forbidden
 * character in `text`, or null when the string is clean. Preserves the existing
 * error contract (`position` = UTF-16 index; `codePoint`).
 */
export function findForbiddenControlChar(text) {
  const m = FORBIDDEN_CHAR_RE.exec(text);
  if (!m) return null;
  return { index: m.index, codePoint: m[0].codePointAt(0) };
}

// ── Self-destruction denylist (B-197) ────────────────────────────────────────
//
// WHAT THIS IS — AND IS NOT. This is a GOVERNANCE guard-rail, not a security
// boundary. Raw exec is arbitrary shell by design: anyone able to queue a raw
// command can trivially evade any string matcher (base64|sh, a variable, a
// here-doc, a helper script). Claiming otherwise would be exactly the kind of
// comment-that-describes-a-defence-that-does-not-exist this module must avoid.
// Its ONE job is to stop the ACCIDENTAL, well-known, catastrophic paste — most
// of all `pm2 restart nassaj-dev`.
//
// WHY `pm2 restart` specifically is fatal here: this deployment runs with
// `treekill:false` + `kill_timeout=24h`. A bare `pm2 restart` closes port 3004
// and leaves the process `stopping` forever while any child Claude session is
// alive ⇒ an EXTENDED 502, twice observed (~3h each: 2026-06-27, 2026-06-30).
// The supported path is `bash scripts/safe-restart.sh --exec`, which detects
// live sessions/workflows and DEFERS instead of wedging the port.
//
// Obfuscation resistance is deliberately limited to the ACCIDENTAL forms:
// repeated spaces, quotes inside the token (p"m2"), backslash escapes, an
// absolute/relative path prefix (/usr/bin/pm2), an `env`/`sudo` prefix, and a
// leading pipeline/;/&&/subshell position. It does NOT resist a determined
// bypass, and it is NOT the thing that makes raw exec safe — human review is.

/** Message appended to every denial, pointing at the supported path. */
export const SAFE_RESTART_HINT = 'bash scripts/safe-restart.sh --exec';

/**
 * Normalizes a command for denylist matching ONLY (never for execution — the
 * executed bytes stay verbatim). Lower-cases, drops quote/backslash characters
 * used to split a token, strips leading path components off every token, folds
 * the now-permitted TAB/LF (T-966) into single spaces, and collapses runs of
 * spaces. CR still cannot appear — it is rejected by findForbiddenControlChar
 * before any command reaches here — so TAB and LF are the only extra whitespace
 * this must fold. Folding is intentional: it keeps `pm2<TAB>restart` and a
 * `pm2 \<LF> restart` line-continuation from evading the denylist (which errs
 * toward over-blocking; it is a governance rail, not a security boundary).
 */
export function normalizeForDenylist(command) {
  return String(command)
    .toLowerCase()
    .replace(/[\\'"`]/g, '')
    // strip a path prefix on any token: /usr/bin/pm2 → pm2, ./scripts/x → x
    .replace(/(^|[\s;&|(])(?:[\w.~-]*\/)+/g, '$1')
    // fold the permitted layout whitespace (TAB/LF) to a single space so a
    // denylisted verb split across lines/tabs still matches.
    .replace(/[\t\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * FROZEN denylist rules, matched against the normalized text. Each rule is a
 * (code, regex) pair; `code` is the symbolic error suffix returned to the client
 * and written to the audit trail.
 *
 * `PREFIX` allows the command word to sit at the start, after a separator
 * (; & | && ||, or — now that multi-line is allowed, T-966 — a newline, matched
 * via the leading `\s` branch), inside a subshell `(`/`$(`, or behind a wrapper
 * such as `env`, `sudo`, `nohup`, `time`, `command`, `exec`. (normalizeForDenylist
 * folds TAB/LF to spaces before matching, so `\s` covers them regardless.)
 */
const PREFIX = '(?:^|[;&|(]\\s*|\\$\\(\\s*|\\s)(?:(?:env|sudo|doas|nohup|time|command|exec|builtin)\\s+(?:[a-z_][\\w]*=\\S*\\s+)*)*';
/** Optional flags between an executable and its subcommand (pm2 --silent restart). */
const FLAGS = '(?:\\s+-{1,2}[a-z0-9][\\w-]*)*';

export const RAW_DENY_RULES = Object.freeze([
  // pm2 lifecycle verbs — the B-95 port-wedge family. `kill` takes down the pm2
  // daemon itself (strictly worse than restart), `del`/`delete` unregister the app.
  Object.freeze({
    code: 'pm2_lifecycle',
    re: new RegExp(`${PREFIX}pm2${FLAGS}\\s+(?:restart|reload|stop|delete|del|kill)\\b`),
  }),
  // systemctl service disruption (same class, host level).
  Object.freeze({
    code: 'systemctl_lifecycle',
    re: new RegExp(`${PREFIX}systemctl${FLAGS}\\s+(?:restart|stop|disable|kill|mask)\\b`),
  }),
  // SysV-style equivalent: `service <unit> restart|stop`.
  Object.freeze({
    code: 'service_lifecycle',
    re: new RegExp(`${PREFIX}service\\s+[\\w.@-]+\\s+(?:restart|stop)\\b`),
  }),
  // Build-class npm scripts rewrite the LIVE-SERVED dist/ + dist-server/ trees
  // (same reasoning as NPM_SCRIPT_DENYLIST in command-board-custom.js).
  Object.freeze({
    code: 'npm_build',
    re: new RegExp(`${PREFIX}npm${FLAGS}\\s+run(?:-script)?${FLAGS}\\s+(?:pre)?build\\b`),
  }),
  // Any kill-class verb aimed at this service by name.
  Object.freeze({
    code: 'kill_nassaj_dev',
    re: new RegExp(`${PREFIX}(?:pkill|killall|kill|fuser|skill)\\b[^;&|]*\\bnassaj-dev\\b`),
  }),
  // Broad kill of the runtime this server IS (killall node / pkill -f node).
  Object.freeze({
    code: 'kill_runtime',
    re: new RegExp(`${PREFIX}(?:pkill|killall)\\b[^;&|]*\\b(?:node|nodejs|pm2|pm2-runtime)\\b`),
  }),
]);

/**
 * Returns the matching denylist rule code for a command, or null when clean.
 * Pure. Exported for tests and for the route's audit metadata.
 */
export function findDenylistedCommand(command) {
  if (typeof command !== 'string') return null;
  const normalized = normalizeForDenylist(command);
  for (const rule of RAW_DENY_RULES) {
    if (rule.re.test(normalized)) return rule.code;
  }
  return null;
}

// ── Audit redaction (B-197, branch ٣) ───────────────────────────────────────
//
// THE PROBLEM. Every raw-exec attempt writes the FULL command to audit_log so an
// execution is never unlogged. But a raw command is arbitrary shell the owner
// typed, so it may carry an inline credential (`curl -H "Authorization: Bearer
// …"`, `PGPASSWORD=… psql`, `--token=…`). audit_log is an owner-only sink, but
// it is also a long-lived, exportable, backed-up one — so a secret pasted once
// lives there for 90 days. Redaction keeps the forensic value (which command
// shape ran, by whom, when) without the standing secret.
//
// HONEST SCOPE, stated so no future reader over-trusts this. It is a
// NAME-DIRECTED best-effort filter, not a secret detector: it masks values that
// are *labelled* as credentials. A bare secret with no telltale label (`curl
// https://host/AKIA…`) is NOT caught, and cannot be without unacceptable false
// positives. The load-bearing controls remain (a) the sink is owner-only and (b)
// the owner should not paste secrets inline. This only shrinks the blast radius.

/** Replacement written in place of a matched secret value. */
const REDACTED = '«redacted»';

/**
 * Frozen list of redaction rules. Each is a regex whose LAST capture group is
 * the secret value; everything before it (the label/flag) is preserved so the
 * audit entry still shows WHAT kind of credential was passed.
 */
const REDACTION_RULES = Object.freeze([
  // NAME=value assignments and --flag=value / --flag value forms whose name
  // looks like a credential. Value = up to the next space or shell separator.
  Object.freeze({
    re: /((?:^|[\s;&|(])(?:-{0,2})[\w.-]*(?:passwo?rd|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|credential|private[_-]?key|passphrase)[\w.-]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;&|)]+)/gi,
  }),
  // `--token VALUE` (space-separated flag form).
  Object.freeze({
    re: /((?:^|[\s;&|(])-{1,2}[\w.-]*(?:passwo?rd|passwd|secret|token|api[_-]?key|apikey|credential|passphrase)[\w.-]*\s+)("[^"]*"|'[^']*'|[^\s;&|)-][^\s;&|)]*)/gi,
  }),
  // HTTP bearer / basic credentials, with or without a surrounding quote.
  Object.freeze({
    re: /((?:bearer|basic)\s+)([\w./+=-]{8,})/gi,
  }),
  // PEM private key material pasted inline (here-doc / echo).
  Object.freeze({
    re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(?=-----END|$)/g,
  }),
]);

/**
 * Returns `command` with labelled credential VALUES masked, for the audit sink
 * only. NEVER used on the executed bytes — execution stays verbatim (WYSIWYG),
 * and the digest is always computed over the stored text, never over this.
 * Non-string input returns null so a caller cannot accidentally log `undefined`
 * as if it were a command.
 * @param {unknown} command
 * @returns {string|null}
 */
export function redactSecretsForAudit(command) {
  if (typeof command !== 'string') return null;
  let out = command;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.re, (_m, prefix) => `${prefix}${REDACTED}`);
  }
  return out;
}

/** sha256 (hex) over the UTF-8 bytes of a command string. */
export function computeDigest(command) {
  return crypto.createHash('sha256').update(command, 'utf8').digest('hex');
}

/**
 * Constant-time compare of a client-supplied hex digest against the expected
 * one. Rejects (false) any non-string / wrong-length / non-hex input BEFORE the
 * timing-safe compare (timingSafeEqual throws on unequal buffer lengths).
 */
export function isDigestMatch(supplied, expectedHex) {
  if (typeof supplied !== 'string' || supplied.length !== expectedHex.length) return false;
  if (!/^[0-9a-f]+$/.test(supplied)) return false;
  const a = Buffer.from(supplied, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Validates a raw command string. Pure; fail-closed. On success the value is the
 * VERBATIM command (never trimmed/rewritten — WYSIWYG) plus its digest. Multi-line
 * commands are permitted (LF/TAB only); CR → carriage_return_forbidden, an
 * over-line-cap command → too_many_lines.
 * @returns {{ok:true, value:{command:string, digest:string}} |
 *           {ok:false, error:string, position?:number, lineCount?:number,
 *            maxLines?:number}}
 */
export function validateRawCommand(command) {
  if (typeof command !== 'string') return { ok: false, error: 'invalid_command' };
  if (command.length === 0 || command.trim().length === 0) {
    return { ok: false, error: 'empty_command' };
  }
  if (command.length > MAX_RAW_COMMAND_LEN) {
    return { ok: false, error: 'command_too_long' };
  }
  // CR (U+000D) gets a DISTINCT, explanatory code before the generic scan: a CRLF
  // paste from Windows is the common cause and the owner should learn WHY it was
  // refused (and that a plain-LF re-paste fixes it). It is REJECTED, never
  // normalised — rewriting the bytes would break WYSIWYG. findForbiddenControlChar
  // would also catch it (defence in depth at execute), but with the generic code.
  const crIndex = command.indexOf('\r');
  if (crIndex !== -1) {
    return { ok: false, error: 'carriage_return_forbidden', position: crIndex };
  }
  const forbidden = findForbiddenControlChar(command);
  if (forbidden) {
    return { ok: false, error: 'forbidden_control_char', position: forbidden.index };
  }
  // Line cap (T-966): multi-line is allowed, but the reviewable size is bounded so
  // the human-review guarantee stays meaningful. Only LF separates lines here (CR
  // was rejected above), so lines = LF count + 1.
  const lineCount = (command.match(/\n/g)?.length ?? 0) + 1;
  if (lineCount > MAX_RAW_COMMAND_LINES) {
    return { ok: false, error: 'too_many_lines', lineCount, maxLines: MAX_RAW_COMMAND_LINES };
  }
  // Self-destruction denylist (B-197) — gate #1 of 2. The same check runs again
  // in prepareRawExecution so a row planted directly in the store (parallel
  // session / direct DB edit) is still refused at execution time.
  const denied = findDenylistedCommand(command);
  if (denied) {
    return { ok: false, error: `denied_command:${denied}`, rule: denied };
  }
  return { ok: true, value: { command, digest: computeDigest(command) } };
}

// ── Storage (app_config; JSON array). Single-process better-sqlite3 → the
// read-modify-write below has no await between read and write, so it is atomic
// w.r.t. this process (same discipline as command-board-custom's store). ───────

/** Reads + shape-filters the stored raw queue. fail-closed → []. */
function readQueue() {
  let parsed = null;
  try {
    const raw = appConfigDb.get(RAW_QUEUE_CONFIG_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null; // corrupt JSON → empty
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.command === 'string'
  );
}

function writeQueue(list) {
  appConfigDb.set(RAW_QUEUE_CONFIG_KEY, JSON.stringify(list));
}

/**
 * Inserts a validated raw command as a pending row. fail-closed on cap /
 * validation. Stores ONLY the verbatim command + metadata (never a digest field
 * that could drift from the text — the digest is always recomputed from the
 * stored bytes).
 * @returns {{ok:true, value:{id,command,digest,requestedBy,requestedAt}} |
 *           {ok:false, error:string, position?:number}}
 */
export function insertRawCommand({ command, requestedBy } = {}) {
  const v = validateRawCommand(command);
  if (!v.ok) return v;
  const list = readQueue();
  if (list.length >= MAX_RAW_QUEUE) {
    return { ok: false, error: 'too_many_commands' };
  }
  const row = {
    id: crypto.randomUUID(),
    command: v.value.command,
    requestedBy: typeof requestedBy === 'string' ? requestedBy.slice(0, 200) : null,
    requestedAt: new Date().toISOString(),
  };
  list.push(row);
  writeQueue(list);
  return {
    ok: true,
    value: {
      id: row.id,
      command: row.command,
      digest: v.value.digest,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
    },
  };
}

/** Public list for the owner review UI: verbatim command + its (recomputed) digest. */
export function listRawCommands() {
  return readQueue().map((e) => ({
    id: e.id,
    command: e.command,
    digest: computeDigest(e.command),
    requestedBy: typeof e.requestedBy === 'string' ? e.requestedBy : null,
    requestedAt: typeof e.requestedAt === 'string' ? e.requestedAt : null,
  }));
}

/** Returns a single stored raw row by id, or null. */
export function getRawCommand(id) {
  if (typeof id !== 'string') return null;
  return readQueue().find((e) => e.id === id) ?? null;
}

/** Deletes a raw row by id. Idempotent. */
export function deleteRawCommand(id) {
  const list = readQueue();
  const next = list.filter((e) => e.id !== id);
  const removed = next.length !== list.length;
  if (removed) writeQueue(next);
  return { removed };
}

/** Number of pending raw rows (for the cap / diagnostics). */
export function countRawCommands() {
  return readQueue().length;
}

/**
 * Builds the FIXED, secret-free spawn descriptor for a raw command. The command
 * is passed as a SINGLE argv element to `bash -c` — see the rationale note in the
 * route. Never interpolates anything else. Pure (no spawn).
 */
export function buildRawSpawn(command) {
  return {
    cmd: 'bash',
    // `bash -c <command>`: bash is the shell; spawn runs it with shell:false so
    // no SECOND shell tokenizes anything. `command` is argv[2] verbatim.
    args: ['-c', command],
    cwd: APP_ROOT,
    env: cleanSpawnEnv(),
    // detached:true puts bash in its OWN process group, whose id equals the
    // child's pid. That is what makes the timeout able to kill the whole tree
    // (`process.kill(-pid)`); without it a `sleep 999 &` / `nohup x &` inside the
    // command outlives the kill and runs unbounded and unaudited. The route owns
    // the kill — see killRawProcessTree in server/routes/system.js.
    detached: true,
    timeoutMs: RAW_EXEC_TIMEOUT_MS,
  };
}

/**
 * Verifies a raw row is safe+authentic to execute and returns its spawn
 * descriptor. This is the ONE function every execute path must pass through, so
 * it repeats — as real, reachable code, not as a comment — every gate the route
 * already applied:
 *   (a) the config gate (flag + role mode) via canRoleRunRawExec. The route's
 *       rawExecConfigGate runs first and splits the two refusal reasons for a
 *       clearer message; this call is the defence-in-depth copy that cannot be
 *       skipped by any future caller of prepareRawExecution.
 *   (b) the Trojan-Source scan (the row could have been written by a parallel
 *       session / direct DB edit that bypassed insert),
 *   (c) the self-destruction denylist (B-197), same reason,
 *   (d) the digest binding.
 * Pure w.r.t. spawn; reads the store. fail-closed: a missing/unknown `role`
 * fails canRoleRunRawExec, so omitting it can only DENY, never permit.
 * @param {string} id
 * @param {unknown} confirmationDigest
 * @param {string|undefined} role requester role — required for the config gate.
 * @returns {{ok:true, row, digest:string, spawn} |
 *           {ok:false, error:string, position?:number, rule?:string}}
 */
export function prepareRawExecution(id, confirmationDigest, role) {
  if (!canRoleRunRawExec(role)) {
    return { ok: false, error: 'config_denied' };
  }
  const row = getRawCommand(id);
  if (!row) return { ok: false, error: 'not_found' };
  const forbidden = findForbiddenControlChar(row.command);
  if (forbidden) {
    return { ok: false, error: 'forbidden_control_char', position: forbidden.index };
  }
  const denied = findDenylistedCommand(row.command);
  if (denied) {
    return { ok: false, error: `denied_command:${denied}`, rule: denied };
  }
  const digest = computeDigest(row.command);
  if (!isDigestMatch(confirmationDigest, digest)) {
    return { ok: false, error: 'digest_mismatch' };
  }
  return { ok: true, row, digest, spawn: buildRawSpawn(row.command) };
}
