/**
 * ADR-229: the one SQL predicate that hides the past conversations of removed
 * harnesses (kimi, qwen, hermes) from display reads.
 *
 * The id list is NOT copied here: it is read from HIDDEN_HISTORY_PROVIDER_IDS.
 * The ids are compile-time constants, never caller input; each is still checked
 * against a strict pattern before it is placed in the SQL text, so a future edit
 * of the shared list can never smuggle SQL into every display query.
 *
 * Display reads only. Ownership, deletion, revocation and cost paths must keep
 * seeing every row and must not use this predicate.
 */

import { HIDDEN_HISTORY_PROVIDER_IDS } from '../../../../shared/retiredProviders.js';

const SAFE_PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/;

const HIDDEN_ID_LIST_SQL = [...HIDDEN_HISTORY_PROVIDER_IDS]
  .map((id) => {
    if (!SAFE_PROVIDER_ID.test(id)) {
      throw new Error(`hidden-history: unsafe provider id in HIDDEN_HISTORY_PROVIDER_IDS: ${JSON.stringify(id)}`);
    }
    return `'${id}'`;
  })
  .join(', ');

/**
 * Returns `<providerColumn> NOT IN (...)` for the hidden harnesses. A NULL
 * provider stays visible (COALESCE), matching the pre-ADR-229 behaviour.
 *
 * @param providerColumn qualified column, e.g. `sessions.provider` or `s.provider`
 *   — a fixed identifier written in the repository, never caller input.
 */
export function visibleHistoryPredicateSql(providerColumn: string): string {
  return `COALESCE(${providerColumn}, '') NOT IN (${HIDDEN_ID_LIST_SQL})`;
}
