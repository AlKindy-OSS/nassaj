/**
 * rawDenyRuleCodes.testutil.ts — test-only reader of the server denylist.
 *
 * Tests read `server/services/command-board-raw.js` as TEXT (importing it opens
 * the application database). This is the one extraction both command-board
 * suites share, so they cannot disagree about which rules exist.
 */

/**
 * Lists the rule codes of `RAW_DENY_RULES` in the order the server evaluates
 * them, duplicates kept.
 *
 * Matches every `code: '<name>'` inside the block from `export const
 * RAW_DENY_RULES` to its closing `]);`, independent of the other fields a rule
 * carries or their order (`re`, `raw`, `norm`, ...).
 *
 * @param source - Full text of `server/services/command-board-raw.js`.
 * @returns Rule codes in source order.
 * @throws When the block or its terminator is missing, so a renamed constant
 *   fails loudly instead of yielding an empty list.
 */
export function rawDenyRuleCodesInOrder(source: string): string[] {
  const start = source.indexOf('export const RAW_DENY_RULES');
  if (start < 0) throw new Error('RAW_DENY_RULES not found in server source');
  const end = source.indexOf(']);', start);
  if (end < 0) throw new Error('RAW_DENY_RULES block has no closing ]);');
  return [...source.slice(start, end).matchAll(/code: '([a-z0-9_]+)'/g)].map((m) => m[1]);
}
