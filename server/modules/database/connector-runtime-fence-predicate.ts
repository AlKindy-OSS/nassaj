/**
 * The single SQL predicate of the ADR-132 M2 connector runtime fence.
 *
 * Every `connector_runtime_fence_*` trigger aborts a guarded write unless this
 * predicate holds, so it is the exact definition of "the fence is open for
 * this connection right now". It lives in a dependency-free leaf so schema
 * migrations can ask the same question without importing the fence module.
 */

import type { Database } from 'better-sqlite3';

/** Prefix of every fence trigger name; never reused for any other trigger. */
export const CONNECTOR_RUNTIME_FENCE_TRIGGER_PREFIX = 'connector_runtime_fence_';

/** The fence condition; the triggers raise connector_runtime_fence_required when it is false. */
export const CONNECTOR_RUNTIME_FENCE_OPEN_SQL = `
    SELECT 1 FROM connector_runtime_anchor a
    JOIN connector_runtime_control c ON c.singleton = a.singleton
    JOIN connector_runtime_writer_lease l ON l.singleton = c.singleton
    WHERE c.singleton = 1
      AND nassaj_connector_authority_valid(
        a.initialized_marker, a.maximum_fencing_token, a.maximum_writer_epoch,
        a.clock_high_water_ms, a.authority_mac,
        c.connector_runtime_floor, c.policy_schema_version, c.writer_epoch,
        c.last_fencing_token, c.last_clock_ms, c.authority_mac,
        l.owner_token, l.acquisition_nonce, l.lease_generation, l.fencing_token,
        l.writer_epoch, l.expires_at_ms, l.authority_mac
      ) = 1
      AND nassaj_connector_runtime_version() >= c.connector_runtime_floor
      AND nassaj_connector_policy_schema_version() >= c.policy_schema_version
      AND nassaj_connector_writer_epoch() = c.writer_epoch
      AND l.writer_epoch = c.writer_epoch
      AND nassaj_connector_owner_token() = l.owner_token
      AND nassaj_connector_acquisition_nonce() = l.acquisition_nonce
      AND nassaj_connector_fencing_token() = l.fencing_token
      AND nassaj_connector_now_ms() >= c.last_clock_ms
      AND l.expires_at_ms > nassaj_connector_now_ms()`;

/** Fence trigger names currently attached to `table` (none on an unfenced database). */
export const connectorRuntimeFenceTriggersOn = (database: Database, table: string): string[] =>
  (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name LIKE ? ORDER BY name",
  ).all(table, `${CONNECTOR_RUNTIME_FENCE_TRIGGER_PREFIX}%`) as Array<{ name: string }>)
    .map(row => row.name);

/**
 * True only while a guarded write on this connection would pass the fence
 * triggers, i.e. inside a current fenced mutation. Missing authority tables or
 * unregistered fence functions (a connection without a write gate) are closed.
 */
export const connectorRuntimeFenceOpen = (database: Database): boolean => {
  try {
    const row = database.prepare(`SELECT EXISTS (${CONNECTOR_RUNTIME_FENCE_OPEN_SQL}) AS open`)
      .get() as { open: number } | undefined;
    return row?.open === 1;
  } catch {
    return false;
  }
};
