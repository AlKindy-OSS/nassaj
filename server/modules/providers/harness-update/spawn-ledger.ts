/**
 * Durable spawn ledger (T-1871 stage 3, spec §6, C-A).
 *
 * After an update succeeds the run is recorded; every spawn of that harness
 * afterwards bumps a counter, and the FIRST spawn after a success is fsynced
 * before the spawn proceeds. The facts decide whether a data restore needs a
 * `dataLoss` acknowledgement. Unknown is always treated as "spawned":
 *   - missing or corrupt ledger file, or no entry for the run (crash between
 *     `succeeded` and the ledger write) → unknown;
 *   - a ledger write failure never blocks the spawn; the run becomes unknown in
 *     memory and the flag is persisted on the next successful write.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './snapshot/durable-fs.js';
import { ensurePrivateDir, harnessDataHome, nassajDataDir } from './snapshot/paths.js';

/** Spawn facts of one run since its success. */
export interface SpawnFacts {
  firstSpawnAt: number | null;
  count: number;
  unknown: boolean;
}

interface RunEntry {
  succeededAt: number;
  firstSpawnAt: number | null;
  count: number;
  unknown: boolean;
}

interface LedgerFile {
  schema: 1;
  harnesses: Record<string, Record<string, RunEntry>>;
}

const UNKNOWN: SpawnFacts = Object.freeze({ firstSpawnAt: null, count: 0, unknown: true });

/** Default ledger location: `~/.local/share/nassaj/harness-spawn-ledger.json`. */
export function defaultSpawnLedgerPath(home: string = harnessDataHome()): string {
  return path.join(nassajDataDir(home), 'harness-spawn-ledger.json');
}

function isRunEntry(v: unknown): v is RunEntry {
  const e = v as RunEntry;
  return typeof e === 'object' && e !== null && Number.isFinite(e.succeededAt) && Number.isInteger(e.count)
    && (e.firstSpawnAt === null || Number.isFinite(e.firstSpawnAt)) && typeof e.unknown === 'boolean';
}

function parseLedger(text: string): LedgerFile | null {
  try {
    const raw = JSON.parse(text) as LedgerFile;
    if (raw?.schema !== 1 || typeof raw.harnesses !== 'object' || raw.harnesses === null) return null;
    for (const runs of Object.values(raw.harnesses)) {
      if (typeof runs !== 'object' || runs === null || !Object.values(runs).every(isRunEntry)) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/** File-backed spawn ledger; one instance per server process. */
export class SpawnLedger {
  /** harness → time a failed write made its earlier runs unknown. */
  private readonly unknownSince = new Map<string, number>();

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private read(): LedgerFile | null {
    try {
      return parseLedger(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  private write(ledger: LedgerFile): void {
    ensurePrivateDir(path.dirname(this.file));
    writeFileAtomic(this.file, `${JSON.stringify(ledger)}\n`);
  }

  /** Records a succeeded update run durably (throws on write failure → run stays unknown). */
  recordUpdateSuccess(harness: string, jobId: string, at: number): void {
    const ledger = this.read() ?? { schema: 1, harnesses: {} };
    ledger.harnesses[harness] = {
      ...(ledger.harnesses[harness] ?? {}),
      [jobId]: { succeededAt: at, firstSpawnAt: null, count: 0, unknown: false },
    };
    this.write(ledger);
  }

  /**
   * Called on the single spawn admission path before a spawn of `harness`.
   * Never throws: a failed write marks the harness's runs unknown.
   */
  noteSpawn(harness: string): void {
    const at = this.now();
    try {
      const ledger = this.read();
      const runs = ledger?.harnesses[harness];
      if (!ledger || !runs || Object.keys(runs).length === 0) return;
      const pendingUnknown = this.unknownSince.get(harness);
      for (const run of Object.values(runs)) {
        run.count += 1;
        if (run.firstSpawnAt === null) run.firstSpawnAt = at;
        if (pendingUnknown !== undefined && run.succeededAt <= pendingUnknown) run.unknown = true;
      }
      this.write(ledger);
      this.unknownSince.delete(harness);
    } catch {
      this.unknownSince.set(harness, at);
    }
  }

  /** Spawn facts since run `jobId` succeeded; unknown when not provable. */
  spawnFactsSince(harness: string, jobId: string): SpawnFacts {
    const run = this.read()?.harnesses[harness]?.[jobId];
    if (!run) return { ...UNKNOWN };
    const pending = this.unknownSince.get(harness);
    const unknown = run.unknown || (pending !== undefined && run.succeededAt <= pending);
    return { firstSpawnAt: run.firstSpawnAt, count: run.count, unknown };
  }

  /** Drops a pruned run from the ledger (best effort). */
  forgetRun(harness: string, jobId: string): void {
    const ledger = this.read();
    if (!ledger?.harnesses[harness]?.[jobId]) return;
    delete ledger.harnesses[harness][jobId];
    this.write(ledger);
  }
}

let shared: SpawnLedger | null = null;

/**
 * The ONE ledger instance of this server process. spawn-admission notes every
 * admitted spawn here and the update/rollback services read the same instance,
 * so the in-memory "write failed → unknown" flag is seen by both.
 */
export function sharedSpawnLedger(): SpawnLedger {
  shared ??= new SpawnLedger(defaultSpawnLedgerPath());
  return shared;
}

/** Test hook: replace (or drop, with null) the shared ledger instance. */
export function _setSharedSpawnLedger(ledger: SpawnLedger | null): void {
  shared = ledger;
}
