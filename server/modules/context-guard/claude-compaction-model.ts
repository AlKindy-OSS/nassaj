/* eslint-disable boundaries/dependencies -- ADR-223: read-only usage leaves (transcript reader, token parsers, opencode home), not the providers barrel (routes/SDK graph). */
/**
 * Model a Claude `/compact` turn runs on (T-2087, ADR-223 §3).
 *
 * A conversation too large for its newly pinned model is compacted on the
 * model that last served it — the one that can still hold it. That model is
 * read ONLY from the session's own transcript on the server; nothing the
 * client sends is consulted. It is used only when it is a model this session
 * may run: in the accepted-model set the send path validates against, or a
 * recognised Claude id the transcript itself records (the T-1665 rule for a
 * resumed session). A session pinned to a vendor engine (ADR-088) is never
 * given an Anthropic id here. Otherwise null, and the normal resume model applies.
 */

import { sessionsDb } from '@/modules/database/index.js';
import {
  claudeTranscriptWindowTokens,
  latestClaudeTokenUsage,
} from '@/modules/providers/list/claude/claude-token-usage.js';
import { readPinnedTail } from '@/modules/providers/shared/pinned-tail.js';
import { withRecordedTranscript } from '@/modules/providers/shared/session-transcript-reader.js';

import { claudeServedModel, normalizeClaudeModel, type ClaudeCatalogOption } from './adapters/claude.adapter.js';
import { evaluateFit } from './context-fit.js';
import { isCompactionCommand } from './context-guard.service.js';

const TAIL_BYTES = 4 * 1024 * 1024;
const SENTINEL_MODEL = '<synthetic>';

/** Last real model of a main-chain assistant row, walking back past compactions. */
export function lastServedClaudeModel(jsonl: string): string | null {
  const lines = jsonl.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: any;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
    const model = typeof entry.message?.model === 'string' ? entry.message.model.trim() : '';
    if (model && model !== SENTINEL_MODEL) return model;
  }
  return null;
}

export type CompactionModelInput = {
  command: unknown;
  sessionId: string | null | undefined;
  /** The accepted-model set of the send path (catalog values plus the static list). */
  accepted: ReadonlySet<string>;
  /** Transcript tail reader; defaults to the session's recorded transcript. */
  readTail?: (sessionId: string) => Promise<string | null>;
  /** Server-side engine pin of the session; defaults to the sessions table. */
  readEngine?: (sessionId: string) => string | null;
  /** The model the guard last admitted for this session (it may carry `[1m]`). */
  lastAdmitted?: string | null;
  /** Catalog used to name an admitted alias's window. */
  catalogOptions?: readonly ClaudeCatalogOption[];
};

const OFFICIAL_ENGINES = new Set([null, '', 'anthropic']);

const recordedEngine = (sessionId: string): string | null => sessionsDb.getSessionEnginePin(sessionId)?.engine ?? null;

const recordedTail = (sessionId: string): Promise<string | null> =>
  withRecordedTranscript(sessionId, 'claude', 'token-usage', (handle) => readPinnedTail(handle.fd, TAIL_BYTES));

/** True when a model of `id` can hold `used` (an unknown fill holds). */
const holds = (id: string | null, used: number | null): boolean => id !== null
  && claudeTranscriptWindowTokens(id) !== null
  && (used === null || evaluateFit({ usedTokens: used, windowTokens: claudeTranscriptWindowTokens(id) }).verdict === 'fits');

/** The last admitted model, when this session may run it and it holds the fill. */
async function admittedCandidate(input: CompactionModelInput, used: number | null): Promise<string | null> {
  const last = input.lastAdmitted?.trim();
  if (!last) return null;
  const id = await normalizeClaudeModel(last, async () => input.catalogOptions ?? []);
  const runnable = input.accepted.has(last) || last.toLowerCase().startsWith('claude-');
  return runnable && holds(id, used) ? last : null;
}

/** Reads the tail of an official-engine session, or null. */
async function officialTail(input: CompactionModelInput & { sessionId: string }): Promise<string | null> {
  try {
    if (!OFFICIAL_ENGINES.has((input.readEngine ?? recordedEngine)(input.sessionId))) return null;
    return await (input.readTail ?? recordedTail)(input.sessionId);
  } catch {
    return null;
  }
}

/**
 * The model a `/compact` turn must run on, or null for any other turn: the
 * last admitted model when it holds the conversation, else the model the
 * transcript says served it (with its `[1m]` tag restored when the fill proves
 * it), else null.
 */
export async function resolveClaudeCompactionModel(input: CompactionModelInput): Promise<string | null> {
  const sessionId = input.sessionId;
  if (!sessionId || !isCompactionCommand(input.command)) return null;
  const tail = await officialTail({ ...input, sessionId });
  if (tail === null) return null;
  const usage = latestClaudeTokenUsage(tail);
  const used = usage.modelName ? usage.inputTokens : null;
  const admitted = await admittedCandidate(input, used);
  if (admitted) return admitted;
  const observed = lastServedClaudeModel(tail);
  if (!observed) return null;
  const served = claudeServedModel(observed, used);
  const runnable = input.accepted.has(observed) || claudeTranscriptWindowTokens(observed) !== null;
  return runnable && holds(served, used) ? served : null;
}
