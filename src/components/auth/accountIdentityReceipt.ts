import type { AuthUser } from './types';
import type { AccountWallet } from './accountWalletClient';

const RECEIPT_KEY = 'nassaj_identity_completion_v1';

export type IdentityCompletionReceipt = Readonly<{
  version: string;
  walletGeneration: number;
  activeSlotId: string | null;
  userKey: string;
}>;

/** Return a stable, non-ambiguous key for comparing hydrated identities. */
export function authUserKey(user: AuthUser | null | undefined): string | null {
  if (!user) return null;
  if (user.id !== undefined && user.id !== null) return `id:${String(user.id)}`;
  return user.username ? `username:${user.username}` : null;
}

/** Read this tab's last completed reconciliation proof. */
export function readIdentityCompletionReceipt(): IdentityCompletionReceipt | null {
  try {
    const raw = sessionStorage.getItem(RECEIPT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<IdentityCompletionReceipt>;
    if (typeof value.version !== 'string' || !value.version
        || !Number.isSafeInteger(value.walletGeneration) || Number(value.walletGeneration) < 0
        || (value.activeSlotId !== null && typeof value.activeSlotId !== 'string')
        || typeof value.userKey !== 'string' || !value.userKey) return null;
    return {
      version: value.version,
      walletGeneration: Number(value.walletGeneration),
      activeSlotId: value.activeSlotId,
      userKey: value.userKey,
    };
  } catch {
    return null;
  }
}

/** Persist a tab-local proof only after authoritative hydration has completed. */
export function writeIdentityCompletionReceipt(
  version: string,
  wallet: AccountWallet,
  user: AuthUser,
): boolean {
  const userKey = authUserKey(user);
  if (!userKey) return false;
  try {
    sessionStorage.setItem(RECEIPT_KEY, JSON.stringify({
      version,
      walletGeneration: wallet.generation,
      activeSlotId: wallet.activeSlotId,
      userKey,
    } satisfies IdentityCompletionReceipt));
    return true;
  } catch {
    return false;
  }
}

/** Remove proof that can no longer be tied to the current local identity. */
export function clearIdentityCompletionReceipt(): void {
  try {
    sessionStorage.removeItem(RECEIPT_KEY);
  } catch {
    // Storage denial only removes an optimisation; full reconciliation remains safe.
  }
}

/** True when the receipt proves the currently painted identity and active slot. */
export function receiptMatchesIdentity(
  receipt: IdentityCompletionReceipt | null,
  wallet: AccountWallet,
  user: AuthUser | null,
): boolean {
  return Boolean(receipt
    && receipt.activeSlotId === wallet.activeSlotId
    && receipt.userKey === authUserKey(user));
}
