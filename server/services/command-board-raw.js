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
// SCOPE CORRECTION (2026-07-29). The pm2 rule used to refuse EVERY pm2 lifecycle
// verb regardless of target, so `pm2 restart other-site` — a different app that
// cannot touch this process, this port, or this session — was blocked with the
// same message as the one command that genuinely wedges port 3004. That is not
// the accident this rail exists to prevent; it is the button not working. The
// rule now denies only what can hit THIS server (see isPm2LifecycleSelfSafe):
// self by name, `all`, a bare/numeric/glob target, an ecosystem file, and `pm2
// kill` (the daemon). A named third-party app runs. Everything unparseable still
// denies — fail-closed is unchanged, only the blast radius of the rule is.
//
// WHY `pm2 restart` on THIS app specifically is fatal here: this deployment runs with
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
//
// SCOPE CORRECTION 2 (2026-09-21, B-1277/B-1278/T-1816). Measured: the rail did
// not refuse the host-level forms of the same accident — `reboot`, `sudo
// reboot`, `poweroff`, `halt`, `shutdown -r now`, `init 6`, `telinit 0`; `loginctl
// terminate-user|kill-user|terminate-session|kill-session`; `systemctl [--user]
// exit|halt|isolate|reboot|poweroff|kexec|soft-reboot|emergency|rescue|
// daemon-reexec`; the conditional restarts `try-restart|reload-or-restart|
// condrestart|condstop`; and systemctl's own option grammar (`systemctl --
// restart x`, `--machine=…`, `-H host`). Three rules close it:
//   • host_power (fatal) — the power verbs, ONLY in command position.
//   • systemd_manager (fatal) — verbs that stop/replace the systemd manager,
//     and `start|restart <special>.target` reaching the same outcome.
//   • session_kill (discretionary) — the four loginctl terminate/kill verbs.
// systemctl_lifecycle additionally gains the alias/conditional verbs and a
// dedicated SYSTEMCTL_FLAGS grammar (systemctl's value-taking options);
// session_kill has its own LOGINCTL_FLAGS (loginctl's). The shared FLAGS used by pm2/npm is
// untouched. This is a PURE TIGHTENING: nothing HEAD denied is let through.
//
// Why a second normaliser (commandPositionNormalize). PREFIX has a bare `\s`
// branch and normalizeForDenylist folds LF into a space, so on the ordinary
// normalised text a word matches in ANY position — acceptable for `pm2` or
// `systemctl`, but `echo reboot`, `grep shutdown`, `git commit -m "… halt"` are
// daily commands. host_power therefore matches a copy that keeps statement
// boundaries: an LF becomes `;`, a backtick becomes `;`, inert quoted data
// becomes `_` (ANSI-C `$'…'` included, where `\'` does not close the span), an
// escaped letter/digit is that letter (`reb\oot` is `reboot`), any other
// escaped character (`\"`, `\'`, `\;` — plain characters in bash, not quotes
// or separators) becomes `_`, and a line continuation (`\`+LF) vanishes as in
// bash (`rebo\<LF>ot` is `reboot`). It is one scan with bash's quoting states,
// not a quote regex. The inserted `;` is for matching only — the executed bytes
// are never touched.
//
// Fatal vs discretionary, and why ORDER is load-bearing. findDenylistedCommand
// reports the FIRST matching rule, and the client tells the owner a fatal
// refusal apart from a discretionary one by that code. So every fatal rule
// (this server/host goes down) precedes every discretionary one (a named unit or
// process is disrupted); `pkill -f x; kill -9 -1` must report kill_group, not
// kill_by_pattern. A client-side guard verifies the order by reading this source.
//
// ReDoS safety. The grammars are written so that a token has one reading where
// a repeat is possible: an option VALUE (HOST_POWER_VAL, optionSepValue) cannot
// start with `-` (never the next flag), a HOST_POWER_VAL is never a
// wrapper/verb word nor a `NAME=val` assignment, a systemd tool's value is never
// that tool's own name, and — like every flag/assignment token — no value
// crosses a separator (`;` `&` `|` `(` `)`). A token that could run through `;`
// let every command-position start re-read the rest of the input (quadratic —
// measured 9.3ms at 8192 chars in round 1). Likewise the `case` branch of
// HOST_POWER_POS takes exactly `;;`, not `;[\s;]*` (round 2: ×14.7 growth for
// ×4 input), and its `in` must be a word of its own (round 4: `\bin` inside
// `!in`/`in-`/`=in` grew ×13.8–×16.2); and `start|restart … <special>.target`
// looks at most SYSTEMD_TARGET_REACH chars ahead (round 4: unbounded, ×10.9).
// The redundant wrapper chain in PREFIX (see PREFIX) was dropped. What is
// claimed is ONLY what the test measures: for each unit in its REDOS_UNITS list
// (repeated to the length cap, with each of three non-matching tails), a whole
// findDenylistedCommand call at 4096 chars stays under 10ms AND under 8× the
// time at 1024 (linear growth is ×4, quadratic ×16). Inputs outside that list
// are covered by no proof here, only by the randomised measurement of each
// review round.
//
// No exemption by TARGET — deferred to T-1817. A remote-selector exemption
// (`systemctl -H otherhost …`) and a `--user` exemption are one class: an
// exemption decided by what the command is aimed at. Both are deferred to
// T-1817, because on a raw string they fail OPEN. Measured on the remote one
// (round 2, differential fuzz vs HEAD: 1107 commands HEAD denied passed): the
// selector was swallowed across an LF (`systemctl restart nassaj<LF>-H
// other`), a comment (`… nassaj # -H other`) or a backtick substitution as
// the value (-H `hostname`), all of which run LOCALLY in bash; and "local" has endless spellings
// (`ip6-localhost`, `2130706433`, any interface address). The accepted price:
// `systemctl -H otherhost restart nginx` DENIES (systemctl_lifecycle, a
// discretionary refusal) and is run from a terminal instead.
//
// Left open ON PURPOSE (a string matcher cannot close them without breaking
// ordinary commands, and this is not a security boundary): `bash -c "reboot"`,
// `sh -c …`, `eval …`, `kexec -e`, `echo b > /proc/sysrq-trigger`, `ssh host
// reboot`. And `systemctl --user <verb> <unit>` on an unrelated user unit is
// still denied as systemctl_lifecycle — a known false positive (T-1817, above):
// exempting `--user` on the raw text would also launder `…; /usr/bin/systemctl
// --user stop cloudflared`, which the path strip and chaining make impossible
// to tell apart without a real per-invocation parse.

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
  return foldForDenylist(String(command));
}

/**
 * The shared tail of both normalisers (DRY): lower-case, drop the characters
 * used to split a token, strip path prefixes, fold TAB/LF runs and repeated
 * spaces, trim. Matching only — never applied to the executed bytes.
 */
function foldForDenylist(text) {
  return text
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

/** A character that, if it were live, could put a word in command position. */
const SHELL_POSITION_CHAR_RE = /[\s;&|()]/;

/**
 * Masks a quoted span that is inert DATA (it holds a separator/space, so it can
 * only be an argument such as a commit message or a grep pattern) to `_`. A
 * double-quoted span carrying `$(` or a backtick is kept: bash still runs that
 * substitution inside double quotes (its LFs become `;` like any other LF).
 */
function maskInertQuotedSpan(span) {
  if (!SHELL_POSITION_CHAR_RE.test(span)) return span;
  if (span[0] === '"' && /\$\(|`/.test(span)) return span.replace(/\n/g, ';');
  return '_';
}

/**
 * Index of the quote closing the span opened at `start`, or -1 when it is
 * unterminated. With `backslashEscapes` (double quotes, ANSI-C `$'…'`) a
 * backslash escapes the next character; otherwise (single quotes) nothing is
 * special — bash: `'\'` is a complete span.
 */
function quotedSpanEnd(text, start, backslashEscapes) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === quote) return i;
    if (backslashEscapes && text[i] === '\\') i += 1;
  }
  return -1;
}

/**
 * What an unquoted `\x` becomes: a line continuation (`\`+LF) vanishes as in
 * bash (`rebo\<LF>ot` is `reboot`); an escaped letter/digit is that same
 * character (`reb\oot` is `reboot`); anything else — an escaped quote, `;`,
 * space, backslash — is one ordinary non-separator character, `_`.
 */
function unquotedEscape(next) {
  if (next === '\n') return '';
  return /^[a-z0-9]$/i.test(next ?? '') ? next : '_';
}

/**
 * One left-to-right pass with bash's quoting states, outside any quote:
 *   • `\x` → unquotedEscape (an escaped quote is an ordinary character, NOT a
 *     quote opener);
 *   • `$'…'` (ANSI-C quoting, where `\'` does NOT close the span), `'…'` and
 *     `"…"`: a terminated span → maskInertQuotedSpan (the `$` is dropped); an
 *     unterminated quote is kept as a plain character and scanning goes on
 *     (bash would refuse to run it at all, so reading on can only over-block);
 *   • LF → `;` (a real statement separator).
 * Linear: every character is visited once, and a failed quote search can only
 * happen once per quote kind — for `'`/`"` no later partner exists by
 * definition; an unterminated `$'` switches ANSI-C recognition off for the rest
 * (its escape phase could differ at a later `$'`, so it is not re-scanned).
 */
function maskShellQuoting(text) {
  let out = '';
  let ansiCOpen = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const ansiC = ansiCOpen && ch === '$' && text[i + 1] === "'";
    if (ch === '\\') {
      out += unquotedEscape(text[i + 1]);
      i += 1;
    } else if (ansiC || ch === "'" || ch === '"') {
      const open = ansiC ? i + 1 : i;
      const end = quotedSpanEnd(text, open, ansiC || ch === '"');
      if (end < 0) {
        out += ch;
        if (ansiC) ansiCOpen = false;
      } else {
        out += maskInertQuotedSpan(text.slice(open, end + 1));
        i = end;
      }
    } else {
      out += ch === '\n' ? ';' : ch;
    }
  }
  return out;
}

/**
 * Second normaliser for the `host_power` rule ONLY (B-1277, T-1816), built from
 * the ORIGINAL text, for matching only — the executed bytes are never touched.
 * Unlike normalizeForDenylist it keeps statement boundaries visible, so a rule
 * can require the verb to sit in COMMAND POSITION rather than anywhere:
 *   1. maskShellQuoting: continuations joined, escapes resolved, inert quoted
 *      spans (`'…'`, `"…"`, `$'…'`) masked, LF → `;`;
 *   2. a backtick becomes `;` (its body is a command in command position);
 *   3. the normalizeForDenylist fold.
 * The inserted `;` exists only in the matching copy.
 */
export function commandPositionNormalize(command) {
  return foldForDenylist(maskShellQuoting(String(command)).replace(/`/g, ';'));
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
 *
 * T-1816: the wrapper chain that used to follow these branches
 * (`(?:(?:env|sudo|…)\s+(?:NAME=val\s+)*)*`) is gone because it was REDUNDANT
 * and it was the only super-linear cost in the denylist. Every wrapper and
 * assignment ends in whitespace, so the command word behind any chain is always
 * preceded by a space that the bare `\s` branch already matches: `sudo pm2 …`,
 * `env A=1 pm2 …` deny exactly as before (pinned in the test file). But with
 * the chain, every space inside a long run of wrappers re-scanned the run to
 * its end: quadratic, ~4ms per rule and 52ms per call at the 4096-char cap on
 * `exec command time …` (measured on the pre-T-1816 source).
 */
const PREFIX = '(?:^|[;&|(]\\s*|\\$\\(\\s*|\\s)';
/**
 * The port this server is actually serving on — read once, so the port-directed
 * kill rule (B-322) protects the LIVE port rather than a hardcoded guess. The
 * 3004 fallback matches the fleet default used when PORT is unset.
 */
const SERVICE_PORT = String(parseInt(process.env.PORT ?? '', 10) || 3004);
/** Optional flags between an executable and its subcommand (pm2 --silent restart). */
const FLAGS = '(?:\\s+-{1,2}[a-z0-9][\\w-]*)*';
/**
 * An option given `--opt=value` or as a separate value token: the value cannot
 * start with `-` (it never competes with the next flag), stops at every shell
 * separator/redirect (it never runs into the next statement), and is never the
 * bare name of the tool whose grammar it is part of — else in `systemctl -h
 * systemctl -h …` every invocation start would run its option chain to the end
 * (quadratic, measured ×13.5 growth for ×4 input). The exclusion is PER TOOL
 * (see systemdToolFlags): excluding `loginctl` from systemctl's values too made
 * `systemctl -H loginctl restart x` pass (measured, round 4). A value flag still
 * reads as a plain flag, so the verb right after it is seen either way.
 */
const OPTION_EQ_VALUE = '(?:=[^\\s;&|()<>]+)?';
/** The separate-token value of one of `tool`'s value options (see above). */
function optionSepValue(tool) {
  return `\\s+(?!${tool}(?![^\\s;&|()<>]))[^\\s;&|()<>-][^\\s;&|()<>]*`;
}
/**
 * Builds a systemd tool's option grammar: the `--` end-of-options marker, each
 * option in `valueFlags` with its value as a separate token (never the word
 * `tool` itself), and any `-x`/`--opt[=value]`. Lower-case because the text is
 * normalised (`-H` arrives as `-h`, `-P` as `-p`). A value flag may also read as
 * a plain flag, so a verb right after it (`-h restart x`) is still seen.
 */
function systemdToolFlags(tool, valueFlags) {
  return `(?:\\s+(?:--|(?:${valueFlags})${optionSepValue(tool)}|-{1,2}[a-z0-9][\\w-]*${OPTION_EQ_VALUE}))*`;
}
/**
 * systemctl's own option grammar (B-1278), kept SEPARATE from FLAGS (shared with
 * pm2/npm). Its value-taking options, from `systemctl --help` (systemd 257):
 * -C/--capsule, -H/--host, -M/--machine, -t/--type, --state, -p/--property, -P,
 * --job-mode, --check-inhibitors, --kill-whom, --kill-value, -s/--signal,
 * --what, --message, --legend, --root, --image, --image-policy, --preset-mode,
 * -n/--lines, -o/--output, --boot-loader-menu, --boot-loader-entry,
 * --reboot-argument, --timestamp, --drop-in, --when. Each is read with its
 * value, so the verb after it is still caught — `systemctl -s SIGKILL kill x`,
 * `systemctl --when +5m reboot`, `systemctl -H otherhost restart nginx` all
 * DENY (no remote exemption, see SCOPE CORRECTION 2).
 */
const SYSTEMCTL_FLAGS = systemdToolFlags(
  'systemctl',
  '-c|--capsule|-h|--host|-m|--machine|-t|--type|--state|-p|--property|--job-mode|'
    + '--check-inhibitors|--kill-whom|--kill-value|-s|--signal|--what|--message|--legend|'
    + '--root|--image-policy|--image|--preset-mode|-n|--lines|-o|--output|--boot-loader-menu|'
    + '--boot-loader-entry|--reboot-argument|--timestamp|--drop-in|--when',
);
/**
 * loginctl's value-taking options, from `loginctl --help` (systemd 257):
 * -H/--host, -M/--machine, -p/--property, -P, -s/--signal, --kill-whom,
 * -n/--lines, -o/--output, --json. `-p` covers both -p and -P after lowering.
 */
const LOGINCTL_FLAGS = systemdToolFlags(
  'loginctl',
  '-h|--host|-m|--machine|-p|--property|-s|--signal|--kill-whom|-n|--lines|-o|--output|--json',
);

// ── host_power (B-1277): command-position grammar, on commandPositionNormalize ──
/** Every word a wrapper or a power verb can be; a wrapper's option VALUE is never one. */
const HOST_POWER_WORDS =
  '(?:sudo|doas|env|nohup|timeout|nice|exec|command|time|xargs|reboot|poweroff|halt|shutdown|telinit|init)(?![\\w.-])';
/** One shell word as these rules see it: it ends at whitespace or any separator. */
const HOST_POWER_TOKEN = '[^\\s;&|()]';
/**
 * An option value. It cannot start with `-` (never competes with the next
 * flag), cannot cross a separator (`;`, `&`, `|`, `(`, `)`), and is never a
 * wrapper/verb word NOR a `NAME=val` assignment — so every token has exactly
 * one reading: value, assignment, or the next wrapper/verb. (Letting `a=1` be
 * both a value and an assignment made `sudo -u a=1 ` repeated EXPONENTIAL —
 * measured: >10s at 1024 chars.) A leading `$` is allowed (`sudo -u $USER
 * reboot`); `$(` still stops at `(`.
 */
const HOST_POWER_ASSIGN_HEAD = '[a-z_]\\w*=';
const HOST_POWER_VAL = `(?!${HOST_POWER_WORDS})(?!${HOST_POWER_ASSIGN_HEAD})[^\\s;&|()-]${HOST_POWER_TOKEN}*`;
const HOST_POWER_FLAG = `-${HOST_POWER_TOKEN}+`;
/** `NAME=value` — a shell assignment prefix, standalone or after sudo/doas/env. */
const HOST_POWER_ASSIGN = `${HOST_POWER_ASSIGN_HEAD}${HOST_POWER_TOKEN}*`;
/**
 * Command position: start, after ; & | ( or $(, or after a `case` pattern
 * (`in x)` / `;; x)`, one pattern token) — deliberately NO bare `\s` branch and
 * no bare `)` (`echo $(date) reboot` is an argument, not a command).
 * `in` must be a WORD of its own: preceded by start/space/separator and followed
 * by space, `;` or `(`. `\bin` accepted `in` at any word boundary inside a
 * token (`!in`, `in-`, `=in`, `<in`) and then scanned that token to its end for
 * `)` — quadratic, measured ×13.8–×16.2 growth for ×4 input (round 4). `[\s;]*`
 * after it admits the LF (now `;`) of a multi-line `case "$1" in<LF> now) …`.
 */
const HOST_POWER_POS =
  `(?:^|[;&|(]\\s*|\\$\\(\\s*|(?:(?<![^\\s;&|(])in(?=[\\s;(])[\\s;]*|;;\\s*)\\(?[^;&()\\s]+\\s*\\)\\s*)(?:(?:then|do|else|elif|\\{|!)\\s+)*`;
/**
 * The wrapper chain. `NAME=val` is ONE chain alternative, used both in command
 * position and after sudo/doas/env; env therefore has no assignment list of its
 * own — two places accepting the same token would make the chain ambiguous.
 */
const HOST_POWER_WRAPPER = [
  `sudo(?:\\s+${HOST_POWER_FLAG}(?:\\s+${HOST_POWER_VAL})?)*`,
  `doas(?:\\s+${HOST_POWER_FLAG}(?:\\s+${HOST_POWER_VAL})?)*`,
  `env(?:\\s+${HOST_POWER_FLAG}(?:\\s+${HOST_POWER_VAL})?)*`,
  HOST_POWER_ASSIGN,
  'nohup',
  `timeout(?:\\s+${HOST_POWER_FLAG}(?:\\s+${HOST_POWER_VAL})?)*\\s+${HOST_POWER_VAL}`,
  `nice(?:\\s+-n\\s*${HOST_POWER_TOKEN}+|\\s+-\\d+)?`,
  'exec',
  'command',
  'time',
  `xargs(?:\\s+${HOST_POWER_FLAG})*`,
].join('|');
/** `shutdown -c` (cancel) is excluded per MATCH, not per command: `shutdown -c; reboot` still denies. */
const HOST_POWER_VERB =
  '(?:(?:reboot|poweroff|halt)(?![\\w.-])|shutdown(?![\\w.-])(?!\\s+-c\\b)|(?:tel)?init\\s+[0-6s]\\b)';

/** systemd manager verbs that stop/replace the whole manager (and with it every unit). */
const SYSTEMD_MANAGER_VERBS =
  '(?:exit|isolate|reboot|poweroff|halt|kexec|soft-reboot|emergency|rescue|default|daemon-reexec|switch-root|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|sleep)';
/** The same outcome reached by starting a special target. */
const SYSTEMD_SPECIAL_TARGETS =
  '(?:reboot|poweroff|halt|kexec|soft-reboot|rescue|emergency|exit|shutdown|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|sleep)';
/** How far past `start|restart` a special target is looked for (a bound keeps it linear). */
const SYSTEMD_TARGET_REACH = 256;

/**
 * pm2 app names that ARE this server. A lifecycle verb aimed at one of these is
 * the B-95 self-destruction; aimed at anything else it is an ordinary operation.
 * `process.env.name` is what pm2 sets on the app it spawned, so it is the
 * runtime-accurate name on a node that renamed the app; it can only ADD a denied
 * name, never remove the hard-coded one.
 */
export const SELF_PM2_APPS = Object.freeze(
  [...new Set(['nassaj-dev', String(process.env.name ?? '').toLowerCase()])].filter(
    (n) => /^[a-z0-9][a-z0-9._@-]*$/.test(n)
  )
);

/**
 * One pm2 lifecycle invocation inside the NORMALIZED text: the verb, then every
 * following token up to a shell separator or redirect. Global — a chained command
 * can hold more than one, and every one of them must clear the check.
 */
const PM2_LIFECYCLE_G = new RegExp(
  `${PREFIX}pm2${FLAGS}\\s+(restart|reload|stop|delete|del|kill)\\b((?:\\s+[^\\s;&|)<>]+)*)`,
  'g'
);

/** Ecosystem/config file suffixes: the target is a FILE listing apps, so it can include us. */
const PM2_CONFIG_FILE_RE = /\.(?:c|m)?js$|\.json$|\.ya?ml$|\.config$/;

/**
 * True when `token` is provably a pm2 app OTHER than this server. Fail-closed:
 * anything it cannot read as a plain third-party app name is false.
 * Refused: `all`, a numeric pm2 id (opaque — id 1 IS nassaj-dev here), a glob or
 * `/regex/` selector, an ecosystem file, any name containing a self name, and any
 * token carrying shell syntax ($, *, ?, quotes already stripped by normalisation).
 */
function isOtherPm2App(token) {
  if (!/^[a-z0-9][a-z0-9._@-]*$/.test(token)) return false;
  if (token === 'all' || /^\d+$/.test(token)) return false;
  if (PM2_CONFIG_FILE_RE.test(token)) return false;
  return !SELF_PM2_APPS.some((self) => token.includes(self));
}

/**
 * True when EVERY pm2 lifecycle invocation in the command names only third-party
 * apps — i.e. the command cannot take this server down and the rule should not
 * fire. `pm2 kill` is never exempt: it stops the daemon, which stops us too.
 * Fail-closed: no parseable invocation, no target, or one unreadable target ⇒ false.
 */
function isPm2LifecycleSelfSafe(normalized) {
  const invocations = [...normalized.matchAll(PM2_LIFECYCLE_G)];
  if (invocations.length === 0) return false;
  return invocations.every(([, verb, rest]) => {
    if (verb === 'kill') return false;
    // Flags (`--update-env`, `-s`) carry no target; the app names are the rest.
    const targets = rest.trim().split(' ').filter((t) => t && !t.startsWith('-'));
    if (targets.length === 0) return false; // bare `pm2 restart` → ambiguous
    return targets.every(isOtherPm2App);
  });
}

export const RAW_DENY_RULES = Object.freeze([
  // ── FATAL ── Load-bearing ORDER: findDenylistedCommand returns the FIRST
  // matching rule, so every fatal rule (self-destruction of this server or its
  // host) must precede every discretionary one — otherwise a chained command
  // (`pkill -f x; kill -9 -1`) is reported under the milder code. A client-side
  // guard (src/, frontend-dev) verifies this order by READING THIS SOURCE: keep
  // every rule's `code: '<name>'` in single quotes inside this array.
  // pm2 lifecycle verbs — the B-95 port-wedge family. `kill` takes down the pm2
  // daemon itself (strictly worse than restart), `del`/`delete` unregister the app.
  // `exempt` narrows this to targets that can actually hit US (see the SCOPE
  // CORRECTION note above): a lifecycle verb on another app is allowed through.
  Object.freeze({
    code: 'pm2_lifecycle',
    re: new RegExp(`${PREFIX}pm2${FLAGS}\\s+(?:restart|reload|stop|delete|del|kill)\\b`),
    exempt: isPm2LifecycleSelfSafe,
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
  // B-322 (review pass): `kill` aimed at a process GROUP or at everything —
  // `kill -9 -1` reaps every process this uid owns, production included. It
  // passed every rule above because it names nothing. The signature is a
  // negative target AFTER a signal flag (or after `--`): in `kill -9 -1` the
  // `-9` is the signal and the `-1` is "every process". A lone leading
  // `-<n>` is just the signal, so `kill -0 999` (the liveness probe
  // memory-guard.sh uses) and `kill -1 555` stay clean.
  // The signal may be given as a separate VALUE token (`kill -s TERM -1`,
  // `kill -n 9 -1`), so a flag's argument is skipped too — the first cut
  // required the flags to be adjacent and let both forms through.
  Object.freeze({
    code: 'kill_group',
    // The `+` is load-bearing: at least one token must precede the negative
    // target, so the LEADING `-<n>` of `kill -0 999` / `kill -1 555` is read as
    // the signal it is. Relaxing it to `*` denied both — measured.
    re: new RegExp(`${PREFIX}kill\\b(?:\\s+-{1,2}\\w+|\\s+--|\\s+(?:sig)?[a-z]+|\\s+\\d+)+\\s+-\\d+(?:\\s|$)`),
  }),
  // B-322: mass/session kill utilities — killall5 and skill(1) signal whole
  // sessions/users and have no narrow form worth allowing from a queue.
  Object.freeze({
    code: 'kill_mass',
    re: new RegExp(`${PREFIX}(?:killall5|skill)\\b`),
  }),
  // B-322 (review pass): killing the LIVE SERVICE PORT by port number is
  // self-destruction wearing the recommended-alternative's clothes. Only this
  // server's own port is denied — `fuser -k <dev port>/tcp` stays the endorsed
  // way to stop a worktree dev server.
  //
  // `raw: true` is REQUIRED here and nowhere else: normalizeForDenylist strips
  // path-like prefixes, so `fuser -k 3004/tcp` normalises to `fuser -k tcp`
  // and the port — the entire point of the rule — is gone before matching.
  // Only the KILLING forms: `fuser -k` and `lsof -t` (pid-only output, whose
  // single purpose is to be piped into a kill). Read-only diagnostics on the
  // same port — `lsof -i :3004`, `fuser 3004/tcp` — stay allowed: denying the
  // tools an operator reaches for DURING an incident was a false positive in
  // the first cut of this rule.
  Object.freeze({
    code: 'kill_service_port',
    raw: true,
    re: new RegExp(
      `(?:^|[;&|(]\\s*|\\s)(?:fuser\\b[^;&|]*\\s-[a-z]*k|lsof\\b[^;&|]*\\s-[a-z]*t)[^;&|]*\\b${SERVICE_PORT}\\b`,
    ),
  }),
  // B-1277: host power — reboot / poweroff / halt / shutdown / init N — only in
  // COMMAND POSITION, judged on commandPositionNormalize (norm field), so
  // `echo reboot`, `grep shutdown` and commit messages stay clean.
  Object.freeze({
    code: 'host_power',
    norm: 'commandPosition',
    re: new RegExp(`${HOST_POWER_POS}(?:(?:${HOST_POWER_WRAPPER})\\s+)*${HOST_POWER_VERB}`),
  }),
  // B-1278: verbs that stop or replace the systemd MANAGER itself (system or
  // --user), taking every unit — this server's included — with it; plus the
  // same outcome reached by starting a special target. No selector is exempt.
  // The target is looked for within SYSTEMD_TARGET_REACH chars of the verb: an
  // unbounded `[^;&|]*?` scanned to the segment's end from every `systemctl`
  // (quadratic, measured ×10.9 growth for ×4 input, round 4). Judged on BOTH
  // copies (`either`): the statement-preserving copy keeps a quoted multi-word
  // option value one token (`--message "planned upgrade" reboot` →
  // `--message _ reboot`), and the plain copy catches a backtick-substituted
  // value (`-H \`hostname\` daemon-reexec`), which the positional copy splits
  // at the `;` it turns the backtick into — the very form SCOPE CORRECTION 2
  // cites as running LOCALLY. Price, accepted fail-closed: the plain copy reads
  // a quoted phrase as value + verb, so `--message "planned reboot" status x`
  // is denied as fatal too (pinned in the scope test).
  Object.freeze({
    code: 'systemd_manager',
    norm: 'either',
    re: new RegExp(
      `${PREFIX}systemctl${SYSTEMCTL_FLAGS}\\s+(?:${SYSTEMD_MANAGER_VERBS}\\b|(?:start|restart)[^;&|]{0,${SYSTEMD_TARGET_REACH}}?\\b${SYSTEMD_SPECIAL_TARGETS}\\.target\\b)`,
    ),
  }),
  // ── DISCRETIONARY ── Load-bearing ORDER (see FATAL above): these deny a
  // command that is disruptive but aimed at a named target; they must all come
  // after the fatal block. Same single-quoted `code: '<name>'` convention.
  // systemctl service disruption (same class, host level). B-1278: own flag
  // grammar (SYSTEMCTL_FLAGS) and the conditional/alias restart verbs; no
  // selector is exempt (the remote exemption is deferred to T-1817).
  Object.freeze({
    code: 'systemctl_lifecycle',
    norm: 'either',
    re: new RegExp(`${PREFIX}systemctl${SYSTEMCTL_FLAGS}\\s+(?:restart|stop|disable|kill|mask|try-restart|reload-or-restart|try-reload-or-restart|reload-or-try-restart|condrestart|condstop|force-reload|freeze)\\b`),
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
  // B-322: pattern-directed kill. `pkill -f` / `pgrep -f` match the FULL argv of
  // every process on the host, so a generic pattern reaps unrelated processes
  // wholesale — `pkill -f "server/index.js"` took six processes including the
  // production server in the 2026-07-29 fleet-node incident, and carried
  // neither "nassaj-dev" nor "node", so both rules above waved it through.
  // No -f pattern is safe to fire blind: kill by port (fuser -k <port>/tcp)
  // or by an explicit pid instead. The flag is caught anywhere in the same
  // shell segment, clustered or not (-f, -ef, -af …).
  Object.freeze({
    code: 'kill_by_pattern',
    re: new RegExp(`${PREFIX}pkill\\b[^;&|]*\\s-[a-z]*f\\b`),
  }),
  // B-322 (review pass): the same reap without the word `pkill` — a
  // pattern-matched pid list piped into a kill. Judged across the whole command
  // because the pipe is precisely what joins the two halves. A bare `pgrep -f`
  // is NOT denied: listing is the diagnostic an operator needs mid-incident,
  // and denying it was a false positive in the first cut.
  Object.freeze({
    code: 'kill_by_pattern',
    re: new RegExp(`${PREFIX}pgrep\\b[^;&|]*\\s-[a-z]*f\\b[\\s\\S]*\\bkill\\b`),
  }),
  // B-322 (review pass): name-directed kill with NO pattern flag — `killall
  // vite`, `pkill vite`. Narrower than -f (it matches the executable name, not
  // the whole argv) but still name-directed on a shared-uid host, and the
  // agent-side guard blocks it, so the sanctioned rail must not be the laxer
  // of the two.
  Object.freeze({
    code: 'kill_by_name',
    re: new RegExp(`${PREFIX}(?:pkill|killall)\\b`),
  }),
  // B-1278: ending a login session/user kills every process in it — on this
  // host that can be the uid running this server. Discretionary: it names a
  // target, and the listing verbs (list-sessions, show-user) stay allowed.
  Object.freeze({
    code: 'session_kill',
    re: new RegExp(`${PREFIX}loginctl${LOGINCTL_FLAGS}\\s+(?:terminate-user|kill-user|terminate-session|kill-session)\\b`),
  }),
]);

/**
 * Returns the matching denylist rule code for a command, or null when clean.
 * A rule may carry an `exempt(normalized)` predicate that clears a match it
 * cannot justify (see the pm2 rule); the predicate is fail-closed, so an
 * unreadable command keeps the denial.
 * Pure. Exported for tests and for the route's audit metadata.
 */
export function findDenylistedCommand(command) {
  if (typeof command !== 'string') return null;
  const normalized = normalizeForDenylist(command);
  const views = { normalized, lowered: null, positional: null };
  for (const rule of RAW_DENY_RULES) {
    if (!ruleHaystacks(rule, command, views).some((text) => rule.re.test(text))) continue;
    if (rule.exempt && rule.exempt(normalized)) continue;
    return rule.code;
  }
  return null;
}

/**
 * The text(s) a rule is matched against, computed lazily into `views`:
 *   • `raw` — the un-normalised text: normalisation is lossy by design (it
 *     folds paths and drops quotes), which is right for verb-shaped rules but
 *     destroys the operand some rules exist to see (see kill_service_port);
 *   • `norm: 'commandPosition'` — the statement-preserving copy
 *     (commandPositionNormalize / host_power);
 *   • `norm: 'either'` — both copies; a match on either denies. systemctl_lifecycle
 *     and systemd_manager use it because normalizeForDenylist drops quotes, so a multi-word option
 *     value (`systemctl -p "A B" stop x`) reads as two tokens and hides the
 *     verb; the positional copy masks that span to `_`. Matching the normalised
 *     copy too keeps every denial HEAD made (pure tightening);
 *   • otherwise the normalised text.
 */
function ruleHaystacks(rule, command, views) {
  if (rule.raw) {
    views.lowered ??= String(command).toLowerCase();
    return [views.lowered];
  }
  if (!rule.norm) return [views.normalized];
  views.positional ??= commandPositionNormalize(command);
  return rule.norm === 'either' ? [views.normalized, views.positional] : [views.positional];
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

// ── Execution history (T-1684) ───────────────────────────────────────────────
//
// WHY IT EXISTS. Executing a raw row DELETES it from the queue before spawning
// (the anti-double-run claim), and the outcome existed only in the HTTP response
// to the browser that pressed the button. Close the tab, or press it from a
// phone, and there was no way to learn whether the command ran. Every terminal
// raw execution — exit 0, non-zero, timeout, spawn failure, process error —
// therefore writes one bounded record here, readable for an hour.
//
// WHAT THIS DOES NOT CHANGE (threat model, ADR-070). History is READ-ONLY: no
// route re-runs a command from it, and the record is not a queue row, so the
// WYSIWYG/digest chain is untouched — nothing here can ever reach `bash -c`.
// It is gated by the SAME 'raw' tier as the queue itself.
//
// SECRETS. The stored copy of the command is passed through
// redactSecretsForAudit, exactly like the audit copy, and so are the output
// tails: this store is long-lived-ish, owner-readable and exported with the
// database, and a raw command may carry an inline credential. The text is
// otherwise the SAME text that was queued — never re-quoted or normalised.

/** app_config key holding the JSON array of raw execution records. */
export const RAW_HISTORY_CONFIG_KEY = 'command_board_raw_history';
/** Hard cap on retained records (newest kept) — bounds the app_config row. */
export const MAX_RAW_HISTORY = 50;
/** Retention: a record is dropped one hour after the execution finished. */
export const RAW_HISTORY_RETENTION_MS = 60 * 60 * 1000;
/** Per-stream stored output tail (bytes). The LAST bytes are what diagnoses. */
export const MAX_RAW_OUTPUT_TAIL_BYTES = 2048;

/** Valid outcome verdicts. 'unknown' = the command ran but told us nothing usable. */
const RAW_OUTCOMES = Object.freeze(['success', 'failure', 'unknown']);

/**
 * Last ≤ MAX_RAW_OUTPUT_TAIL_BYTES bytes of `text`, cut on a character boundary
 * (leading UTF-8 continuation bytes are skipped so a truncated tail never opens
 * with U+FFFD), then secret-redacted. Non-string input → ''.
 */
function outputTail(text) {
  if (typeof text !== 'string' || text === '') return '';
  const buf = Buffer.from(text, 'utf8');
  let start = Math.max(0, buf.length - MAX_RAW_OUTPUT_TAIL_BYTES);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return redactSecretsForAudit(buf.subarray(start).toString('utf8')) ?? '';
}

/** Reads + shape-filters the stored history. fail-closed → []. */
function readHistory() {
  let parsed = null;
  try {
    const raw = appConfigDb.get(RAW_HISTORY_CONFIG_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null; // corrupt JSON → empty
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e) => e && typeof e === 'object' && typeof e.id === 'string'
      && typeof e.command === 'string' && typeof e.executedAt === 'string'
      && RAW_OUTCOMES.includes(e.outcome)
  );
}

/** Drops expired records and enforces the cap (newest first on disk). */
function pruneHistory(list, now = Date.now()) {
  return list
    .filter((e) => {
      const at = Date.parse(e.executedAt);
      return Number.isFinite(at) && now - at < RAW_HISTORY_RETENTION_MS;
    })
    .sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt))
    .slice(0, MAX_RAW_HISTORY);
}

/**
 * Records ONE finished raw execution. Called on every terminal path (close,
 * timeout, process error, spawn failure) — an execution with no record would
 * reproduce the very gap this closes.
 *
 * @param {{id:string, command:string, requestedBy?:string|null,
 *          requestedAt?:string|null, executedBy?:string|null,
 *          outcome:'success'|'failure'|'unknown', exitCode?:number|null,
 *          reasonCode?:string|null, stdout?:string, stderr?:string}} execution
 * @returns {{id:string, executedAt:string}|null} null when the input is unusable.
 */
export function recordRawExecution(execution = {}) {
  const { id, command, outcome } = execution;
  if (typeof id !== 'string' || typeof command !== 'string' || !RAW_OUTCOMES.includes(outcome)) {
    return null;
  }
  const entry = {
    id,
    command: redactSecretsForAudit(command) ?? '',
    requestedBy: typeof execution.requestedBy === 'string' ? execution.requestedBy.slice(0, 200) : null,
    requestedAt: typeof execution.requestedAt === 'string' ? execution.requestedAt : null,
    executedBy: typeof execution.executedBy === 'string' ? execution.executedBy.slice(0, 200) : null,
    executedAt: new Date().toISOString(),
    outcome,
    exitCode: Number.isSafeInteger(execution.exitCode) ? execution.exitCode : null,
    reasonCode: typeof execution.reasonCode === 'string' ? execution.reasonCode.slice(0, 80) : null,
    stdoutTail: outputTail(execution.stdout),
    stderrTail: outputTail(execution.stderr),
  };
  appConfigDb.set(RAW_HISTORY_CONFIG_KEY, JSON.stringify(pruneHistory([entry, ...readHistory()])));
  return { id: entry.id, executedAt: entry.executedAt };
}

/**
 * History for the owner review UI, NEWEST FIRST. Prunes on read so an expired
 * record is never served even when nothing has executed since it aged out.
 */
export function listRawHistory() {
  const stored = readHistory();
  const kept = pruneHistory(stored);
  if (kept.length !== stored.length) {
    appConfigDb.set(RAW_HISTORY_CONFIG_KEY, JSON.stringify(kept));
  }
  return kept;
}

/** Deletes one history record by id (manual removal before the hour). Idempotent. */
export function deleteRawHistoryEntry(id) {
  const list = readHistory();
  const next = list.filter((e) => e.id !== id);
  const removed = next.length !== list.length;
  if (removed) appConfigDb.set(RAW_HISTORY_CONFIG_KEY, JSON.stringify(next));
  return { removed };
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
