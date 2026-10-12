/**
 * provider-secrets-store.errors — B-1547: the HTTP face of the store's refusal
 * to rewrite an unreadable keys file. The store itself throws a plain typed
 * Error (it also loads outside the server); server write paths wrap their store
 * call in {@link withProviderSecretsStore} so the refusal reaches the client as
 * a 409 AppError with a generic message and no cause.
 */

import { AppError } from '@/shared/utils.js';

import {
  PROVIDER_SECRETS_STORE_REPAIR_MESSAGE,
  PROVIDER_SECRETS_STORE_UNREADABLE,
} from './provider-secrets-store.codes.js';

/** True when `error` is the store's unreadable-keys-file refusal. */
export function isProviderSecretsStoreUnreadable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === PROVIDER_SECRETS_STORE_UNREADABLE;
}

/** The 409 AppError for that refusal; carries no cause and no details. */
export function providerSecretsStoreUnreadableError(): AppError {
  return new AppError(PROVIDER_SECRETS_STORE_REPAIR_MESSAGE, {
    code: PROVIDER_SECRETS_STORE_UNREADABLE,
    statusCode: 409,
  });
}

/** Runs one store write; its unreadable-store refusal becomes the typed 409. */
export function withProviderSecretsStore<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (isProviderSecretsStoreUnreadable(error)) throw providerSecretsStoreUnreadableError();
    throw error;
  }
}
