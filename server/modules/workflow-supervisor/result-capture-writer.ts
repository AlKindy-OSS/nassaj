/**
 * The SINGLE atomic result-capture write path (§أ-4) — ported verbatim (logic
 * identical) from the T-819 producer spike (`spikes/b103-t819/lib/capture-writer.mjs`),
 * now on real server code (audit condition C2: prove the §و guarantees on the
 * shipped modules, not on spike code).
 *
 * PROTOCOL (the order is the guarantee):
 *   1. `.partial` holds the run's output while it executes (never final).
 *   2. On a CLEAN exit (exit_code === 0): fsync(.partial) → rename(.partial →
 *      result.json) → fsync(dir). rename(2) is atomic on the same filesystem, so
 *      `result.json` NEVER exists unless it is a fully-written, durable copy — a
 *      kill -9 mid-write can only leave `.partial`, never a torn `result.json`.
 *   3. `DONE` is written LAST (tmp → fsync → rename → fsync dir):
 *      `{ exit_code, signal, finalizedAt }`. A monitor trusts NOTHING without it.
 *
 * `writeFileAtomic` is exported so the later consumer wave (handoff ledger) can
 * write through the SAME proven primitive — one atomicity guarantee, proven once
 * (the exact reuse the design mandates for exactly-once delivery).
 */

import fs from 'node:fs';
import path from 'node:path';

const PARTIAL = 'result.json.partial';
const RESULT = 'result.json';
const DONE = 'DONE';

/** Producer schema tag stamped into DONE so the consumer can version-check it. */
export const PRODUCER_SCHEMA = 't820-producer-1';

/** fsync a directory entry so a rename into it is durable. */
export function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Atomic file create: tmp → fsync → rename → fsync(dir). The one durability
 * primitive both DONE and (later) the delivery ledger write through.
 */
export function writeFileAtomic(dir: string, name: string, buf: Buffer): void {
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(dir, name));
  fsyncDir(dir);
}

export type SealOptions = {
  /** ISO-signal that killed the child, if any (null on a normal exit). */
  signal?: string | null;
};

/**
 * THE SHARED SEAL PATH. Reaches `result.json` ONLY through here, so the
 * atomicity guarantee is one code path.
 *
 * @param outdir   the task artifact dir (result.json[.partial], DONE)
 * @param exitCode the child's exit code (0 => clean; anything else => partial)
 */
export function seal(outdir: string, exitCode: number, opts: SealOptions = {}): void {
  const signal = opts.signal ?? null;
  const partialPath = path.join(outdir, PARTIAL);
  const resultPath = path.join(outdir, RESULT);

  // Step 2 — rename ONLY on a clean exit, and only if a `.partial` exists.
  if (exitCode === 0 && fs.existsSync(partialPath)) {
    const pfd = fs.openSync(partialPath, 'r');
    try {
      fs.fsyncSync(pfd);
    } finally {
      fs.closeSync(pfd);
    }
    fs.renameSync(partialPath, resultPath); // atomic on same FS
    fsyncDir(outdir);
  }

  // Step 3 — DONE last: the only thing a monitor trusts.
  const done = JSON.stringify({
    exit_code: exitCode,
    signal,
    finalizedAt: new Date().toISOString(),
    schema: PRODUCER_SCHEMA,
  });
  writeFileAtomic(outdir, DONE, Buffer.from(done + '\n'));
}
