/**
 * vendor-key-migration.inventory — ADR-200 S5, the read-only half of the
 * vendor-key migration: where each vendor key can sit in a harness file (from
 * the `VENDOR_KEY_CATALOGUE` cli_file consumers), and what one member's own
 * harness files and AES store hold right now.
 *
 * Only API-key fields are ever read: Claude `settings.json` `env.ANTHROPIC_API_KEY`,
 * Codex `auth.json` `OPENAI_API_KEY`, and OpenCode `auth.json` entries of
 * `type: 'api'`. OAuth material (`CLAUDE_CODE_OAUTH_TOKEN`, `.credentials.json`,
 * Codex `tokens`, OpenCode logins) is never read as a key source. Values stay
 * inside the server; callers return {@link KeySourceRef} views only.
 */

import fs from 'node:fs';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { VENDOR_KEY_CATALOGUE } from '../../../../shared/vendors.js';

export type ProjectionHarness = 'claude' | 'codex' | 'opencode';

/** Where a key value was found: a harness file target, or the AES store. */
export type KeySourceRef = { harness: ProjectionHarness | 'store'; target: string | null };

export type KeySource = KeySourceRef & { value: string };

/** A member's credential file for one harness: in their own tree, or shared (skipped). */
export type HarnessFileLocation =
  | { harness: ProjectionHarness; scope: 'own'; path: string }
  | { harness: ProjectionHarness; scope: 'shared' };

/** One harness file as read. `json: null` = bytes present but not a JSON object. */
export type HarnessFileRead =
  | { harness: ProjectionHarness; scope: 'shared' }
  | { harness: ProjectionHarness; scope: 'own'; path: string; state: 'absent' }
  | { harness: ProjectionHarness; scope: 'own'; path: string; state: 'unreadable' }
  | {
    harness: ProjectionHarness;
    scope: 'own';
    path: string;
    state: 'ok';
    bytes: Buffer;
    json: Record<string, unknown> | null;
  };

/** One place a vendor key sits in a harness file. */
export type FileConsumer = { harness: ProjectionHarness; target: string | null };

/** A vendor whose key can sit in at least one harness file, with its AES record id. */
export type MigrationVendor = { vendorId: string; secretId: string; files: FileConsumer[] };

const PROJECTION_HARNESSES: readonly string[] = ['claude', 'codex', 'opencode'];

/** The catalogue vendors with a cli_file consumer: the only ones migration touches. */
export const MIGRATION_VENDORS: readonly MigrationVendor[] = Object.freeze(
  VENDOR_KEY_CATALOGUE.map((row) => ({
    vendorId: row.id,
    secretId: row.secretId,
    files: row.consumers.flatMap((consumer): FileConsumer[] => {
      if (consumer.delivery.kind !== 'cli_file' || !PROJECTION_HARNESSES.includes(consumer.harness)) return [];
      return [{ harness: consumer.harness as ProjectionHarness, target: consumer.delivery.target ?? null }];
    }),
  })).filter((vendor) => vendor.files.length > 0),
);

/** Reads one located harness file without parsing errors escaping. */
export function readHarnessFile(location: HarnessFileLocation): HarnessFileRead {
  if (location.scope === 'shared') return location;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(location.path);
  } catch (error) {
    const state = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreadable';
    return { ...location, state };
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = readObjectRecord(JSON.parse(bytes.toString('utf8'))) ?? null;
  } catch {
    json = null;
  }
  return { ...location, state: 'ok', bytes, json };
}

/** The API-key value at one file consumer, or null. Never an OAuth field. */
export function fileKeyValue(json: Record<string, unknown>, consumer: FileConsumer): string | null {
  if (consumer.harness === 'claude') {
    return readOptionalString(readObjectRecord(json.env)?.ANTHROPIC_API_KEY) ?? null;
  }
  if (consumer.harness === 'codex') return readOptionalString(json.OPENAI_API_KEY) ?? null;
  const record = readObjectRecord(json[consumer.target ?? '']);
  return record?.type === 'api' ? readOptionalString(record.key) ?? null : null;
}

/** The key at one (harness, target) among the read files, or null when absent or unknown. */
export function currentFileValue(files: readonly HarnessFileRead[], consumer: FileConsumer): string | null | undefined {
  const file = files.find((entry) => entry.harness === consumer.harness);
  if (!file || file.scope === 'shared' || file.state === 'unreadable') return undefined;
  if (file.state === 'absent' || file.json === null) return null;
  return fileKeyValue(file.json, consumer);
}

/** Every key value one vendor has in the member's own, parseable harness files. */
export function vendorFileSources(vendor: MigrationVendor, files: readonly HarnessFileRead[]): KeySource[] {
  return vendor.files.flatMap((consumer) => {
    const value = currentFileValue(files, consumer);
    return value ? [{ harness: consumer.harness, target: consumer.target, value }] : [];
  });
}
