/**
 * Session share sweeper (ADR-196, T-1970 stage 4). Runs at boot and every ten
 * minutes. Definitive death causes revoke immediately (revoked_at, reason,
 * snapshot nulled). A missing session row or an unresolvable owner is only
 * definitive after two consecutive sweeps, because the sessions watcher may
 * delete and re-insert a row while it rewrites a JSONL transcript (reviewer S3).
 */
import { TWO_STRIKE_REASONS, evaluateLiveness } from './session-share-policy.js';

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

type SweepRow = {
  id: string;
  session_id: string;
  project_id: string;
  owner_user_id: number;
  created_by: number;
  expires_at: string;
  revoked_at: string | null;
  sweep_miss_count: number;
};

export type SweepStore = {
  listSweepable: (afterId: string, limit: number) => SweepRow[];
  revokeExpired: (at: string, limit: number) => number;
  revoke: (id: string, reason: string, at?: string) => number;
  markSweepMiss: (id: string) => number;
  resetSweepMiss: (id: string) => number;
};

export type SweepResult = { revoked: number; missed: number; alive: number };

/** Rows per query; every run still covers the whole table. */
export const SWEEP_BATCH = 500;

/** Persisted reason for each liveness verdict. */
const REASON_FOR: Readonly<Record<string, string>> = Object.freeze({ session_missing: 'session_gone' });

/** Judges one row and applies the verdict. */
function sweepRow(store: SweepStore, policy: object, row: SweepRow, nowMs: number, result: SweepResult): void {
  // A revoked row listed here still holds a blob: null it.
  const reason = row.revoked_at ? 'revoked' : evaluateLiveness(row, policy, nowMs);
  if (reason === null) {
    store.resetSweepMiss(row.id);
    result.alive += 1;
  } else if (TWO_STRIKE_REASONS.has(reason) && row.sweep_miss_count < 1) {
    store.markSweepMiss(row.id);
    result.missed += 1;
  } else {
    store.revoke(row.id, REASON_FOR[reason] ?? reason, new Date(nowMs).toISOString());
    result.revoked += 1;
  }
}

/**
 * One sweep over every share that is live or still holds a blob: first every
 * expired row in batches, then the rest through an id cursor, so no row is
 * starved however many there are.
 * @param policy the same lookup dependencies the public reader uses
 */
export function sweepSessionShares(store: SweepStore, policy: object, nowMs: number = Date.now()): SweepResult {
  const result: SweepResult = { revoked: 0, missed: 0, alive: 0 };
  const at = new Date(nowMs).toISOString();
  for (let changed = SWEEP_BATCH; changed === SWEEP_BATCH;) {
    changed = store.revokeExpired(at, SWEEP_BATCH);
    result.revoked += changed;
  }
  let afterId = '';
  for (;;) {
    const page = store.listSweepable(afterId, SWEEP_BATCH);
    for (const row of page) sweepRow(store, policy, row, nowMs, result);
    if (page.length < SWEEP_BATCH) break;
    afterId = page[page.length - 1].id;
  }
  return result;
}

export type SweeperDeps = {
  getStore: () => SweepStore;
  policy: object;
  /** Runs the sweep under the application writer lease; rejects when maintenance holds it. */
  withWriter: <T>(operation: () => T) => Promise<T>;
  log?: (entry: Record<string, unknown>) => void;
  intervalMs?: number;
};

/** Starts the boot sweep and the interval; returns a stop function. */
export function startSessionShareSweeper(deps: SweeperDeps): () => void {
  const log = deps.log ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`));
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await deps.withWriter(() => sweepSessionShares(deps.getStore(), deps.policy));
      if (result.revoked > 0 || result.missed > 0) log({ level: 'info', scope: 'session-share-sweeper', ...result });
    } catch (error) {
      log({ level: 'warn', scope: 'session-share-sweeper', code: (error as { code?: string })?.code ?? 'sweep_failed' });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, deps.intervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
