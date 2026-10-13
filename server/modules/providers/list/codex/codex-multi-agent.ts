/**
 * B-1616 (ADR-206 containment slice): one source for Codex native multi-agent config.
 *
 * Facts this module relies on (codex-cli 0.160.0, verified offline with
 * `codex debug prompt-input`, no paid run):
 * - The model catalog picks the engine (`multi_agent_version`: v1, v2 or absent).
 *   On a v2 model `features.multi_agent=false` does NOT remove delegation, so that
 *   flag only governs v1 models.
 * - The REAL control on v2 is `features.multi_agent_v2.max_concurrent_threads_per_session`
 *   (slots including the root). It overrides `agents.max_concurrent_threads_per_session`
 *   in both directions. The `agents.*` key is children + 1 slots, must be >= 1, and
 *   is what v1 uses. Neither accepts 0; a v2 value of 1 means "the root only".
 * - With no override Codex renders 4 slots on a v2 model = 3 children
 *   (Codex's own default). `agents.max_depth` applies to v1 only.
 *
 * Owner decision 2026-10-13: the number of Codex sub-agents is whatever Codex
 * allows; Nassaj applies NO count cap. By default no thread-cap key is sent, so
 * Codex's own default (or the user's config.toml) decides. `NASSAJ_CODEX_AGENT_CAP`
 * is an optional operator override only. The supervised capture-only roles keep
 * their single-agent pin, which is their contract, not a product cap.
 */
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { openFileNoFollow } from '../../shared/pinned-fd.js';

export const CODEX_AGENTS_THREADS_KEY = 'agents.max_concurrent_threads_per_session';
export const CODEX_V2_THREADS_KEY = 'features.multi_agent_v2.max_concurrent_threads_per_session';

/**
 * Optional operator override of the child count from `NASSAJ_CODEX_AGENT_CAP`: any
 * positive decimal integer. Unset, empty or invalid (0, negative, fractional, hex,
 * beyond a safe integer) means NO override (null): Codex decides. Never a refusal.
 */
export function resolveCodexAgentCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.NASSAJ_CODEX_AGENT_CAP?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value + 1) && value >= 1 ? value : null;
}

export type CodexMultiAgentConfig = Readonly<{
  'features.multi_agent': boolean;
  'agents.max_concurrent_threads_per_session'?: number;
  'features.multi_agent_v2.max_concurrent_threads_per_session'?: number;
}>;

/**
 * Launch overrides. `features.multi_agent` stays false (ADR-134 v1 keeps v1 models
 * single-agent). With no override (`cap` null or not a positive safe integer) no
 * thread key is set. With an operator override both keys are pinned, because the
 * v2 key wins over `agents.*` in both directions: children = cap, slots = cap + 1.
 */
export function codexMultiAgentConfig(cap: number | null): CodexMultiAgentConfig {
  const override = typeof cap === 'number' && Number.isSafeInteger(cap + 1) && cap >= 1 ? cap : null;
  return Object.freeze(override === null
    ? { 'features.multi_agent': false }
    : { 'features.multi_agent': false, [CODEX_AGENTS_THREADS_KEY]: override, [CODEX_V2_THREADS_KEY]: override + 1 },
  ) as CodexMultiAgentConfig;
}

/**
 * Single-agent overrides for runs that are single-agent by contract (the
 * supervised capture-only roles): v2 gets the root slot only; the `agents.*`
 * key takes its minimum (v1 is already off through `features.multi_agent`).
 */
export const CODEX_SINGLE_AGENT_CONFIG: CodexMultiAgentConfig = Object.freeze({
  'features.multi_agent': false,
  [CODEX_AGENTS_THREADS_KEY]: 1,
  [CODEX_V2_THREADS_KEY]: 1,
}) as CodexMultiAgentConfig;

/** `--config key=value` argv for a config object (TOML scalars only). */
export function codexConfigArgv(config: CodexMultiAgentConfig): string[] {
  return Object.entries(config).flatMap(([key, value]) => ['--config', `${key}=${String(value)}`]);
}

export type CodexMultiAgentEngine = 'v1' | 'v2' | 'none' | 'unknown';

const MODELS_CACHE_FILE = 'models_cache.json';
const MODELS_CACHE_MAX_BYTES = 8 * 1024 * 1024;
type CatalogCache = { key: string; engines: ReadonlyMap<string, CodexMultiAgentEngine> };
const catalogCache = new Map<string, CatalogCache>();
const CATALOG_CACHE_MAX = 64;

function enginesFrom(raw: string): ReadonlyMap<string, CodexMultiAgentEngine> {
  const engines = new Map<string, CodexMultiAgentEngine>();
  const parsed: unknown = JSON.parse(raw);
  const models = parsed && typeof parsed === 'object' ? (parsed as { models?: unknown }).models : null;
  if (!Array.isArray(models)) return engines;
  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    const { slug, multi_agent_version: version } = model as { slug?: unknown; multi_agent_version?: unknown };
    if (typeof slug !== 'string' || !slug || engines.has(slug)) continue;
    engines.set(slug, version === 'v1' || version === 'v2' ? version : version == null ? 'none' : 'unknown');
  }
  return engines;
}

/**
 * Reads at most `MODELS_CACHE_MAX_BYTES` from an open descriptor. A file that
 * grows past the cap after its fstat (or a device-like endless source) is
 * refused, never read to the end.
 */
async function readBounded(handle: FileHandle): Promise<string | null> {
  const buffer = Buffer.alloc(MODELS_CACHE_MAX_BYTES + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled > MODELS_CACHE_MAX_BYTES ? null : buffer.toString('utf8', 0, filled);
}

/**
 * The delegation engine Codex picks for `model`, from the run's own
 * `$CODEX_HOME/models_cache.json` (the catalog the CLI itself uses). The file is
 * opened once with the repo's pinned no-follow open (regular, single-link, name
 * bound to the descriptor); its size comes from that descriptor's fstat and the
 * read is capped. Never throws: no model (config default), no catalog, a
 * symlinked, hard-linked, non-regular or oversized catalog, or an unlisted model
 * is 'unknown'. `beforeRead` is a test seam between the fstat and the read.
 */
export async function resolveCodexMultiAgentEngine(
  codexHome: string | null | undefined,
  model: string | null | undefined,
  options: { beforeRead?: () => Promise<void> | void } = {},
): Promise<CodexMultiAgentEngine> {
  if (!codexHome || typeof model !== 'string' || !model) return 'unknown';
  const file = path.join(codexHome, MODELS_CACHE_FILE);
  let opened: Awaited<ReturnType<typeof openFileNoFollow>> | null = null;
  try {
    opened = await openFileNoFollow(file);
    const { stat } = opened;
    if (stat.size > BigInt(MODELS_CACHE_MAX_BYTES)) return 'unknown';
    const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    let cached = catalogCache.get(file);
    if (!cached || cached.key !== key) {
      await options.beforeRead?.();
      const raw = await readBounded(opened.handle);
      if (raw === null) return 'unknown';
      cached = { key, engines: enginesFrom(raw) };
      if (catalogCache.size >= CATALOG_CACHE_MAX) catalogCache.clear();
      catalogCache.set(file, cached);
    }
    return cached.engines.get(model) ?? 'unknown';
  } catch {
    return 'unknown';
  } finally {
    await opened?.handle.close().catch(() => undefined);
  }
}

/**
 * Whether a run can delegate natively and so needs the ADR-199 rollout tail:
 * always on v2 (the flag cannot stop it) and on an unknown engine (fail toward
 * visibility); on v1 only when `features.multi_agent` is on; never on a model
 * the catalog lists without an engine.
 */
export function codexRunMayDelegate(engine: CodexMultiAgentEngine, config: CodexMultiAgentConfig): boolean {
  if (engine === 'none') return false;
  if (engine === 'v1') return config['features.multi_agent'] === true;
  return true;
}
