import * as databaseModule from '@/modules/database/index.js';
import type { DevicePrincipal } from '@/modules/database/index.js';

type RevocableConnection = Readonly<{
  close: (code?: number, reason?: string) => void;
}>;

type ConnectionEntry = Readonly<{
  connection: RevocableConnection;
  principal: DevicePrincipal;
}>;

/**
 * Operational index for device-session realtime connections.
 * Database generation remains authoritative; losing this process-local index
 * cannot make an expired principal valid.
 */
export class ConnectionRevocationRegistry {
  private readonly entries = new Set<ConnectionEntry>();

  /** Registers a connection and returns an idempotent cleanup callback. */
  register(connection: RevocableConnection, principal: DevicePrincipal): () => void {
    const entry = { connection, principal };
    this.entries.add(entry);
    return () => this.entries.delete(entry);
  }

  /** Verifies a stamped identity against the database source of truth. */
  isCurrent(principal: DevicePrincipal): boolean {
    return databaseModule.deviceAccountSessionsDb?.isPrincipalCurrent(principal) === true;
  }

  /** Closes every connection stamped with an older generation. */
  revokeOlderGenerations(deviceSessionId: string, generation: number): number {
    let revoked = 0;
    for (const entry of this.entries) {
      if (entry.principal.deviceSessionId !== deviceSessionId
          || entry.principal.generation >= generation) continue;
      this.entries.delete(entry);
      revoked += 1;
      try {
        entry.connection.close(4401, 'identity_revoked');
      } catch {
        // The connection already disappeared; removal from the index is enough.
      }
    }
    return revoked;
  }

  /** Closes all connections for a revoked device session. */
  revokeDevice(deviceSessionId: string): number {
    return this.revokeOlderGenerations(deviceSessionId, Number.POSITIVE_INFINITY);
  }

  /** Test-only count of indexed live connections. */
  sizeForTests(): number {
    return this.entries.size;
  }
}

export const connectionRevocationRegistry = new ConnectionRevocationRegistry();

/** Narrows an authenticated request user to a server-stamped device principal. */
export function devicePrincipalFromUser(user: unknown): DevicePrincipal | null {
  if (!user || typeof user !== 'object') return null;
  const candidate = user as Record<string, unknown>;
  if (candidate.authenticationKind !== 'device_session'
      || typeof candidate.deviceSessionId !== 'string'
      || typeof candidate.slotId !== 'string'
      || !Number.isInteger(candidate.deviceGeneration)
      || !Number.isInteger(candidate.userId)
      || !Number.isInteger(candidate.authorizationGeneration)) return null;
  return {
    deviceSessionId: candidate.deviceSessionId,
    slotId: candidate.slotId,
    generation: candidate.deviceGeneration as number,
    userId: candidate.userId as number,
    authorizationGeneration: candidate.authorizationGeneration as number,
  };
}

/** Fails closed when a device-authenticated realtime message is stale. */
export function assertRealtimePrincipalCurrent(user: unknown): boolean {
  const principal = devicePrincipalFromUser(user);
  return principal ? connectionRevocationRegistry.isCurrent(principal) : true;
}

type HttpResponseLifetime = Readonly<{
  writableEnded?: boolean;
  destroyed?: boolean;
  once: (event: string, callback: () => void) => unknown;
  destroy: () => unknown;
}>;

/** Registers an HTTP stream, then rechecks its device identity to close the registration race. */
export function bindDeviceHttpResponseLifetime(
  authenticatedUser: unknown,
  response: HttpResponseLifetime,
  onInvalidated: () => void = () => undefined,
): boolean {
  const principal = devicePrincipalFromUser(authenticatedUser);
  if (!principal) return true;
  let unregister: (() => void) | null = null;
  const close = () => {
    unregister?.();
    onInvalidated();
    if (!response.writableEnded && !response.destroyed) response.destroy();
  };
  unregister = connectionRevocationRegistry.register({ close }, principal);
  response.once('close', () => unregister?.());
  if (!connectionRevocationRegistry.isCurrent(principal)) {
    close();
    return false;
  }
  return true;
}
