import type { Database } from 'better-sqlite3';

import { AgentReviewError } from './agent-review-validation.js';

declare const invocationBrand: unique symbol;
export type ReviewTransactionInvocation = { readonly [invocationBrand]: true };
export type ReviewEffectOutcome = Readonly<{ notStarted: boolean; effectState: 'not_started' | 'settled' | 'outcome_unknown' }>;
type Evidence = { db: Database; request: object; response: object; principal: Readonly<{ userId: number }>;
  method: 'GET' | 'PATCH'; attempted: boolean; state: ReviewEffectOutcome['effectState']; cleanupFailure?: unknown };
const evidence = new WeakMap<object, Evidence>();

/** Auth composition alone enrolls an opaque invocation; importing callers are source-inventory restricted. */
export function createReviewTransactionInvocation(input: Omit<Evidence, 'attempted' | 'state' | 'cleanupFailure'>): ReviewTransactionInvocation {
  if (!Object.isFrozen(input.principal) || !Number.isSafeInteger(input.principal.userId) || input.principal.userId <= 0) {
    throw new AgentReviewError('untrusted_provenance');
  }
  const invocation = Object.freeze({}) as ReviewTransactionInvocation;
  evidence.set(invocation, { ...input, attempted: false, state: 'not_started' });
  return invocation;
}

/** The auth serializer may read only its exact request/response/connection/principal-bound evidence. */
export function readReviewEffectOutcome(invocation: ReviewTransactionInvocation, binding: Omit<Evidence, 'attempted' | 'state' | 'cleanupFailure'>): ReviewEffectOutcome {
  const record = evidence.get(invocation);
  if (!record || record.db !== binding.db || record.request !== binding.request || record.response !== binding.response
    || record.principal !== binding.principal || record.method !== binding.method) {
    return Object.freeze({ notStarted: false, effectState: 'outcome_unknown' });
  }
  return Object.freeze({ notStarted: !record.attempted, effectState: record.state });
}

function rollback(db: Database, record: Evidence | undefined, settle: boolean): void {
  try {
    db.exec('ROLLBACK');
    if (record && settle) record.state = 'settled';
  } catch (error) { if (record) record.cleanupFailure = error; }
}

/** Repository-only producer: explicit owned boundaries, no exception-code/transaction-state outcome inference. */
export function runReviewOwnedTransaction<T>(db: Database, actorUserId: number,
  invocation: ReviewTransactionInvocation | undefined, callback: () => T): T {
  if (db.inTransaction) throw new AgentReviewError('nested_transaction');
  const record = invocation ? evidence.get(invocation) : undefined;
  if (invocation && (!record || record.db !== db || record.principal.userId !== actorUserId
    || record.method !== 'PATCH' || record.attempted)) throw new AgentReviewError('untrusted_provenance');
  if (record) { record.attempted = true; record.state = 'outcome_unknown'; }
  db.exec('BEGIN IMMEDIATE'); // A throwing BEGIN supplies no positive evidence; never retry.
  let result: T;
  try { result = callback(); }
  catch (error) { rollback(db, record, true); throw error; }
  try { db.exec('COMMIT'); }
  catch (error) { rollback(db, record, false); throw error; }
  // Plain private-record assignment: synchronous, nonthrowing, before mapping/callback/Promise resolution.
  if (record) record.state = 'settled';
  return result;
}
