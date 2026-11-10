/**
 * OpenCode usage adapter of the context guard (T-2087, ADR-223). Covers every
 * model OpenCode carries (GLM, DeepSeek, local servers …).
 *
 * Fill: `tokens.input + tokens.cache.read` of the session's last assistant
 * message with usage, read-only from the opencode.db that holds the session.
 * A compaction summary after it makes the fill unknown. The session's
 * cumulative totals are never used — they grow past any window.
 * Window: `limit` of the model in the models.json cache of the SAME tree as
 * that database (each member has their own), or a local server's declared
 * context window. Absent → unknown.
 */

import fs from 'node:fs';

import Database from 'better-sqlite3';

import type { ContextFitAdapter, ModelWindow, Observation } from '../types.js';

export type LocalServerModels = {
  providerId: string;
  models: ReadonlyArray<{ id: string; contextWindow?: number; maxOutput?: number }>;
};

export type OpenCodeAdapterDeps = {
  /** The opencode.db that holds the session, or null. */
  findDatabase: (sessionId: string) => string | null;
  /** models.json of the tree that owns `dbPath`, or null when that tree has none. */
  modelsJsonPath: (dbPath: string) => string | null;
  /** Local model servers of the owner of `dbPath`. */
  localModels: (dbPath: string) => readonly LocalServerModels[];
};

/** OpenCode's own cap on the output it reserves for a reply. */
const OPENCODE_OUTPUT_CAP = 32_000;
/** Matches local-model-config.js: a server model with no declared output gets min(8192, window). */
const LOCAL_DEFAULT_OUTPUT = 8_192;
const MESSAGE_SCAN_LIMIT = 50;
const LOCAL_PREFIX = 'nassaj_local_';

type MessageData = {
  role?: unknown; summary?: unknown; providerID?: unknown; modelID?: unknown;
  tokens?: { input?: unknown; cache?: { read?: unknown } };
};

const tokens = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

function withDatabase<T>(dbPath: string, read: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Walks the latest assistant messages: first usage wins, a summary first means unknown. */
export function lastOpenCodeFill(rows: ReadonlyArray<{ data: string }>): Observation {
  for (const row of rows) {
    let data: MessageData;
    try { data = JSON.parse(row.data) as MessageData; } catch { continue; }
    if (data.role !== 'assistant') continue;
    if (data.summary === true) return { usedTokens: null, modelId: null };
    const used = tokens(data.tokens?.input) + tokens(data.tokens?.cache?.read);
    if (used === 0) continue;
    const model = typeof data.providerID === 'string' && typeof data.modelID === 'string'
      ? `${data.providerID}/${data.modelID}` : null;
    return { usedTokens: used, modelId: model };
  }
  return { usedTokens: null, modelId: null };
}

type ModelsJson = Record<string, { models?: Record<string, { limit?: Record<string, unknown> }> }>;
const modelsJsonCache = new Map<string, { mtimeMs: number; value: ModelsJson | null }>();

function readModelsJson(filePath: string): ModelsJson | null {
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return null; }
  const hit = modelsJsonCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  let value: ModelsJson | null = null;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ModelsJson; } catch { value = null; }
  modelsJsonCache.set(filePath, { mtimeMs, value });
  return value;
}

/** Window of a models.json `limit`: an explicit input cap wins, else context minus reply room. */
export function windowFromLimit(limit: Record<string, unknown> | undefined): ModelWindow {
  const context = positive(limit?.context);
  if (context === null) return { windowTokens: null, reserveTokens: null };
  const input = positive(limit?.input);
  if (input !== null && input < context) return { windowTokens: context, reserveTokens: context - input };
  const output = positive(limit?.output);
  return { windowTokens: context, reserveTokens: output === null ? null : Math.min(output, OPENCODE_OUTPUT_CAP) };
}

function localWindow(servers: readonly LocalServerModels[], providerId: string, modelId: string): ModelWindow {
  const model = servers.find((server) => server.providerId === providerId)?.models.find((entry) => entry.id === modelId);
  const context = positive(model?.contextWindow);
  if (context === null) return { windowTokens: null, reserveTokens: null };
  return { windowTokens: context, reserveTokens: positive(model?.maxOutput) ?? Math.min(LOCAL_DEFAULT_OUTPUT, context) };
}

/** Builds the OpenCode adapter over injected database and catalog locators. */
export function createOpenCodeContextAdapter(deps: OpenCodeAdapterDeps): ContextFitAdapter {
  return {
    async normalizeModel(model) {
      const id = model.trim();
      return id.includes('/') ? id : null;
    },
    async observationKey(session) {
      const dbPath = deps.findDatabase(session.sessionId);
      if (!dbPath) return null;
      const row = withDatabase(dbPath, (db) => db.prepare(
        'SELECT MAX(time_created) AS last FROM message WHERE session_id = ?',
      ).get(session.sessionId) as { last: number | null } | undefined);
      return row?.last == null ? null : `${dbPath}:${row.last}`;
    },
    async observe(session) {
      const dbPath = deps.findDatabase(session.sessionId);
      if (!dbPath) return { usedTokens: null, modelId: null };
      const rows = withDatabase(dbPath, (db) => db.prepare(
        'SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?',
      ).all(session.sessionId, MESSAGE_SCAN_LIMIT) as Array<{ data: string }>);
      return lastOpenCodeFill(rows);
    },
    async windowFor(modelId, session) {
      const dbPath = deps.findDatabase(session.sessionId);
      const slash = modelId.indexOf('/');
      if (!dbPath || slash <= 0) return { windowTokens: null, reserveTokens: null };
      const providerId = modelId.slice(0, slash);
      const id = modelId.slice(slash + 1);
      if (providerId.startsWith(LOCAL_PREFIX)) return localWindow(deps.localModels(dbPath), providerId, id);
      const modelsPath = deps.modelsJsonPath(dbPath);
      const catalog = modelsPath ? readModelsJson(modelsPath) : null;
      const provider = catalog && Object.hasOwn(catalog, providerId) ? catalog[providerId] : undefined;
      const entry = provider?.models && Object.hasOwn(provider.models, id) ? provider.models[id] : undefined;
      return windowFromLimit(entry?.limit);
    },
  };
}
