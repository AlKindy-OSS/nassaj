import type { BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * qa 2 (B-1608 T2) — ledger of park files the boot sweep may remove.
 *
 * A removal can leave an entry under a park name (`parked_left`) in two ways:
 * after the parked entry was VERIFIED as the admitted file and only its unlink
 * and restore failed, or after it was found `swapped` (never verified: it may
 * be anyone's file). Only the first is recorded here, as directory realpath,
 * park name, device and inode; the sweep removes an entry only when all four
 * still match. One JSON line per park, beside the database, mode 0600; paths
 * stay on this host and are never logged.
 */

export type ParkLedgerEntry = { dir: string; name: string; dev: string; ino: string };

const LEDGER_FILE = 'transcript-park-ledger.jsonl';

/** Beside the database; the database module is loaded on use (provider tests mock it partially). */
async function ledgerPath(): Promise<string> {
  const { getDatabasePath } = await import('@/modules/database/index.js');
  return path.join(path.dirname(getDatabasePath()), LEDGER_FILE);
}

function isEntry(value: unknown): value is ParkLedgerEntry {
  const entry = value as ParkLedgerEntry;
  return Boolean(entry) && [entry.dir, entry.name, entry.dev, entry.ino].every((field) => typeof field === 'string');
}

/** Records a verified park; never throws (an unrecorded park is simply never swept). */
export async function recordVerifiedPark(dir: string, name: string, stat: BigIntStats): Promise<void> {
  const entry: ParkLedgerEntry = { dir, name, dev: String(stat.dev), ino: String(stat.ino) };
  try {
    await fsp.appendFile(await ledgerPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Unrecorded: the park is never swept.
  }
}

/** Every well-formed ledger entry; an absent or unreadable ledger is empty. */
export async function readParkLedger(): Promise<ParkLedgerEntry[]> {
  const text = await ledgerPath().then((file) => fsp.readFile(file, 'utf8')).catch(() => '');
  return text.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isEntry(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** Replaces the ledger with `entries` (atomic rename); never throws. */
export async function writeParkLedger(entries: ParkLedgerEntry[]): Promise<void> {
  let temporary = '';
  try {
    const target = await ledgerPath();
    temporary = `${target}.tmp`;
    await fsp.writeFile(temporary, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
    await fsp.rename(temporary, target);
  } catch {
    if (temporary) await fsp.unlink(temporary).catch(() => undefined);
  }
}

/** Key of a ledger entry or of a pinned park file. */
export function parkKey(dir: string, name: string, stat: { dev: bigint | string; ino: bigint | string }): string {
  return JSON.stringify([dir, name, String(stat.dev), String(stat.ino)]);
}
