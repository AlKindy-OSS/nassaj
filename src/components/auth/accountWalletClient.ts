import {
  commitIdentityTransition,
  identityRequestSignal,
} from './accountIdentityBarrier';

export type DeviceAccount = {
  slotId: string;
  displayName: string;
  avatarUrl?: string | null;
  isActive: boolean;
  lastUsedAt: number | null;
};

export type AccountWallet = {
  generation: number;
  activeSlotId: string | null;
  accounts: DeviceAccount[];
};

export function isAccountWallet(value: unknown): value is AccountWallet {
  if (!value || typeof value !== 'object') return false;
  const wallet = value as Partial<AccountWallet>;
  if (!Number.isSafeInteger(wallet.generation) || Number(wallet.generation) < 0
      || (wallet.activeSlotId !== null && !boundedString(wallet.activeSlotId, 128))
      || !Array.isArray(wallet.accounts) || wallet.accounts.length > 5) return false;

  const slotIds = new Set<string>();
  let activeCount = 0;
  for (const candidate of wallet.accounts) {
    if (!candidate || typeof candidate !== 'object') return false;
    const account = candidate as Partial<DeviceAccount>;
    if (!boundedString(account.slotId, 128) || slotIds.has(account.slotId)
        || !boundedString(account.displayName, 256)
        || !(account.avatarUrl === undefined || account.avatarUrl === null
          || boundedString(account.avatarUrl, 2_048))
        || typeof account.isActive !== 'boolean'
        || !(account.lastUsedAt === null
          || (typeof account.lastUsedAt === 'number' && Number.isFinite(account.lastUsedAt)
            && account.lastUsedAt >= 0))) return false;
    slotIds.add(account.slotId);
    if (account.isActive) {
      activeCount += 1;
      if (account.slotId !== wallet.activeSlotId) return false;
    }
  }
  return wallet.activeSlotId === null
    ? activeCount === 0
    : slotIds.has(wallet.activeSlotId) && activeCount === 1;
}

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export type WalletMutationAction = 'switch' | 'add' | 'remove' | 'logout' | 'logout_all';

/** Complete a fenced wallet mutation without treating a generation-only edit as an identity switch. */
export function finishWalletIdentityTransition(
  transitionVersion: string,
  previousActiveSlotId: string | null,
  nextActiveSlotId: string | null,
  reason: string,
): boolean {
  if (nextActiveSlotId === previousActiveSlotId) {
    // The cookie generation still changed, so every tab must redial realtime,
    // but no account-bound cache, draft or outbox may be purged.
    commitIdentityTransition(transitionVersion, 'wallet_generation_changed');
    return false;
  }
  commitIdentityTransition(transitionVersion, reason);
  return true;
}

type WalletErrorBody = { code?: string; wallet?: AccountWallet };

export class AccountWalletError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly wallet?: AccountWallet,
    public readonly outcomeUnknown = false,
  ) {
    super(code);
  }
}

async function readJson<T>(response: Response, mutationSent = false): Promise<T> {
  let body: (T & WalletErrorBody) | null;
  try {
    body = await response.json() as (T & WalletErrorBody) | null;
  } catch {
    throw new AccountWalletError(
      mutationSent ? 'wallet_mutation_outcome_unknown' : 'invalid_wallet_response',
      response.status,
      undefined,
      mutationSent,
    );
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
      ? body.code : null;
    if (!code && mutationSent) {
      throw new AccountWalletError('wallet_mutation_outcome_unknown', response.status, undefined, true);
    }
    throw new AccountWalletError(code ?? `http_${response.status}`, response.status, body?.wallet);
  }
  if (!body) {
    throw new AccountWalletError(
      mutationSent ? 'wallet_mutation_outcome_unknown' : 'invalid_wallet_response',
      response.status,
      undefined,
      mutationSent,
    );
  }
  return body;
}

/**
 * Device-wallet requests deliberately use a raw, same-origin fetch. The legacy
 * authenticated fetch adds a Bearer JWT, which ADR-163 forbids beside a device
 * cookie.
 */
export async function readAccountWallet(signal?: AbortSignal, identityBypass = false): Promise<AccountWallet> {
  const response = await fetch('/api/auth/accounts', {
    credentials: 'same-origin', cache: 'no-store',
    signal: identityBypass ? signal : identityRequestSignal(signal),
  });
  const wallet = await readJson<AccountWallet>(response);
  if (!isAccountWallet(wallet)) throw new AccountWalletError('invalid_wallet_response', response.status);
  return wallet;
}

export async function mutateAccountWallet<T>(
  url: string,
  method: 'POST' | 'DELETE',
  action: WalletMutationAction,
  body: Record<string, unknown>,
  options: { slotId?: string; signal?: AbortSignal; identityBypass?: boolean } = {},
): Promise<T> {
  const signal = options.identityBypass ? options.signal : identityRequestSignal(options.signal);
  const query = new URLSearchParams({ action });
  if (options.slotId) query.set('slotId', options.slotId);
  const csrfResponse = await fetch(`/api/auth/accounts/csrf?${query.toString()}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  const csrf = await readJson<{ csrfToken?: string }>(csrfResponse);
  if (!csrf.csrfToken) throw new AccountWalletError('csrf_token_missing', csrfResponse.status);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AccountWalletError('wallet_mutation_outcome_unknown', 0, undefined, true);
  }
  try {
    const result = await readJson<T>(response, true);
    const mutationPayload = result as { generation?: unknown; activeSlotId?: unknown };
    if (!Number.isSafeInteger(mutationPayload?.generation)
        || (mutationPayload.activeSlotId !== null && typeof mutationPayload.activeSlotId !== 'string')) {
      throw new AccountWalletError('invalid_wallet_response', response.status);
    }
    return result;
  } catch (error) {
    // Once the state-changing request has been sent, an unreadable/truncated
    // success body cannot prove which identity the server committed. Never
    // replay; force an authoritative wallet reconciliation instead.
    if (error instanceof AccountWalletError && error.code === 'invalid_wallet_response') {
      throw new AccountWalletError('wallet_mutation_outcome_unknown', response.status, undefined, true);
    }
    throw error;
  }
}
