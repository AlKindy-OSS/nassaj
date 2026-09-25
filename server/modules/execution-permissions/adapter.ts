import fs from 'node:fs';

import type { PermissionChildIdentity } from '@/modules/database/index.js';

import type { PermissionExecutionHandle } from './execution-gateway.service.js';

const readSmall = (file: string): string => {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
};

/** Exact kernel identity (pid + boot id + start ticks) of a live child on this host (T-1593). */
export const readRuntimeProcessIdentity = (pid: number): PermissionChildIdentity | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const stat = readSmall(`/proc/${pid}/stat`);
  if (!stat.includes(')')) return null;
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!startTicks) return null;
  return { pid, bootId: readSmall('/proc/sys/kernel/random/boot_id') || 'boot-unavailable', startTicks };
};

/** Attempt one truthful settlement; the gateway retains its durable block on failure. */
const settleAfterFailure = (execution: PermissionExecutionHandle, outcome: 'failed' | 'reconciled_unknown'): void => {
  try { execution.settle(outcome); } catch { /* Preserve the original effect/evidence failure. */ }
};

/**
 * Execute after permit consumption and separate provider outcome from receipt persistence.
 * Invocation alone does not prove that a synchronously throwing adapter had no effect.
 */
export const runPermissionExecutionAdapter = async <T>(
  execution: PermissionExecutionHandle | null | undefined,
  adapter: () => Promise<T>,
  // T-1593: a local effect records its child's exact identity at start; reconciliation
  // treats it as local only once that child is proven dead. Absent = external.
  resolveEffectIdentity?: () => PermissionChildIdentity | null,
): Promise<T> => {
  if (!execution) return adapter();
  execution.consume();
  // The durable start record is also the final current-actor check. It must be
  // committed before entering an adapter that may spawn or call a provider;
  // doing it afterwards leaves an untracked effect when the device identity
  // changes between admission and invocation.
  try { execution.markStarted(resolveEffectIdentity?.() ?? undefined); }
  catch (error) {
    settleAfterFailure(execution, 'reconciled_unknown');
    throw error;
  }
  let pending: Promise<T>;
  try { pending = adapter(); }
  catch (error) {
    settleAfterFailure(execution, 'failed');
    throw error;
  }
  const child = resolveEffectIdentity?.() ?? null;
  if (child) {
    try { execution.attachChildIdentity(child); }
    catch (error) {
      void Promise.resolve(pending).catch(() => {});
      settleAfterFailure(execution, 'reconciled_unknown');
      throw error;
    }
  }
  let value: T;
  try { value = await pending; }
  catch (error) {
    settleAfterFailure(execution, 'failed');
    throw error;
  }
  // Persistence failure here must never trigger a second, contradictory failed settlement.
  execution.settle('succeeded');
  return value;
};
