import path from 'node:path';
import type { Readable } from 'node:stream';

import type { HistoryReadLease } from '../../services/history-budget.service.js';
import {
  historyTranscript, openSessionArtifactDir, pinnedReadStream, releaseHistoryTranscript,
  SessionArtifactDir, type HistoryTranscript, type SessionTranscriptHandle,
} from '../../shared/session-transcript-reader.js';

import type { WorkflowJournalSource } from './workflow-reconcile.service.js';

/**
 * File access of one Claude history read (ADR-201 A1). Two modes, one shape:
 *   - lease: the bounded reader's pinned, scoped, budgeted opens;
 *   - pinned: a transcript from `openSessionTranscript`, with its `subagents`
 *     and `subagents/workflows` directories pinned through
 *     `openSessionArtifactDir` and children opened through their descriptors.
 * Nothing here opens a stored path by name.
 */
export type ClaudeHistorySource = {
  /** Realpath of the transcript (its basename is `<sessionId>.jsonl`). */
  mainFile: string;
  main(): Readable;
  agentFileNames(): Promise<string[]>;
  agent(fileName: string): Promise<Readable | null>;
  workflows(): WorkflowJournalSource | undefined;
  close(): Promise<void>;
};

const isAgentFile = (name: string): boolean => name.endsWith('.jsonl') && name.startsWith('agent-');

function subagentsDirOf(mainFile: string): string {
  return path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'), 'subagents');
}

/** Lease-backed source; the lease owns every descriptor. */
export function leaseHistorySource(lease: HistoryReadLease): ClaudeHistorySource | null {
  const mainFile = lease.mainFile;
  if (!mainFile) return null;
  const subagentsDir = subagentsDirOf(mainFile);
  return {
    mainFile,
    main: () => lease.stream(mainFile),
    agentFileNames: async () => (await lease.directory(subagentsDir)).filter(isAgentFile),
    agent: async (fileName) => lease.stream(path.join(subagentsDir, fileName)),
    workflows: () => undefined,
    close: async () => undefined,
  };
}

/**
 * Workflow journals read through a pinned `subagents/workflows` directory,
 * resolved lazily by `workflowsDir` (null = no admissible directory, no reads).
 */
export function artifactDirJournals(workflowsDir: () => Promise<SessionArtifactDir | null>): WorkflowJournalSource {
  const journal = async (entry: string) => {
    const child = await (await workflowsDir())?.openFile(`${entry}/journal.jsonl`);
    return child && 'handle' in child ? child : null;
  };
  return {
    list: async () => (await (await workflowsDir())?.list()) ?? [],
    journal: async (entry) => {
      const child = await journal(entry);
      return child ? { mtimeMs: Number(child.stat.mtimeMs), open: () => pinnedReadStream(child.handle) } : undefined;
    },
  };
}

/** Workflow journals of a pinned transcript; opened dirs are tracked in `opened` for close. */
function pinnedWorkflowJournals(transcript: SessionTranscriptHandle, opened: Set<SessionArtifactDir>): WorkflowJournalSource {
  let dir: Promise<SessionArtifactDir | null> | undefined;
  return artifactDirJournals(() => (dir ??= openSessionArtifactDir(transcript, 'workflows').then((result) => {
    if (!(result instanceof SessionArtifactDir)) return null;
    opened.add(result);
    return result;
  })));
}

function pinnedSource(acquired: HistoryTranscript): ClaudeHistorySource {
  const { transcript } = acquired;
  const opened = new Set<SessionArtifactDir>();
  let subagents: Promise<SessionArtifactDir | null> | undefined;
  const subagentsDir = () => (subagents ??= openSessionArtifactDir(transcript, 'subagents').then((result) => {
    if (!(result instanceof SessionArtifactDir)) return null;
    opened.add(result);
    return result;
  }));
  return {
    mainFile: transcript.realpath,
    main: () => pinnedReadStream(transcript.fd),
    agentFileNames: async () => ((await (await subagentsDir())?.list()) ?? []).filter(isAgentFile),
    agent: async (fileName) => {
      const child = await (await subagentsDir())?.openFile(fileName);
      return child && 'handle' in child ? pinnedReadStream(child.handle) : null;
    },
    workflows: () => pinnedWorkflowJournals(transcript, opened),
    close: async () => {
      await Promise.allSettled([...opened].map((dir) => dir.close()));
      await releaseHistoryTranscript(acquired);
    },
  };
}

/**
 * Source of one Claude history read: the lease when bounded, else the supplied
 * pinned transcript, else (direct callers) a pinned open of the recorded row.
 * Null when there is no admissible transcript.
 */
export async function claudeHistorySource(
  sessionId: string, lease: HistoryReadLease | undefined, supplied: SessionTranscriptHandle | null | undefined,
): Promise<ClaudeHistorySource | null> {
  if (lease) return leaseHistorySource(lease);
  const acquired = await historyTranscript(sessionId, 'claude', supplied);
  return acquired ? pinnedSource(acquired) : null;
}
