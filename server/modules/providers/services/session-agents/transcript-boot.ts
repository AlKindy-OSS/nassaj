/**
 * ADR-218: lazy reconstruction of a Claude session's agents from its recorded
 * transcript, for a session the registry has not seen live (server restart, a
 * viewer opening an older session). Reads only the last {@link BOOT_TAIL_BYTES}
 * through the pinned ADR-201 reader, folds them with the live adapter into a
 * scratch registry, and names agents from `subagents/agent-<id>.meta.json`
 * (label, type, model only). Started-but-unended agents are `unknown` unless a
 * run of the session is live.
 */

import type { FileHandle } from 'node:fs/promises';

import { readAgentMeta } from '@/modules/providers/list/claude/agent-transcript.reader.js';
import {
  openSessionArtifactDir,
  SessionArtifactDir,
  withRecordedTranscript,
  type SessionTranscriptHandle,
} from '@/modules/providers/shared/session-transcript-reader.js';

import { observeClaudeAgentEvent } from './claude-agent-events.js';
import { SessionAgentRegistry, type AgentRow } from './registry.js';

export const BOOT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_META_READS = 64;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Parsed JSON rows of the last `maxBytes` of a file. When the window starts
 * mid-file its first (cut) line is dropped; unparsable lines are skipped.
 */
export async function readTailRecords(fd: FileHandle, maxBytes = BOOT_TAIL_BYTES): Promise<Array<Record<string, unknown>>> {
  const { size } = await fd.stat();
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length <= 0) return [];
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buffer, 0, length, start);
  let body = buffer.subarray(0, bytesRead).toString('utf8');
  if (start > 0) {
    const firstBreak = body.indexOf('\n');
    body = firstBreak === -1 ? '' : body.slice(firstBreak + 1);
  }
  return body.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

export type BootOptions = {
  /** True when a run of the session is alive now. */
  isRunLive: (sessionId: string) => boolean;
  now?: () => number;
  tailBytes?: number;
};

/** Agent rows rebuilt from an opened transcript (exported for tests on fixture files). */
export async function reconstructFromTranscript(
  sessionId: string, transcript: SessionTranscriptHandle, options: BootOptions,
): Promise<AgentRow[]> {
  const now = options.now ?? Date.now;
  const scratch = new SessionAgentRegistry({ now, endedTtlMs: Number.POSITIVE_INFINITY, maxSessions: 1 });
  for (const record of await readTailRecords(transcript.fd, options.tailBytes ?? BOOT_TAIL_BYTES)) {
    observeClaudeAgentEvent(scratch, sessionId, record, { accuracy: 'reconstructed', now });
  }
  const rows = scratch.rows(sessionId);
  await nameFromMeta(transcript, rows);
  const live = options.isRunLive(sessionId);
  for (const row of rows) {
    delete row.runToken;
    if (row.state === 'running' && !live) row.state = 'unknown';
  }
  return rows;
}

/** Reconstructs a session's agents from its recorded transcript; [] when it cannot be opened. */
export async function reconstructClaudeSessionAgents(sessionId: string, options: BootOptions): Promise<AgentRow[]> {
  const rows = await withRecordedTranscript(sessionId, 'claude', 'agents',
    (transcript) => reconstructFromTranscript(sessionId, transcript, options));
  return rows ?? [];
}

/** Fills missing label/type/model from each agent's meta file (bounded, pinned reads). */
async function nameFromMeta(transcript: SessionTranscriptHandle, rows: AgentRow[]): Promise<void> {
  const wanting = rows.filter((row) => row.agentId && AGENT_ID.test(row.agentId)
    && (!row.label || !row.agentType || !row.model)).slice(0, MAX_META_READS);
  if (wanting.length === 0) return;
  const dir = await openSessionArtifactDir(transcript, 'subagents');
  if (!(dir instanceof SessionArtifactDir)) return;
  try {
    for (const row of wanting) {
      const meta = await readAgentMeta(dir, row.agentId as string);
      if (!row.label && meta.description) row.label = meta.description;
      if (!row.agentType && meta.agentType) row.agentType = meta.agentType;
      if (!row.model && meta.model) row.model = meta.model;
    }
  } finally {
    await dir.close();
  }
}
