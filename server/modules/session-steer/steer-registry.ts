/**
 * Server-registered `midTurnInjection` capability (T-1903). A provider is
 * steerable only when its runtime registered an adapter here; the client's
 * word about the provider is never consulted. Claude registers at load; Codex
 * can be added later by registering its own adapter.
 */

import type { SteerRun } from './steer-run.js';

export type MidTurnInjectionAdapter = {
  /** The live run of this session, or null when none is running. */
  findRun(sessionId: string): SteerRun | null;
  /** A run is live but was started without a steer controller (no consent/hooks at start). */
  hasUnarmedRun?(sessionId: string): boolean;
  /** Provider-native payload hash persisted to prove delivery from the transcript. */
  payloadHash(wrapped: string): string | null;
};

const adapters = new Map<string, MidTurnInjectionAdapter>();

/** Registers (or replaces) the adapter of one provider. */
export function registerMidTurnInjection(provider: string, adapter: MidTurnInjectionAdapter): void {
  adapters.set(provider, adapter);
}

/** The adapter of a provider, or null when it cannot take mid-turn input. */
export function getMidTurnInjection(provider: string | null | undefined): MidTurnInjectionAdapter | null {
  return provider ? adapters.get(provider) ?? null : null;
}

/** Capability flag exposed to clients. */
export function supportsMidTurnInjection(provider: string | null | undefined): boolean {
  return getMidTurnInjection(provider) !== null;
}

/** Test seam. */
export function __resetMidTurnInjectionForTests(): void {
  adapters.clear();
}
