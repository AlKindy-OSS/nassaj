import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-user "broken model" store — the lazy-detection backstop for the live
 * Claude catalog (real-model-discovery, B-MODEL-DISCOVERY).
 *
 * The primary discovery mechanism is the authenticated `supportedModels()` probe
 * in claude-catalog.client.ts: under the user's real CLAUDE_CONFIG_DIR, Anthropic
 * only advertises the models that subscription is entitled to, so an unreleased
 * model (e.g. claude-fable-5) is filtered out at the source. This store covers
 * the residual case: a model that the authenticated catalog DOES advertise but
 * that actually fails at first real use because Anthropic has not enabled it for
 * that account — the SDK surfaces this as `assistant.error === 'model_not_found'`
 * or a `result.api_error_status === 404`. When the send path observes that, it
 * records the offending (userId, modelValue) here, and the catalog client
 * excludes it from every later catalog for that same user.
 *
 * Design constraints:
 *  - Keyed per user, exactly like the catalog circuit/cache, so one account's
 *    broken model never hides it from another account that CAN use it.
 *  - In-memory fast path (the catalog hot path reads it synchronously) backed by
 *    a best-effort JSON file under ~/.cloudcli so a known-broken model stays
 *    hidden across restarts instead of flickering back into the picker.
 *  - Never throws: every disk error is swallowed. Losing the persisted set only
 *    means a broken model may reappear once until it is re-observed — the live
 *    catalog still works. The send path must never break because of this store.
 */

const STORE_VERSION = 1;

type BrokenModelsFile = {
  version: number;
  // userKey -> sorted list of broken model values
  entries: Record<string, string[]>;
};

const getStorePath = (): string => path.join(os.homedir(), '.cloudcli', 'claude-broken-models.json');

/**
 * Normalizes a userId into a stable string key. `null`/`undefined`/empty (system,
 * anonymous, platform-mode) collapse to a single shared bucket — the same scope
 * resolveProviderEnv uses for "no isolation", so the broken-model set lines up
 * with the env the probe/spawn actually ran under.
 */
export function brokenModelsUserKey(userId: string | number | null | undefined): string {
  if (userId === null || userId === undefined || userId === '') {
    return '__shared__';
  }
  return String(userId);
}

// In-memory authoritative copy. Loaded once from disk on first access.
const memory = new Map<string, Set<string>>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let storePathOverride: string | null = null;

const resolveStorePath = (): string => storePathOverride ?? getStorePath();

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

async function loadFromDisk(): Promise<void> {
  if (loaded) {
    return;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await readFile(resolveStorePath(), 'utf8');
        const parsed = JSON.parse(raw) as Partial<BrokenModelsFile>;
        if (parsed?.version === STORE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
          for (const [key, values] of Object.entries(parsed.entries)) {
            if (isStringArray(values) && values.length > 0) {
              memory.set(key, new Set(values));
            }
          }
        }
      } catch {
        // No file yet, unreadable, or invalid JSON → start empty. Never throw.
      } finally {
        loaded = true;
      }
    })().finally(() => {
      loadPromise = null;
    });
  }
  await loadPromise;
}

async function persist(): Promise<void> {
  try {
    const entries: Record<string, string[]> = {};
    for (const [key, set] of memory.entries()) {
      if (set.size > 0) {
        entries[key] = [...set].sort();
      }
    }
    const payload: BrokenModelsFile = { version: STORE_VERSION, entries };
    const storePath = resolveStorePath();
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort persistence: a failed write only risks re-showing a broken
    // model once after restart. Never propagate into the caller.
  }
}

/**
 * Returns the set of model values known to be broken for this user. Loads the
 * persisted store on first call. The returned set is a defensive COPY, so callers
 * cannot mutate the in-memory authoritative copy.
 */
export async function getBrokenModels(
  userId: string | number | null | undefined,
): Promise<Set<string>> {
  await loadFromDisk();
  const key = brokenModelsUserKey(userId);
  const set = memory.get(key);
  return set ? new Set(set) : new Set<string>();
}

/**
 * Records a model value as broken for this user (lazy detection). Idempotent: a
 * model already marked is a no-op (and skips the disk write). Returns true when a
 * NEW value was added (so the caller can log a single line). Never throws.
 */
export async function recordBrokenModel(
  userId: string | number | null | undefined,
  modelValue: string,
): Promise<boolean> {
  const value = typeof modelValue === 'string' ? modelValue.trim() : '';
  if (!value) {
    return false;
  }
  await loadFromDisk();
  const key = brokenModelsUserKey(userId);
  let set = memory.get(key);
  if (!set) {
    set = new Set<string>();
    memory.set(key, set);
  }
  if (set.has(value)) {
    return false;
  }
  set.add(value);
  await persist();
  return true;
}

/**
 * Test-only seam: redirect the store to an ephemeral path and reset in-memory
 * state so each test starts clean. Not used in production.
 */
export function __setBrokenModelsStorePathForTests(storePath: string | null): void {
  storePathOverride = storePath;
  memory.clear();
  loaded = false;
  loadPromise = null;
}
