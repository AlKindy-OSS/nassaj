import { AsyncLocalStorage } from 'node:async_hooks';

import type { PermissionExecutionHandle } from './execution-gateway.service.js';

/**
 * B-1414 — the ADR-134 catalog permit a probe is running under, made visible to
 * the provider code it calls, and the moment that permit ends.
 *
 * `runAuthorizedProviderCatalog` admits one permit per catalog probe and settles
 * it when the probe resolves. A child that the probe starts must therefore (a)
 * execute the identity THAT permit was fingerprinted against — never one
 * re-acquired on the side — and (b) never outlive the permit. The scope carries
 * the execution handle for (a) and an AbortSignal that fires when the probe
 * settles for (b). Code that finds no scope is not under a catalog permit and
 * must not start a provider child at all.
 */
export type CatalogLaunchScope = Readonly<{
  execution: PermissionExecutionHandle;
  /** Aborts when the enclosing catalog probe settles (its permit is spent). */
  signal: AbortSignal;
}>;

const storage = new AsyncLocalStorage<CatalogLaunchScope>();

/**
 * Runs `probe` inside a catalog launch scope for `execution`. The scope's signal
 * aborts as soon as `probe` settles, success or failure.
 */
export const runInCatalogLaunchScope = async <T>(
  execution: PermissionExecutionHandle,
  probe: () => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  try {
    return await storage.run(Object.freeze({ execution, signal: controller.signal }), probe);
  } finally {
    controller.abort();
  }
};

/** The catalog permit scope the current async context runs under, or null. */
export const currentCatalogLaunchScope = (): CatalogLaunchScope | null => storage.getStore() ?? null;
