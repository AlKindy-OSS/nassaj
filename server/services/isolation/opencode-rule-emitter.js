/**
 * ADR-226 (reduces ADR-221): Claude rule IR → OpenCode's own permission layer L1
 * (`OPENCODE_PERMISSION`, merged by opencode after every config file; within one
 * permission the LAST matching rule wins).
 *
 * L1 = `{"*":"allow"}` first, then Claude's DENY rules, then the plan block. The shared
 * Claude-parity engine decides every call (asks go to the member), so OpenCode must not
 * ask or auto-reject on its own (`run` would auto-reject external_directory / doom_loop);
 * ask rules are NOT translated (a translated ask would deny a member-approved call).
 * Claude's deny rules stay as a second layer.
 *
 * Bash translation: `Bash(x:*)` → `x` and `x *`; a glob or exact pattern as is; a
 * glob ending in ` *` also covers its bare base (widened, never dropped); a bare
 * `Bash` denies the whole tool.
 */
import { OPENCODE_PLAN_PERMISSION } from './vendor-cli-permissions.js';

/** Plan = read-only: the SL-4 table's L1 part (the engine also denies every non-read call). */
const PLAN_L1 = Object.freeze(JSON.parse(OPENCODE_PLAN_PERMISSION));

/** @param {{ match: string, pattern: string }} rule @returns {string[]} opencode wildcard patterns */
export function bashPatternsFor(rule) {
  if (rule.match === 'prefix') return [rule.pattern, `${rule.pattern} *`];
  if (rule.match === 'glob' && rule.pattern.endsWith(' *')) return [rule.pattern, rule.pattern.slice(0, -2)];
  return [rule.pattern];
}

/**
 * @param {{ plan: boolean, rules: Array<{ tool: string, kind: string, match: string|null,
 *   pattern: string|null, effect: 'deny'|'ask' }> }} input
 * @returns {Record<string, unknown>} the L1 object
 */
export function emitOpenCodeRules({ plan, rules }) {
  const l1 = { '*': 'allow' };
  for (const rule of rules.filter((r) => r.effect === 'deny')) {
    if (rule.kind === 'tool') {
      l1[rule.tool] = 'deny';
      continue;
    }
    if (l1.bash === 'deny') continue;
    const block = typeof l1.bash === 'object' ? l1.bash : (l1.bash = {});
    for (const pattern of bashPatternsFor(rule)) {
      delete block[pattern];
      block[pattern] = 'deny';
    }
  }
  if (plan) {
    for (const [tool, action] of Object.entries(PLAN_L1)) {
      delete l1[tool];
      l1[tool] = action;
    }
  }
  return l1;
}
