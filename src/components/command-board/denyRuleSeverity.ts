/**
 * denyRuleSeverity — B-1278: one refusal code, two honest messages.
 *
 * The server refuses a dangerous command-board command with
 * `denied_command:<rule>`. The client used to render every rule with one text
 * claiming the command «disrupts the server the board runs on». That is true for
 * a handful of rules (pm2 lifecycle, killing the runtime, host power) and false
 * for the rest, which are refused only because the guard cannot tell, from the
 * command's shape, a safe target from this server or its gateway — e.g.
 * `systemctl --user restart sampletwo-api.service`.
 *
 * Classification lives here, client-side, so no protocol change is needed and a
 * new client keeps working against an old server. Every surface that renders
 * the refusal (chat code block, settings enqueue box, exec review dialog) reads
 * its key and English fallback from this module and nowhere else.
 *
 * The server returns the FIRST rule that matches, so its rule order matters;
 * `denyRuleSeverity.test.ts` guards both the classification and that order
 * against `server/services/command-board-raw.js`.
 */

/** Prefix of every denylist refusal code the server returns. */
export const DENIED_COMMAND_PREFIX = 'denied_command:';

/** i18n key for a rule whose match proves the command takes this server down. */
export type DeniedCommandMessageKey = 'denied_command' | 'denied_command_fatal';

/** Rules whose match means the command stops (or does not spare) this server. */
export const FATAL_DENY_RULES: ReadonlySet<string> = new Set([
  'pm2_lifecycle',
  'kill_nassaj_dev',
  'kill_runtime',
  'kill_group',
  'kill_mass',
  'kill_service_port',
  'host_power',
  'systemd_manager',
]);

/** Rules that refuse a shape the guard cannot tell apart from a safe target. */
export const DISCRETIONARY_DENY_RULES: ReadonlySet<string> = new Set([
  'systemctl_lifecycle',
  'service_lifecycle',
  'npm_build',
  'kill_by_pattern',
  'kill_by_name',
  'session_kill',
]);

/** English fallbacks used when a locale lacks the key; worded per severity. */
export const DENIED_COMMAND_DEFAULTS: Readonly<Record<DeniedCommandMessageKey, string>> = {
  denied_command:
    'Blocked by a governance rule ({{rule}}): in this form the guard cannot tell a safe target '
    + 'from the server the board runs on or its gateway. If you have verified the target is '
    + 'something else, run it in your own terminal.',
  denied_command_fatal:
    'Blocked ({{rule}}): this form takes down the server the board runs on, or does not spare it. '
    + 'To restart it use bash scripts/safe-restart.sh --exec; for anything else, run it '
    + 'deliberately from your own terminal.',
};

/**
 * Extracts the rule from a `denied_command:<rule>` code.
 *
 * @param code - Error code returned by the server.
 * @returns The rule (possibly empty for a malformed code), or `null` when the
 *   code is not a denylist refusal at all.
 */
export function deniedCommandRule(code: string): string | null {
  if (typeof code !== 'string' || !code.startsWith(DENIED_COMMAND_PREFIX)) return null;
  return code.slice(DENIED_COMMAND_PREFIX.length);
}

/**
 * Picks the message key for a denylist refusal.
 *
 * Unknown or malformed codes get the discretionary wording: it is the weaker
 * claim, and the UI must never say a command brings the server down without
 * knowing so.
 *
 * @param code - Either the full `denied_command:<rule>` code or a bare rule.
 * @returns `'denied_command_fatal'` for a fatal rule, else `'denied_command'`.
 */
export function deniedCommandMessageKey(code: string): DeniedCommandMessageKey {
  const rule = deniedCommandRule(code) ?? code;
  return FATAL_DENY_RULES.has(rule) ? 'denied_command_fatal' : 'denied_command';
}

/** The slice of an i18next `t` this module needs; any bound `t` satisfies it. */
export type DeniedCommandTranslate = (key: string, options: Record<string, unknown>) => string;

/**
 * Renders a denylist refusal in the wording its rule's severity calls for.
 *
 * The single path every surface takes, so the prefix match, the severity
 * choice and the English fallback cannot drift apart between them. Surfaces
 * keep their own i18n namespace; only the key's parent path differs.
 *
 * @param t - Translation function bound to the surface's namespace.
 * @param code - Error code returned by the server.
 * @param keyBase - Dotted parent path holding `denied_command` and
 *   `denied_command_fatal` (e.g. `'codeBlock.insertError'`).
 * @returns The translated message, or `null` when `code` is not a denylist
 *   refusal, so the caller falls through to its other codes.
 */
export function deniedCommandMessage(
  t: DeniedCommandTranslate,
  code: string,
  keyBase: string,
): string | null {
  const rule = deniedCommandRule(code);
  if (rule === null) return null;
  const key = deniedCommandMessageKey(code);
  return t(`${keyBase}.${key}`, { rule, defaultValue: DENIED_COMMAND_DEFAULTS[key] });
}
