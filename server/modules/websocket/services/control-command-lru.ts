/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL) — idempotency cache for control commands.
 *
 * A client gives each control intent (one stop of one turn, one answer to one
 * permission request) a `commandId` and resends it unchanged after a reconnect
 * or a double press. This cache, keyed by (userId, commandId), makes the second
 * delivery return the first result instead of executing again:
 *   - the result is stored only AFTER execution (a failed run stores nothing);
 *   - concurrent duplicates share one in-flight promise (cleaned in finally);
 *   - a different fingerprint under the same id is `command_id_reused`.
 *
 * Bounded: TTL (10 min), per-user cap (200) and a global cap (QA condition 7),
 * each evicting the oldest entry. In-memory: a restart forgets it, which is safe
 * because after a restart nothing is running to stop twice.
 */

export type ControlCommandRun<T> =
  | { status: 'executed'; duplicate: false; result: T }
  | { status: 'duplicate'; duplicate: true; result: T }
  | { status: 'command_id_reused'; duplicate: false };

export type ControlCommandLruOptions = {
  ttlMs?: number;
  perUserCap?: number;
  globalCap?: number;
  now?: () => number;
};

type Stored<T> = { userKey: string; fingerprint: string; result: T; expiresAt: number };
type Inflight<T> = { fingerprint: string; promise: Promise<T> };

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_PER_USER_CAP = 200;
const DEFAULT_GLOBAL_CAP = 10_000;

function compositeKey(userKey: string, commandId: string): string {
  return `${userKey}\u0000${commandId}`;
}

export class ControlCommandLru<T> {
  readonly limits: Readonly<{ ttlMs: number; perUserCap: number; globalCap: number }>;
  readonly #now: () => number;
  /** Insertion-ordered: the first key is the globally oldest entry. */
  readonly #entries = new Map<string, Stored<T>>();
  /** Per-user insertion-ordered key sets, for the per-user cap. */
  readonly #byUser = new Map<string, Set<string>>();
  readonly #inflight = new Map<string, Inflight<T>>();

  constructor(options: ControlCommandLruOptions = {}) {
    this.limits = Object.freeze({
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      perUserCap: options.perUserCap ?? DEFAULT_PER_USER_CAP,
      globalCap: options.globalCap ?? DEFAULT_GLOBAL_CAP,
    });
    this.#now = options.now ?? Date.now;
  }

  /**
   * Executes `execute` once per (userKey, commandId, fingerprint) within the TTL.
   * A stored or in-flight result with another fingerprint is never returned.
   */
  async run(
    userKey: string,
    commandId: string,
    fingerprint: string,
    execute: () => Promise<T>,
  ): Promise<ControlCommandRun<T>> {
    const key = compositeKey(userKey, commandId);
    const stored = this.#readLive(key);
    if (stored) {
      return stored.fingerprint === fingerprint
        ? { status: 'duplicate', duplicate: true, result: stored.result }
        : { status: 'command_id_reused', duplicate: false };
    }
    const inflight = this.#inflight.get(key);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) return { status: 'command_id_reused', duplicate: false };
      return { status: 'duplicate', duplicate: true, result: await inflight.promise };
    }
    return this.#execute(key, userKey, fingerprint, execute);
  }

  async #execute(
    key: string,
    userKey: string,
    fingerprint: string,
    execute: () => Promise<T>,
  ): Promise<ControlCommandRun<T>> {
    const promise = execute();
    this.#inflight.set(key, { fingerprint, promise });
    try {
      const result = await promise;
      this.#store(key, { userKey, fingerprint, result, expiresAt: this.#now() + this.limits.ttlMs });
      return { status: 'executed', duplicate: false, result };
    } finally {
      this.#inflight.delete(key);
    }
  }

  #readLive(key: string): Stored<T> | undefined {
    const stored = this.#entries.get(key);
    if (!stored) return undefined;
    if (stored.expiresAt > this.#now()) return stored;
    this.#delete(key);
    return undefined;
  }

  #store(key: string, stored: Stored<T>): void {
    this.#delete(key);
    this.#entries.set(key, stored);
    let userKeys = this.#byUser.get(stored.userKey);
    if (!userKeys) {
      userKeys = new Set();
      this.#byUser.set(stored.userKey, userKeys);
    }
    userKeys.add(key);
    if (userKeys.size > this.limits.perUserCap) this.#delete(userKeys.values().next().value as string);
    while (this.#entries.size > this.limits.globalCap) {
      this.#delete(this.#entries.keys().next().value as string);
    }
  }

  #delete(key: string): void {
    const stored = this.#entries.get(key);
    if (!stored) return;
    this.#entries.delete(key);
    const userKeys = this.#byUser.get(stored.userKey);
    userKeys?.delete(key);
    if (userKeys?.size === 0) this.#byUser.delete(stored.userKey);
  }

  /** Number of stored results. */
  size(): number {
    return this.#entries.size;
  }

  /** Number of executions still running. */
  inflightCount(): number {
    return this.#inflight.size;
  }

  /** Drops every stored result (tests only; in-flight runs finish normally). */
  clear(): void {
    this.#entries.clear();
    this.#byUser.clear();
  }
}

/** Process-wide cache shared by stop and approval commands. */
export const controlCommandLru = new ControlCommandLru<unknown>();
