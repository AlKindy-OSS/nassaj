/**
 * provider-secrets-store.codes — B-1547: the refusal code and message the store
 * throws when a keys file is present but unreadable. A dependency-free leaf so
 * the store (also loaded by plain-node scripts) and its HTTP mapping share one
 * definition, and a test that mocks the store does not break the mapping.
 */

/** Typed code for a write refused because the keys file is unreadable. */
export const PROVIDER_SECRETS_STORE_UNREADABLE = 'PROVIDER_SECRETS_STORE_UNREADABLE';

/** Generic, cause-free message for that refusal; the repair is an operator act. */
export const PROVIDER_SECRETS_STORE_REPAIR_MESSAGE = 'The credential store needs operator repair.';
