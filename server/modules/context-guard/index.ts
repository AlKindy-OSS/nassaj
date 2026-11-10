/* eslint-disable boundaries/dependencies -- ADR-223: read-only usage leaves (transcript reader, token parsers, opencode home), not the providers barrel (routes/SDK graph). */
/**
 * Production wiring of the model-switch context guard (T-2087, ADR-223): one
 * process-wide guard over the real session rows, pin store, transcripts,
 * opencode databases and catalogs. Every reader is read-only.
 */

import os from 'node:os';
import path from 'node:path';

import { localModelServersDb, sessionsDb } from '@/modules/database/index.js';
import { CLAUDE_FALLBACK_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  findOpenCodeDatabaseForSession,
  operatorOpenCodeDatabasePath,
  resolveOpenCodeDataHomeOwner,
} from '@/modules/providers/list/opencode/opencode-home.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { readPinnedTail } from '@/modules/providers/shared/pinned-tail.js';
import { isTranscriptHandle, openRecordedTranscript } from '@/modules/providers/shared/session-transcript-reader.js';
import type { LLMProvider } from '@/shared/types.js';

import { createClaudeContextAdapter, type ClaudeCatalogOption } from './adapters/claude.adapter.js';
import { createCodexContextAdapter } from './adapters/codex.adapter.js';
import { createOpenCodeContextAdapter, type LocalServerModels } from './adapters/opencode.adapter.js';
import { createContextGuard } from './context-guard.service.js';
import type { GuardSession } from './types.js';

export { isCompactionCommand } from './context-guard.service.js';
export { resolveClaudeCompactionModel } from './claude-compaction-model.js';
export type { ContextGuardPort, ContextFitReport } from './types.js';

/** Bounded tail read for the guard: the last request's usage sits at the end. */
const GUARD_TAIL_BYTES = 4 * 1024 * 1024;
const MEMBER_DB_SUFFIX = path.join('.local', 'share', 'opencode', 'opencode.db');

/** The persisted session facts, or null for an unknown id. */
export function readGuardSession(sessionId: string): GuardSession | null {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    provider: row.provider,
    jsonlPath: row.jsonl_path ?? null,
    engineProvider: row.engine_provider ?? null,
  };
}

const transcriptRow = (session: GuardSession) => ({
  session_id: session.sessionId, provider: session.provider, jsonl_path: session.jsonlPath,
});

async function transcriptKey(session: GuardSession): Promise<string | null> {
  const opened = await openRecordedTranscript(transcriptRow(session), 'token-usage');
  if (!isTranscriptHandle(opened)) return null;
  await opened.fd.close().catch(() => undefined);
  return `${opened.realpath}:${opened.stat.mtimeNs}:${opened.stat.size}`;
}

async function transcriptTail(session: GuardSession): Promise<string | null> {
  const opened = await openRecordedTranscript(transcriptRow(session), 'token-usage');
  if (!isTranscriptHandle(opened)) return null;
  try {
    return await readPinnedTail(opened.fd, GUARD_TAIL_BYTES);
  } catch {
    return null;
  } finally {
    await opened.fd.close().catch(() => undefined);
  }
}

/** Longest the guard waits for the live catalog before using the static list. */
const CATALOG_WAIT_MS = 1_500;

/** Live catalog first (it names current versions), static list as the floor. */
async function claudeCatalogOptions(): Promise<readonly ClaudeCatalogOption[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CATALOG_WAIT_MS); });
    const result = await Promise.race([providerModelsService.getProviderModels('claude'), timeout]);
    const live = Array.isArray(result?.models?.OPTIONS) ? result.models.OPTIONS : [];
    return [...live, ...CLAUDE_FALLBACK_MODELS.OPTIONS];
  } catch {
    return CLAUDE_FALLBACK_MODELS.OPTIONS;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * models.json of the tree that owns `dbPath`: a member tree keeps it at
 * `<tree>/.cache/opencode/models.json`, the operator at XDG_CACHE_HOME or
 * `~/.cache`. Never another tree's file.
 */
export function openCodeModelsJsonPath(dbPath: string): string | null {
  if (dbPath.endsWith(path.sep + MEMBER_DB_SUFFIX)) {
    const tree = dbPath.slice(0, -MEMBER_DB_SUFFIX.length - 1);
    return path.join(tree, '.cache', 'opencode', 'models.json');
  }
  if (dbPath === operatorOpenCodeDatabasePath()) {
    const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
    return path.join(cacheHome, 'opencode', 'models.json');
  }
  return null;
}

function openCodeLocalModels(dbPath: string): readonly LocalServerModels[] {
  try {
    const owner = resolveOpenCodeDataHomeOwner(path.dirname(dbPath));
    return owner === null ? [] : localModelServersDb.list(owner);
  } catch {
    return [];
  }
}

async function readPin(provider: string, sessionId: string): Promise<string | null> {
  const change = await providerModelsService.getChangedActiveModel(provider as LLMProvider, sessionId);
  return change.supported && change.changed && change.model?.trim() ? change.model.trim() : null;
}

export const contextGuard = createContextGuard({
  adapters: {
    claude: createClaudeContextAdapter({
      transcriptKey, readTranscriptTail: transcriptTail, catalogOptions: claudeCatalogOptions,
    }),
    codex: createCodexContextAdapter({ rolloutKey: transcriptKey, readRolloutTail: transcriptTail }),
    opencode: createOpenCodeContextAdapter({
      findDatabase: findOpenCodeDatabaseForSession,
      modelsJsonPath: openCodeModelsJsonPath,
      localModels: openCodeLocalModels,
    }),
  },
  readPin,
  readSession: readGuardSession,
});
