import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
export const CODEX_MODELS_REFRESH_WAIT_MS = 10_000;
export const CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS = 30_000;
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
  identityFor?: () => Promise<unknown>;
  spawnReserved?: (
    identity: unknown, env: NodeJS.ProcessEnv, args: string[], options: Record<string, unknown>,
  ) => SpawnedChild;
  hardTimeoutMs?: number;
};

/**
 * Runs `codex debug models` under the target's already-resolved env through the
 * shared guarded launch path (no env recomputation). Output is discarded; only
 * the exit status matters. Resolves on exit 0, rejects otherwise.
 */
export const runCodexModelsRefreshProcess = async (
  target: CodexRefreshTarget,
  deps: CodexRefreshProcessDeps = {},
): Promise<void> => {
  const identityFor = deps.identityFor ?? (() => codexLaunchIdentityFor(null));
  const spawnReserved = deps.spawnReserved
    ?? ((identity, env, args, options) => spawnReservedCodex(spawn, identity, env, args, options));
  const hardTimeoutMs = deps.hardTimeoutMs ?? CODEX_MODELS_REFRESH_HARD_TIMEOUT_MS;
  const identity = await identityFor();
  await new Promise<void>((resolve, reject) => {
    const child = spawnReserved(identity, target.env, ['debug', 'models'], {
      cwd: target.codexHome,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), hardTimeoutMs);
    child.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
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
 * a bounded wait: callers wait at most `waitMs`, while a slower refresh keeps
 * running and still fires `onRefreshed` (catalog invalidation) on a verified success.
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
