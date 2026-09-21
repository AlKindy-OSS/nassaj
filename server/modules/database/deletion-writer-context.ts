import type Database from 'better-sqlite3';

import { DeletionOperationError } from './deletion-operation.contract.js';
import type { DeleteCommand, DeleteTarget, VerifiedInventory } from './deletion-operation.contract.js';

/** An issuer-owned reservation, obtained by opaque token identity, not by validating DTO fields. */
export interface DeletionCapabilityReservation {
  readonly inventory: VerifiedInventory;
  /** Revalidate the actual held fence; expiry alone never establishes external writer exclusion. */
  recheck(): void;
  /** A failed/ambiguous COMMIT spends the token too; S1c decides when its physical fence may be released. */
  finish(outcome:'committed'|'failed_or_unknown'):void;
}
/** Injected only after S1c proof. There is deliberately NO production issuer implementation or default issuer. */
export interface DeletionCapabilityIssuer {
  claim(token:object,db:Database.Database,command:DeleteCommand,target:DeleteTarget):DeletionCapabilityReservation;
}

/** Refuse absent/forged-shaped authority before the issuer is consulted; the issuer registry makes the final identity check. */
export function claimDeletionCapability(issuer:DeletionCapabilityIssuer|undefined,token:unknown,db:Database.Database,command:DeleteCommand,target:DeleteTarget):DeletionCapabilityReservation {
  if(!issuer||!token||typeof token!=='object')throw new DeletionOperationError('DELETION_CAPABILITY_REQUIRED');
  return invokeSynchronous(issuer.claim,issuer,[token,db,command,target]);
}

/** Every callback used by the SQL core must remain synchronous; reject async functions before invoking them. */
export function invokeSynchronous<T>(fn:(...args:never[])=>T,receiver:unknown,args:readonly unknown[]):T {
  if(fn.constructor.name==='AsyncFunction')throw new DeletionOperationError('DELETION_ASYNC_BOUNDARY');
  const result=Reflect.apply(fn,receiver,args) as T;
  if(result&&typeof (result as {then?:unknown}).then==='function')throw new DeletionOperationError('DELETION_ASYNC_BOUNDARY');
  return result;
}
