import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  currentCatalogLaunchScope,
  type CatalogLaunchScope,
} from '@/modules/execution-permissions/catalog-launch-scope.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import { resolveCodexMachineRuntime } from '@/shared/codex-executable.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { codexLaunchIdentityFor, spawnReservedCodex } from './codex-reserved-spawn.js';

/**
 * Per-user refresh of `<CODEX_HOME>/models_cache.json`.
 *
 * The Codex CLI only rewrites that file when it runs under that CODEX_HOME, so
 * an isolated user who has not run Codex lately keeps a catalog fetched by an
 * older CLI (missing newer models). `codex debug models` (without `--bundled`)
 * fetches the live catalog for the credentials in CODEX_HOME and rewrites the
 * cache — verified against codex-cli 0.156.0. It is always run under the
 * requesting user's OWN CODEX_HOME: another user's cache is never read or copied.
 */

export const CODEX_MODELS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * B-1414: the refresh child lives inside the caller's catalog permit, which ends
 * when the probe returns. So the caller waits for the WHOLE refresh — the wait
 * is the hard timeout plus a short margin that lets the timeout's own SIGKILL
 * and exit settle first — and a refresh is never cut off early by its permit.
 * Both stay well under the 30 s permit lease.
 */
export const CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS = 22_000;
export const CODEX_MODELS_REFRESH_WAIT_MS = CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS + 1_000;
export const CODEX_MODELS_REFRESH_BACKOFF_MS = 10 * 60 * 1000;
export const CODEX_MODELS_REFRESH_MAX_CONCURRENT = 2;
const CODEX_MODELS_CACHE_FILE = 'models_cache.json';

export type CodexModelsCacheMeta = { fetchedAt: number | null; clientVersion: string | null };
export type CodexStalenessReason = 'missing' | 'old' | 'client_version' | null;

const parseVersion = (value: string): number[] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  return match ? match.slice(1, 4).map(Number) : null;
};

/** True when `recorded` is a strictly older semver triple than `installed` (unparseable → older). */
export const isOlderCodexVersion = (recorded: string | null, installed: string | null): boolean => {
  const target = installed ? parseVersion(installed) : null;
  if (!target) return false;
  const current = recorded ? parseVersion(recorded) : null;
  if (!current) return true;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== target[index]) return current[index] < target[index];
  }
  return false;
};

/**
 * Decides whether a user's models cache must be refreshed. `meta === null`
 * means the file is missing or unreadable.
 */
export const codexModelsCacheStaleness = (
  meta: CodexModelsCacheMeta | null,
  installedVersion: string | null,
  nowMs: number,
): CodexStalenessReason => {
  if (!meta) return 'missing';
  if (meta.fetchedAt === null || nowMs - meta.fetchedAt > CODEX_MODELS_CACHE_MAX_AGE_MS) return 'old';
  if (isOlderCodexVersion(meta.clientVersion, installedVersion)) return 'client_version';
  return null;
};

/** Reads only `fetched_at` / `client_version` from a user's models cache. */
export const readCodexModelsCacheMeta = async (codexHome: string): Promise<CodexModelsCacheMeta | null> => {
  try {
    const record = readObjectRecord(JSON.parse(await readFile(path.join(codexHome, CODEX_MODELS_CACHE_FILE), 'utf8')));
    if (!record) return null;
    const fetchedAt = Date.parse(readOptionalString(record.fetched_at) ?? '');
    return {
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
      clientVersion: readOptionalString(record.client_version) ?? null,
    };
  } catch {
    return null;
  }
};

/** The env a refresh runs under and the CODEX_HOME it rewrites (derived from that env). */
export type CodexRefreshTarget = { codexHome: string; env: NodeJS.ProcessEnv };

export type CodexRefreshTargetDeps = {
  isIsolated?: (provider: 'codex') => boolean;
  resolveOwnEnv?: (userId: string | number) => NodeJS.ProcessEnv;
};

const hasUserId = (userId: string | number | null | undefined): userId is string | number => (
  userId !== null && userId !== undefined && userId !== ''
);

/**
 * Returns a refresh target only when `env` (the picker's resolved env) points at
 * the user's OWN isolated CODEX_HOME. A granted home (another member's
 * credentials) or shared mode (operator ~/.codex) yields null: read-only, never
 * spawn on credentials that are not the requester's.
 */
export const ownCodexRefreshTarget = (
  userId: string | number | null | undefined,
  env: NodeJS.ProcessEnv,
  deps: CodexRefreshTargetDeps = {},
): CodexRefreshTarget | null => {
  if (!hasUserId(userId)) return null;
  const isIsolated = deps.isIsolated ?? ((provider) => isProviderIsolated(provider));
  if (!isIsolated('codex')) return null;
  const codexHome = readOptionalString(env.CODEX_HOME);
  if (!codexHome) return null;
  const resolveOwnEnv = deps.resolveOwnEnv
    ?? ((id) => resolveProviderEnv(id, 'codex', process.env, 'chat', { honorGrants: false }));
  return readOptionalString(resolveOwnEnv(userId).CODEX_HOME) === codexHome ? { codexHome, env } : null;
};

type SpawnedChild = {
  kill: (signal: NodeJS.Signals) => unknown;
  once: (event: string, listener: (...args: never[]) => void) => unknown;
};

export type CodexRefreshProcessDeps = {
  /**
   * The catalog permit scope this refresh runs under. Defaults to the current
   * async context's scope; `null` (or no scope) refuses the spawn.
   */
  scope?: CatalogLaunchScope | null;
  identityFor?: (scope: CatalogLaunchScope) => Promise<unknown>;
  spawnReserved?: (
    identity: unknown, env: NodeJS.ProcessEnv, args: string[], options: Record<string, unknown>,
  ) => SpawnedChild;
  hardTimeoutMs?: number;
};

/** Raised when a refresh is asked to run outside a catalog permit. Never spawns. */
export const CODEX_MODELS_REFRESH_PERMIT_REQUIRED = 'CODEX_MODELS_REFRESH_PERMIT_REQUIRED';

/**
 * The permit ended before the refresh could start, or the child was killed
 * because it ended. Not a refresh failure: no failure backoff is recorded.
 */
export const CODEX_MODELS_REFRESH_PERMIT_ENDED = 'CODEX_MODELS_REFRESH_PERMIT_ENDED';

const permitEndedError = (): Error => Object.assign(
  new Error(CODEX_MODELS_REFRESH_PERMIT_ENDED),
  { code: CODEX_MODELS_REFRESH_PERMIT_ENDED },
);

/** True for the permit-ended outcome (see {@link CODEX_MODELS_REFRESH_PERMIT_ENDED}). */
export const isCodexRefreshPermitEnded = (error: unknown): boolean => (
  (error as { code?: unknown } | null)?.code === CODEX_MODELS_REFRESH_PERMIT_ENDED
);

/**
 * B-1414: the identity is the one the CALLER's catalog permit was fingerprinted
 * against (`execution.launchIdentity`), never re-acquired on the side. Only the
 * identity fields are handed over, so a failure here can never try to settle
 * the caller's already-started permit.
 */
const identityFromScope = (scope: CatalogLaunchScope): Promise<unknown> => codexLaunchIdentityFor({
  launchIdentity: scope.execution.launchIdentity,
  launchIdentityError: scope.execution.launchIdentityError,
});

/**
 * Runs `codex debug models` under the target's already-resolved env through the
 * shared guarded launch path (no env recomputation). Output is discarded; only
 * the exit status matters. Resolves on exit 0, rejects otherwise.
 *
 * B-1414: it runs only inside the caller's ADR-134 catalog permit — the scope
 * supplies the launch identity, and the child is SIGKILLed the moment that
 * permit ends (the probe settled), so it can never outlive it. The hard timeout
 * stays as a second, independent bound.
 */
export const runCodexModelsRefreshProcess = async (
  target: CodexRefreshTarget,
  deps: CodexRefreshProcessDeps = {},
): Promise<void> => {
  const scope = deps.scope === undefined ? currentCatalogLaunchScope() : deps.scope;
  if (!scope) throw new Error(CODEX_MODELS_REFRESH_PERMIT_REQUIRED);
  const identityFor = deps.identityFor ?? identityFromScope;
  const spawnReserved = deps.spawnReserved
    ?? ((identity, env, args, options) => spawnReservedCodex(spawn, identity, env, args, options));
  const hardTimeoutMs = deps.hardTimeoutMs ?? CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS;
  const identity = await identityFor(scope);
  if (scope.signal.aborted) throw permitEndedError();
  await new Promise<void>((resolve, reject) => {
    const child = spawnReserved(identity, target.env, ['debug', 'models'], {
      cwd: target.codexHome,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let killedByPermitEnd = false;
    const killOnPermitEnd = () => {
      killedByPermitEnd = true;
      child.kill('SIGKILL');
    };
    const cleanup = () => {
      clearTimeout(timer);
      scope.signal.removeEventListener('abort', killOnPermitEnd);
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), hardTimeoutMs);
    scope.signal.addEventListener('abort', killOnPermitEnd, { once: true });
    child.once('error', (error: Error) => { cleanup(); reject(error); });
    child.once('exit', (code: number | null, signal: string | null) => {
      cleanup();
      if (code === 0) resolve();
      else if (killedByPermitEnd) reject(permitEndedError());
      else reject(new Error(`codex debug models exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
    });
  });
};

export type CodexModelsRefresherDeps = {
  runRefresh?: (target: CodexRefreshTarget) => Promise<void>;
  readMeta?: (codexHome: string) => Promise<CodexModelsCacheMeta | null>;
  readInstalledVersion?: () => string | null;
  onRefreshed?: (userId: string | number) => void | Promise<void>;
  now?: () => number;
  waitMs?: number;
  backoffMs?: number;
  maxConcurrent?: number;
  log?: (message: string) => void;
};

const defaultInstalledVersion = (): string | null => {
  try {
    return resolveCodexMachineRuntime().version;
  } catch {
    return null;
  }
};

/**
 * Builds a refresher with single-flight and failure backoff per CODEX_HOME, a
 * global concurrency cap (over cap → no spawn, the current file is served), and
 * a bounded wait of `waitMs`. B-1414: by default that wait outlasts the child's
 * hard timeout, so the starting caller holds its catalog permit for the whole
 * refresh; a verified success fires `onRefreshed` (catalog invalidation). A
 * child killed because its permit ended is not a failure and records no backoff.
 */
export const createCodexModelsRefresher = (deps: CodexModelsRefresherDeps = {}) => {
  const runRefresh = deps.runRefresh ?? ((target) => runCodexModelsRefreshProcess(target));
  const readMeta = deps.readMeta ?? readCodexModelsCacheMeta;
  const readInstalledVersion = deps.readInstalledVersion ?? defaultInstalledVersion;
  const now = deps.now ?? (() => Date.now());
  const waitMs = deps.waitMs ?? CODEX_MODELS_REFRESH_WAIT_MS;
  const backoffMs = deps.backoffMs ?? CODEX_MODELS_REFRESH_BACKOFF_MS;
  const maxConcurrent = deps.maxConcurrent ?? CODEX_MODELS_REFRESH_MAX_CONCURRENT;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const inFlight = new Map<string, Promise<void>>();
  const backoffUntil = new Map<string, number>();
  let active = 0;

  /** Exit 0 is not enough: the file must now be newer than before and fresh. */
  const assertRefreshed = async (codexHome: string, before: CodexModelsCacheMeta | null) => {
    const after = await readMeta(codexHome);
    const advanced = after?.fetchedAt != null && after.fetchedAt > (before?.fetchedAt ?? -Infinity);
    if (!advanced || codexModelsCacheStaleness(after, readInstalledVersion(), now()) !== null) {
      throw new Error('exited 0 but models cache was not updated');
    }
  };

  const start = (
    userId: string | number, target: CodexRefreshTarget, before: CodexModelsCacheMeta | null, reason: string,
  ): Promise<void> => {
    const key = target.codexHome;
    active += 1;
    const run = (async () => {
      try {
        await runRefresh(target);
        await assertRefreshed(key, before);
        backoffUntil.delete(key);
        await deps.onRefreshed?.(userId);
      } catch (error) {
        if (isCodexRefreshPermitEnded(error)) {
          // Cut short by the permit, not by Codex: the next caller may retry at once.
          log(`[codex-models] refresh stopped with its permit user=${String(userId)} reason=${reason}`);
          return;
        }
        backoffUntil.set(key, now() + backoffMs);
        const detail = error instanceof Error ? error.message : 'unknown error';
        log(`[codex-models] refresh failed user=${String(userId)} reason=${reason}: ${detail}`);
      } finally {
        active -= 1;
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
    return run;
  };

  /**
   * Refreshes the target's models cache when stale; never throws. Returns once
   * the refresh finished or `waitMs` elapsed, whichever comes first.
   */
  const ensureFresh = async (userId: string | number, target: CodexRefreshTarget): Promise<void> => {
    const key = target.codexHome;
    let pending = inFlight.get(key);
    if (!pending) {
      if ((backoffUntil.get(key) ?? 0) > now()) return;
      const before = await readMeta(key);
      const reason = codexModelsCacheStaleness(before, readInstalledVersion(), now());
      if (!reason) return;
      pending = inFlight.get(key);
      if (!pending) {
        if (active >= maxConcurrent) return;
        pending = start(userId, target, before, reason);
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
    try {
      await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return { ensureFresh };
};

let catalogInvalidator: ((userId: string | number) => void | Promise<void>) | null = null;

/** Registered by the provider-models service to drop a user's cached Codex catalog. */
export const setCodexCatalogInvalidator = (
  invalidator: ((userId: string | number) => void | Promise<void>) | null,
): void => {
  catalogInvalidator = invalidator;
};

export const codexModelsRefresher = createCodexModelsRefresher({
  onRefreshed: (userId) => catalogInvalidator?.(userId),
});
