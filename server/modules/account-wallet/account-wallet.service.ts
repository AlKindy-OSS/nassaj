import * as databaseModule from '@/modules/database/index.js';
import type { AccountWalletSnapshot, DevicePrincipal } from '@/modules/database/index.js';

import { connectionRevocationRegistry } from './connection-revocation-registry.js';

type LocalCredential = Readonly<{
  id: number;
  passwordHash: string;
  passwordStamp: number;
}>;

type AccountWalletDependencies = Readonly<{
  findLocalCredential: (normalizedIdentifier: string) => LocalCredential | null;
  verifyPassword: (passwordHash: string, plaintext: string) => Promise<boolean>;
  decoyPasswordHash: string;
}>;

/** Domain boundary for every mutation of a device-bound account wallet. */
export class AccountWalletService {
  constructor(private readonly dependencies: AccountWalletDependencies) {}

  /** Reads the wallet represented by a server-issued principal. */
  read(principal: DevicePrincipal): AccountWalletSnapshot {
    const wallet = databaseModule.deviceAccountSessionsDb.snapshot(principal.deviceSessionId);
    if (!wallet) throw new Error('device_session_invalid');
    return wallet;
  }

  /** Switches the active slot and immediately revokes the older generation. */
  switch(principal: DevicePrincipal, slotId: string, expectedGeneration: number): AccountWalletSnapshot {
    const wallet = databaseModule.deviceAccountSessionsDb.switch(principal, slotId, expectedGeneration);
    connectionRevocationRegistry.revokeOlderGenerations(principal.deviceSessionId, wallet.generation);
    return wallet;
  }

  /**
   * Re-authenticates and adds a local account without issuing a JWT or changing
   * the active slot. Unknown and invalid credentials take the same verify path.
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

  /** Rotates a forced credential and establishes a normal safe wallet identity. */
  completeForcedPasswordRotation(
    userId: number,
    passwordHash: string,
    changedAt: number,
    existingDeviceSecret: string | null,
    ttlMs: number,
  ): { secret: string; wallet: AccountWalletSnapshot } {
    this.rotatePassword(userId, passwordHash, changedAt, null, false);
    if (existingDeviceSecret) {
      const existing = databaseModule.deviceAccountSessionsDb.resolve(existingDeviceSecret);
      if (existing) {
        try {
          const added = databaseModule.deviceAccountSessionsDb.add(
            existing.principal, userId, changedAt, existing.wallet.generation,
          );
          connectionRevocationRegistry.revokeOlderGenerations(
            existing.principal.deviceSessionId, added.generation,
          );
          const slotId = databaseModule.deviceAccountSessionsDb.slotIdForUser(
            existing.principal.deviceSessionId, userId,
          );
          if (slotId) {
            const principal = { ...existing.principal, generation: added.generation };
            const wallet = databaseModule.deviceAccountSessionsDb.switch(
              principal, slotId, added.generation,
            );
            connectionRevocationRegistry.revokeOlderGenerations(
              principal.deviceSessionId, wallet.generation,
            );
            return { secret: existingDeviceSecret, wallet };
          }
        } catch (error) {
          if (!(error instanceof databaseModule.WalletConflictError)) throw error;
        }
      }
    }
    const created = databaseModule.deviceAccountSessionsDb.create(userId, ttlMs);
    return { secret: created.secret, wallet: created.wallet };
  }

  /** Closes every transport on devices changed by permanent user deletion. */
  revokeDevices(deviceSessionIds: readonly string[]): void {
    for (const deviceSessionId of deviceSessionIds) {
      connectionRevocationRegistry.revokeDevice(deviceSessionId);
    }
  }
}
