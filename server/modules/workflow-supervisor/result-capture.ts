/**
 * result-capture — the terminal-state CLASSIFIER (§أ-3), ported from the proven
 * T-819 producer spike (`spikes/b103-t819/lib/classifier.mjs`) onto server code
 * (audit condition C2: prove the §و guarantees on the shipped modules). The
 * atomic WRITE path (§أ-4 seal) already lives in `result-capture-writer.ts`; this
 * is its CONSUMER-side counterpart — the deterministic verdict a monitor derives
 * from the on-disk artifacts + the unit's terminal systemd state.
 *
 * Output: exactly one of
 *   SUCCEEDED | PARTIAL | PARTIAL-untrusted | CRASHED   (or RUNNING if not terminal).
 *
 * DECISION ORDER (DONE is the source of truth; unit state only drives the
 * DONE-absent reconciliation):
 *
 *   DONE present:
 *     signal != null                          → CRASHED            (sealed a kill)
 *     exit_code === 0 && result.json present   → SUCCEEDED
 *     exit_code === 0 && result.json absent    → PARTIAL-untrusted  (anomaly)
 *     exit_code !== 0                          → PARTIAL
 *
 *   DONE absent (§أ-3 reconciliation — no infinite hang, no false SUCCEEDED):
 *     wait until the unit is terminal (inactive|failed|gone), then RECONCILE_GRACE,
 *     then re-check DONE. If DONE appeared → re-run the DONE-present branch (the
 *     loss race resolved). Else decide from unit state + result.json:
 *       failed  OR  result.json absent         → CRASHED
 *       inactive/gone AND result.json present   → PARTIAL-untrusted (unsealed)
 *
 * The grace closes the race where is-active flips terminal a few ms before the
 * wrapper writes DONE. After the grace the verdict is always DECISIVE — the T-819
 * acceptance bar (§و/م1 criterion 3).
 */

import fs from 'node:fs';
import path from 'node:path';

/** ActiveState the probe reports. 'gone' = systemd GC'd a clean transient unit. */
export type UnitState =
  | 'active'
  | 'activating'
  | 'inactive'
  | 'failed'
  | 'gone'
  | 'unknown';

/** Injected probe of a unit's terminal state (real: systemctl show; test: stub). */
export type UnitStateProbe = (unit: string) => Promise<UnitState>;

export type Classification =
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'PARTIAL-untrusted'
  | 'CRASHED'
  | 'RUNNING';

export type ClassifyVerdict = {
  classification: Classification;
  reason: string;
  unitState: UnitState;
  resultPresent: boolean;
  partialPresent: boolean;
  done: Record<string, unknown> | null;
  graceApplied: boolean;
};

export type ClassifyOptions = {
  /** Grace after the unit is terminal but DONE is absent (§أ-3). */
  graceMs?: number;
  /** Upper bound on the wait for terminal-or-DONE before returning RUNNING. */
  pollTimeoutMs?: number;
  /** Poll interval while waiting for terminal-or-DONE. */
  pollIntervalMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
  /** Sleep seam (tests) — default is a real awaited timer (non-blocking). */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

function isTerminal(state: UnitState): boolean {
  return state === 'inactive' || state === 'failed' || state === 'gone';
}

function readDone(outdir: string): Record<string, unknown> | null {
  const p = path.join(outdir, 'DONE');
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    // A half-written DONE (should not happen — it is written atomically) is
    // treated as "no trustworthy DONE" so reconciliation still runs.
    return { _unparsable: true };
  }
}

/**
 * `result.json` exists ⟺ complete: it is ONLY ever created by an atomic rename of
 * a fully-written `.partial` (result-capture-writer.seal). A parse check is the
 * belt-and-suspenders; a rare unparseable result is still counted present so the
 * verdict never silently downgrades a real (if odd) output.
 */
function resultPresent(outdir: string): boolean {
  const p = path.join(outdir, 'result.json');
  if (!fs.existsSync(p)) {
    return false;
  }
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    return true;
  } catch {
    return true;
  }
}

function partialPresent(outdir: string): boolean {
  return fs.existsSync(path.join(outdir, 'result.json.partial'));
}

function classifyFromDone(
  done: Record<string, unknown>,
  outdir: string,
): { classification: Classification; reason: string } {
  const rp = resultPresent(outdir);
  if (done.signal != null) {
    return { classification: 'CRASHED', reason: 'DONE records a kill signal' };
  }
  if (done.exit_code === 0 && rp) {
    return { classification: 'SUCCEEDED', reason: 'exit 0 + result.json + DONE' };
  }
  if (done.exit_code === 0 && !rp) {
    return {
      classification: 'PARTIAL-untrusted',
      reason: 'DONE exit 0 but result.json absent (anomaly)',
    };
  }
  return { classification: 'PARTIAL', reason: `exit_code=${String(done.exit_code)} sealed in DONE` };
}

/**
 * Derive the terminal verdict for a task dir. `unit` may be '' (already gone).
 * Never throws — a probe rejection is treated as 'gone' (terminal), so a
 * monitoring blip resolves to a decisive verdict rather than a hang.
 */
export async function classifyTerminal(
  outdir: string,
  unit: string,
  probe: UnitStateProbe,
  options: ClassifyOptions = {},
): Promise<ClassifyVerdict> {
  const graceMs = options.graceMs ?? 10_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;

  const safeProbe = async (): Promise<UnitState> => {
    if (!unit) {
      return 'gone';
    }
    try {
      return await probe(unit);
    } catch {
      return 'gone';
    }
  };

  const deadline = now() + pollTimeoutMs;

  // 1. Wait for either DONE to appear or the unit to be terminal.
  let state = await safeProbe();
  while (!readDone(outdir) && !isTerminal(state) && now() < deadline) {
    await sleep(pollIntervalMs);
    state = await safeProbe();
  }

  const done = readDone(outdir);
  if (done && !done._unparsable) {
    const r = classifyFromDone(done, outdir);
    return {
      ...r,
      unitState: state,
      resultPresent: resultPresent(outdir),
      partialPresent: partialPresent(outdir),
      done,
      graceApplied: false,
    };
  }

  // 2. DONE absent + unit not terminal within the poll budget → RUNNING (bounded,
  //    never a hang). The monitor will re-check on the next tick.
  if (!isTerminal(state)) {
    return {
      classification: 'RUNNING',
      reason: 'unit not terminal within poll timeout (bounded, no hang)',
      unitState: state,
      resultPresent: resultPresent(outdir),
      partialPresent: partialPresent(outdir),
      done: null,
      graceApplied: false,
    };
  }

  // 3. Terminal + no DONE → apply the grace, then re-check DONE (loss-race window).
  await sleep(graceMs);
  const done2 = readDone(outdir);
  if (done2 && !done2._unparsable) {
    const r = classifyFromDone(done2, outdir);
    return {
      ...r,
      unitState: state,
      resultPresent: resultPresent(outdir),
      partialPresent: partialPresent(outdir),
      done: done2,
      graceApplied: true,
    };
  }

  // 4. Decisive reconciliation verdict (§أ-3): never SUCCEEDED, never a hang.
  const rp = resultPresent(outdir);
  const finalState = await safeProbe();
  if (finalState === 'failed' || !rp) {
    return {
      classification: 'CRASHED',
      reason: `DONE absent after grace; unit=${finalState}, result.json=${rp} → crashed`,
      unitState: finalState,
      resultPresent: rp,
      partialPresent: partialPresent(outdir),
      done: null,
      graceApplied: true,
    };
  }
  return {
    classification: 'PARTIAL-untrusted',
    reason: `DONE absent after grace; unit=${finalState}, result.json present but unsealed`,
    unitState: finalState,
    resultPresent: rp,
    partialPresent: partialPresent(outdir),
    done: null,
    graceApplied: true,
  };
}
