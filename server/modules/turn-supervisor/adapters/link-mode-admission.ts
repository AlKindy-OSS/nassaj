/**
 * link-mode-admission — B-1546: the shared pre-spawn link-mode check for the
 * Turn Supervisor adapters. A refusal (`LINK_MODE_KEY_MISSING`, or
 * `LINK_MODE_RECORD_UNREADABLE` per B-1547) becomes the
 * adapter's typed `provider_unavailable` error; the original error stays as the
 * cause so its code survives. The message carries no credential.
 */

import { TurnAdapterError } from './types.js';

export type LinkModeRunGate = (userId: string | number) => void | Promise<void>;

/** Runs the gate; any refusal is rethrown as `TurnAdapterError('provider_unavailable')`. */
export async function admitLinkModeRun(gate: LinkModeRunGate, userId: string | number): Promise<void> {
  try {
    await gate(userId);
  } catch (error) {
    throw new TurnAdapterError('provider_unavailable',
      error instanceof Error ? error.message : 'The link mode refused this run', { cause: error });
  }
}
