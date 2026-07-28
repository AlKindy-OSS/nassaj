/**
 * Per-agent rows for a RUNNING workflow — the data the composer strip needs.
 *
 * WHY THE STRIP IS BLIND WITHOUT THIS
 * -----------------------------------
 * The composer's agent strip (`AgentStatusCard`) is derived entirely in the
 * client from `chatMessages`: `useRunProgress` walks the session transcript and
 * emits one row per `Task`/`Agent` container. That works — verified live: a
 * session delegating with the `Agent` tool shows four rows with their current
 * tool and call counts.
 *
 * A `Workflow` run has NO container row in the parent transcript. Its agents live
 * entirely on disk under the session's `subagents/workflows/wf_…` directory:
 *   journal.jsonl        — `{type:'started'|'result', key, agentId}` per agent
 *   agent-<id>.jsonl     — that agent's own transcript
 *   agent-<id>.meta.json — `{agentType:'workflow-subagent', spawnDepth}`
 * so the client has nothing to derive from and the strip silently shows the plain
 * status bar. This service is the missing server-side source.
 *
 * WHAT A ROW HONESTLY CONTAINS
 * ----------------------------
 * The journal carries NO label: a record is exactly `{type, key, agentId}`. So a
 * row is identified by its 1-based `ordinal` (delegation order) plus a `label`
 * that is only ever set when the agent's prompt actually opens with a short,
 * single-line task description — the common `agent('grep CI logs for retries')`
 * shape. When the prompt opens with a wall of context (equally common), `label`
 * is null and the UI shows the ordinal alone. Inventing a label by truncating a
 * 400-character prompt would produce a confident-looking lie, so it is not done.
 *
 * `callCount` / `currentTool` come from the agent's own transcript and are
 * therefore real for a live run — unlike the `Agent`-tool rows, whose child-tool
 * enrichment arrives ONLY on the live SDK stream (`parent_tool_use_id` is never
 * persisted: measured 0 such rows on disk across every transcript) and is lost on
 * refresh. A workflow row survives refresh precisely because its source is disk.
 *
 * COST CONTROL
 * ------------
 * Called only for workflows the status scan already classified as active, and:
 *   - agent transcripts are read INCREMENTALLY (byte cursor per file), so the 8s
 *     poll re-reads only what was appended — not the 200–800KB file each time;
 *   - `MAX_AGENTS_PER_WORKFLOW` bounds the fan-out; when it truncates, the caller
 *     is told (`truncated`) rather than silently shown a short list;
 *   - the journal itself is parsed on a (path, mtime, size) memo.
 * Read-only and fail-safe throughout: any unreadable file degrades that ONE row
 * (or the workflow's row list to empty), never the enclosing scan.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** One delegated workflow agent, as surfaced to the composer strip. */
export type WorkflowAgentRow = {
  /** Journal `agentId` — stable across polls, used as the React key. */
  agentId: string;
  /** 1-based position in the journal's `started` order (delegation order). */
  ordinal: number;
  /** running = started with no `result` record yet; done = result recorded. */
  status: 'running' | 'done';
  /** Tool calls this agent has issued so far (from its own transcript). */
  callCount: number;
  /** Name of the most recent tool call while running; null when done/unknown. */
  currentTool: string | null;
  /** Short task label when the prompt opens with one; null when not derivable. */
  label: string | null;
  /** Last write to this agent's transcript (ISO), or null when unreadable. */
  updatedAt: string | null;
};

/**
 * Fan-out ceiling per workflow. Beyond this the list is truncated and the flag is
 * surfaced — a silently short list would read as "that's all the agents".
 */
const MAX_AGENTS_PER_WORKFLOW = 64;

/**
 * Bytes consumed per agent transcript per call. The cursor advances by what was
 * read, so a large backlog drains across polls instead of stalling one request.
 */
const MAX_BYTES_PER_AGENT_SCAN = 2 * 1024 * 1024;

/** A label is only accepted when the prompt's first line is genuinely a title. */
const MAX_LABEL_LENGTH = 120;

/** `agent-<id>.jsonl` — the id charset is fixed by the harness (hex-ish token). */
const AGENT_FILE_RE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

type AgentScanState = {
  offset: number;
  size: number;
  callCount: number;
  currentTool: string | null;
  label: string | null;
  /** True once the first line was inspected, so the label is derived once only. */
  labelResolved: boolean;
};

const agentScanStates = new Map<string, AgentScanState>();

type JournalAgents = {
  /** agentIds in `started` order, de-duplicated. */
  order: string[];
  /** agentIds that have a `result` record. */
  resulted: Set<string>;
};

const journalAgentsCache = new Map<string, JournalAgents>();

/** Test seam: clears every cursor and memo. */
export function __resetWorkflowAgentScan(): void {
  agentScanStates.clear();
  journalAgentsCache.clear();
}

/**
 * Parses a workflow journal into "who started, in what order, and who finished".
 *
 * Deliberately keyed on `agentId`, NOT on the journal `key`: the key is a content
 * hash used for resume-caching, and two agents CAN share one when their prompts
 * are identical. `agentId` is the per-spawn identity, which is what a UI row is.
 */
export function parseJournalAgents(text: string): JournalAgents {
  const order: string[] = [];
  const seen = new Set<string>();
  const resulted = new Set<string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: { type?: unknown; agentId?: unknown };
    try {
      record = JSON.parse(trimmed) as { type?: unknown; agentId?: unknown };
    } catch {
      continue; // A half-written tail line: skip it, never abort the parse.
    }
    const agentId = typeof record.agentId === 'string' ? record.agentId : '';
    if (!agentId) continue;
    if (record.type === 'started') {
      if (!seen.has(agentId)) {
        seen.add(agentId);
        order.push(agentId);
      }
    } else if (record.type === 'result') {
      resulted.add(agentId);
      // A `result` for an agent whose `started` line was lost/truncated still
      // deserves a row — otherwise a finished agent would vanish from the list.
      if (!seen.has(agentId)) {
        seen.add(agentId);
        order.push(agentId);
      }
    }
  }

  return { order, resulted };
}

async function readJournalAgentsCached(journalPath: string): Promise<JournalAgents> {
  let cacheKey = journalPath;
  try {
    const stat = await fsp.stat(journalPath);
    cacheKey = `${journalPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return { order: [], resulted: new Set<string>() };
  }

  const hit = journalAgentsCache.get(cacheKey);
  if (hit) return hit;

  let text: string;
  try {
    text = await fsp.readFile(journalPath, 'utf8');
  } catch {
    return { order: [], resulted: new Set<string>() };
  }

  const parsed = parseJournalAgents(text);
  // Single-entry-per-path memo: an older key for the same path is dead weight.
  for (const key of journalAgentsCache.keys()) {
    if (key.startsWith(`${journalPath}:`)) journalAgentsCache.delete(key);
  }
  journalAgentsCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Pulls the label candidate out of an agent transcript's FIRST line (the prompt).
 * Returns null unless the first non-empty line of the prompt reads like a title:
 * short, and not the repo-context preamble workflows commonly prepend. Exported
 * for unit tests against real prompt shapes.
 */
export function deriveAgentLabel(firstLine: string): string | null {
  let content: unknown;
  try {
    const row = JSON.parse(firstLine) as { message?: { content?: unknown } };
    content = row?.message?.content;
  } catch {
    return null;
  }

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        text = (block as { text: string }).text;
        break;
      }
    }
  }
  if (!text) return null;

  const firstMeaningful = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstMeaningful) return null;
  if (firstMeaningful.length > MAX_LABEL_LENGTH) return null;

  return firstMeaningful;
}

/**
 * Scans the bytes appended to one agent transcript since the last call and folds
 * them into that agent's running totals. Never throws.
 */
async function scanAgentTranscript(agentPath: string): Promise<AgentScanState> {
  let state = agentScanStates.get(agentPath);
  if (!state) {
    state = {
      offset: 0,
      size: 0,
      callCount: 0,
      currentTool: null,
      label: null,
      labelResolved: false,
    };
    agentScanStates.set(agentPath, state);
  }

  let size: number;
  try {
    size = (await fsp.stat(agentPath)).size;
  } catch {
    return state;
  }

  // Rotation/truncation: the cursor and the derived totals no longer describe
  // this file, so recount from zero rather than reporting a stale sum.
  if (size < state.offset) {
    state.offset = 0;
    state.callCount = 0;
    state.currentTool = null;
    state.labelResolved = false;
    state.label = null;
  }
  state.size = size;
  if (size <= state.offset) {
    return state;
  }

  const start = state.offset;
  const end = Math.min(size, start + MAX_BYTES_PER_AGENT_SCAN);

  let chunk: string;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(agentPath, 'r');
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, end - start, start);
    chunk = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return state;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }

  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) {
    if (end < size) state.offset = end; // Pathological long line: do not stall.
    return state;
  }

  const complete = chunk.slice(0, lastNewline);
  for (const line of complete.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!state.labelResolved) {
      state.labelResolved = true;
      state.label = deriveAgentLabel(trimmed);
    }

    let row: { message?: { content?: unknown } };
    try {
      row = JSON.parse(trimmed) as { message?: { content?: unknown } };
    } catch {
      continue;
    }
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block
        && typeof block === 'object'
        && (block as { type?: unknown }).type === 'tool_use'
      ) {
        state.callCount += 1;
        const name = (block as { name?: unknown }).name;
        if (typeof name === 'string' && name) state.currentTool = name;
      }
    }
  }

  state.offset = start + Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');
  return state;
}

/** Result of reading one workflow's agent rows. */
export type WorkflowAgentsResult = {
  agents: WorkflowAgentRow[];
  /** True when the agent list was cut at MAX_AGENTS_PER_WORKFLOW. */
  truncated: boolean;
  /**
   * Newest write across ALL of this workflow's agent transcripts (epoch ms), or 0
   * when none could be stat'ed.
   *
   * The journal's own mtime is NOT a sufficient activity signal: it only moves on
   * `started`/`result`, so a workflow with two long agents can leave it untouched
   * for many minutes while work is very much in flight. Measured on
   * wf_1a7845b5-de1: journal last written 19:03, agent transcript still growing at
   * 19:11 — eight minutes where "journal quiet" would have meant "dead" and been
   * wrong. Callers combine this with the journal mtime to get the workflow's real
   * last sign of life.
   */
  lastActivityMs: number;
};

/**
 * Reads the agent rows for ONE workflow directory.
 *
 * @param workflowDir Absolute path to `.../subagents/workflows/wf_*`.
 */
export async function readWorkflowAgents(workflowDir: string): Promise<WorkflowAgentsResult> {
  const journalPath = path.join(workflowDir, 'journal.jsonl');
  const { order, resulted } = await readJournalAgentsCached(journalPath);

  // A workflow whose journal has no agent records yet (just spawned, or an
  // unreadable journal) legitimately has nothing to show.
  if (order.length === 0) {
    return { agents: [], truncated: false, lastActivityMs: 0 };
  }

  const truncated = order.length > MAX_AGENTS_PER_WORKFLOW;
  const visible = truncated ? order.slice(0, MAX_AGENTS_PER_WORKFLOW) : order;

  let lastActivityMs = 0;

  const rows = await Promise.all(
    visible.map(async (agentId, index): Promise<WorkflowAgentRow> => {
      const done = resulted.has(agentId);
      const agentPath = path.join(workflowDir, `agent-${agentId}.jsonl`);

      let updatedAt: string | null = null;
      try {
        const mtimeMs = (await fsp.stat(agentPath)).mtimeMs;
        updatedAt = new Date(mtimeMs).toISOString();
        if (mtimeMs > lastActivityMs) lastActivityMs = mtimeMs;
      } catch {
        updatedAt = null;
      }

      const scan = await scanAgentTranscript(agentPath);

      return {
        agentId,
        ordinal: index + 1,
        status: done ? 'done' : 'running',
        callCount: scan.callCount,
        // A finished agent has no "current" tool — showing its last one would
        // read as still-in-flight, the same lie the strip already avoids.
        currentTool: done ? null : scan.currentTool,
        label: scan.label,
        updatedAt,
      };
    }),
  );

  return { agents: rows, truncated, lastActivityMs };
}

/**
 * Guard used by the caller when it walks a workflow directory listing, so a
 * stray file can never be mistaken for an agent transcript.
 */
export function isAgentTranscriptFile(fileName: string): boolean {
  return AGENT_FILE_RE.test(fileName);
}
