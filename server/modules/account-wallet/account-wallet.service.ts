import * as databaseModule from '@/modules/database/index.js';
import type { AccountWalletSnapshot, DevicePrincipal } from '@/modules/database/index.js';

import { connectionRevocationRegistry } from './connection-revocation-registry.js';
import { revokeUserIdentity } from './user-identity-revocation.js';
import type {
  UserRealtimeRevocation,
  UserRealtimeRevocationResult,
} from './user-realtime-revocation.js';

type LocalCredential = Readonly<{
  id: number;
  passwordHash: string;
  passwordStamp: number;
}>;

type AccountWalletDependencies = Readonly<{
  findLocalCredential: (normalizedIdentifier: string) => LocalCredential | null;
  verifyPassword: (passwordHash: string, plaintext: string) => Promise<boolean>;
  decoyPasswordHash: string;
  /** T-1939: true when the account must sign in through SSO (default: never). */
  requiresSso?: (userId: number) => boolean;
  /** T-1939 slice 3: false when a linked account's SSO attestation aged out. */
  attestationFresh?: (userId: number) => boolean;
}>;

/**
 * T-1939: a correct local credential for an account that signs in through SSO
 * only. Raised after the full password verification, so it reveals nothing to
 * a caller that does not already hold the password.
 */
export class SsoRequiredError extends Error {
  readonly code = 'sso_required';
  readonly userId: number;

  constructor(userId: number) {
    super('sso_required');
    this.name = 'SsoRequiredError';
    this.userId = userId;
  }
}

/**
 * T-1939 slice 3: the target account's SSO attestation aged out, so it may not
 * become the active identity until its member signs in at the IdP again.
 */
export class SsoReauthRequiredError extends Error {
  readonly code = 'sso_reauth_required';
  readonly userId: number;

  constructor(userId: number) {
    super('sso_reauth_required');
    this.name = 'SsoReauthRequiredError';
    this.userId = userId;
  }
}

/** Domain boundary for every mutation of a device-bound account wallet. */
export class AccountWalletService {
  constructor(private readonly dependencies: AccountWalletDependencies) {}

  /** Reads the wallet represented by a server-issued principal. */
  read(principal: DevicePrincipal): AccountWalletSnapshot {
    const wallet = databaseModule.deviceAccountSessionsDb.snapshot(principal.deviceSessionId);
    if (!wallet) throw new Error('device_session_invalid');
    return wallet;
  }

  /**
   * Switches the active slot and immediately revokes the older generation.
   * Throws SsoReauthRequiredError when the target's SSO attestation is stale.
   */
  switch(principal: DevicePrincipal, slotId: string, expectedGeneration: number): AccountWalletSnapshot {
    const targetUserId = databaseModule.deviceAccountSessionsDb.userIdForSlot?.(
      principal.deviceSessionId, slotId,
    );
    if (typeof targetUserId === 'number' && this.dependencies.attestationFresh?.(targetUserId) === false) {
      throw new SsoReauthRequiredError(targetUserId);
    }
    const wallet = databaseModule.deviceAccountSessionsDb.switch(principal, slotId, expectedGeneration);
    connectionRevocationRegistry.revokeOlderGenerations(principal.deviceSessionId, wallet.generation);
    return wallet;
  }

  /**
   * Re-authenticates and adds a local account without issuing a JWT or changing
   * the active slot. Unknown and invalid credentials take the same verify path.
   * Throws SsoRequiredError for a verified SSO-only account (T-1939).
   */
  async addLocal(
    principal: DevicePrincipal,
    identifier: string,
    password: string,
    expectedGeneration: number,
  ): Promise<AccountWalletSnapshot | null> {
    const normalizedIdentifier = identifier.trim().toLowerCase();
    const credential = this.dependencies.findLocalCredential(normalizedIdentifier);
    const verified = await this.dependencies.verifyPassword(
      credential?.passwordHash ?? this.dependencies.decoyPasswordHash,
      password,
    );
    if (!credential || !verified) return null;
    if (this.dependencies.requiresSso?.(credential.id)) throw new SsoRequiredError(credential.id);
    let wallet: AccountWalletSnapshot;
    try {
      wallet = databaseModule.deviceAccountSessionsDb.add(
        principal, credential.id, credential.passwordStamp, expectedGeneration,
      );
    } catch (error) {
      if (error instanceof databaseModule.WalletConflictError
          && (error.code === 'account_credentials_changed'
            || error.code === 'account_ineligible')) return null;
      throw error;
    }
    connectionRevocationRegistry.revokeOlderGenerations(principal.deviceSessionId, wallet.generation);
    return wallet;
  }

  /** Removes an inactive slot and revokes connections stamped before the write. */
  remove(principal: DevicePrincipal, slotId: string, expectedGeneration: number): AccountWalletSnapshot {
    const wallet = databaseModule.deviceAccountSessionsDb.remove(principal, slotId, expectedGeneration);
    connectionRevocationRegistry.revokeOlderGenerations(principal.deviceSessionId, wallet.generation);
    return wallet;
  }

  /** Signs out the active account and selects the most recently used remainder. */
  logout(principal: DevicePrincipal, expectedGeneration: number) {
    const result = databaseModule.deviceAccountSessionsDb.logout(principal, expectedGeneration);
    connectionRevocationRegistry.revokeOlderGenerations(
      principal.deviceSessionId,
      result.wallet?.generation ?? Number.POSITIVE_INFINITY,
    );
    return result;
  }

  /** Revokes the entire device session and every associated live connection. */
  logoutAll(principal: DevicePrincipal, expectedGeneration: number): void {
    databaseModule.deviceAccountSessionsDb.logout(principal, expectedGeneration, true);
    connectionRevocationRegistry.revokeDevice(principal.deviceSessionId);
  }

  /** Atomically changes a password, fences slots, then closes stale transports. */
  rotatePassword(
    userId: number,
    passwordHash: string,
    changedAt: number,
    preserveSlotId: string | null,
    forceChange = false,
  ): void {
    const affected = databaseModule.deviceAccountSessionsDb.rotatePassword(
      userId, passwordHash, changedAt, preserveSlotId, forceChange,
    );
    for (const session of affected) {
      connectionRevocationRegistry.revokeOlderGenerations(
        session.deviceSessionId, session.generation,
      );
    }
  }

  /**
   * Rotates a forced credential, then issues a NEW device session (ADR-163
   * amendment 1, C1 / B-1529): the device the browser presented is revoked with
   * all of its slots and its live connections are closed. Nothing merges.
   */
  completeForcedPasswordRotation(
    userId: number,
    passwordHash: string,
    changedAt: number,
    existingDeviceSecret: string | null,
    ttlMs: number,
  ): { secret: string; expiresAt: number; wallet: AccountWalletSnapshot } {
    this.rotatePassword(userId, passwordHash, changedAt, null, false);
    const issued = databaseModule.deviceAccountSessionsDb.rotateDevice(
      existingDeviceSecret, userId, ttlMs,
    );
    if (issued.revokedDeviceSessionId) {
      connectionRevocationRegistry.revokeDevice(issued.revokedDeviceSessionId);
    }
    return { secret: issued.secret, expiresAt: issued.expiresAt, wallet: issued.wallet };
  }

  /** Closes every transport on devices changed by permanent user deletion. */
  revokeDevices(deviceSessionIds: readonly string[]): void {
    for (const deviceSessionId of deviceSessionIds) {
      connectionRevocationRegistry.revokeDevice(deviceSessionId);
    }
  }

  /**
   * B-1327: applies an administrative identity change (disable, delete, role
   * change) to everything live for `userId`; see revokeUserIdentity.
   */
  revokeUser(
    userId: number,
    deviceSessionIds: readonly string[],
    revocation: UserRealtimeRevocation,
  ): UserRealtimeRevocationResult {
    return revokeUserIdentity(userId, revocation, deviceSessionIds);
  }
}
