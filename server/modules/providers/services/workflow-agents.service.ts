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
 *
 * PINNED READS (ADR-201 A1): every file is opened through the session's pinned
 * `subagents/workflows` directory (`SessionArtifactDir.openFile`), never by a
 * path; a symlinked, hardlinked or missing file reads as absent.
 */

import type { FileHandle } from 'node:fs/promises';

import type { SessionArtifactDir } from '../shared/session-transcript-reader.js';

/** One delegated workflow agent, as surfaced to the composer strip. */
export type WorkflowAgentRow = {
  /** Journal `agentId` — stable across polls, used as the React key. */
  agentId: string;
  /** 1-based position in the journal's `started` order (delegation order). */
  ordinal: number;
  /**
   * done   = a `result` record exists.
   * running = started, no result, and its transcript was written recently.
   * stale  = started, no result, and NOTHING has been written to its transcript
   *          for AGENT_STALE_MS.
   *
   * The third state is not a nicety. Journal-presence alone ("started with no
   * result") was the row's original definition, and it reproduced the exact bug
   * this whole feature exists to kill: after the coordinator process died, two
   * agents kept rendering as a pulsing green "running · now Bash" for EIGHTEEN
   * HOURS, because a dead agent never writes the `result` record that would have
   * retired it. `stale` claims neither life nor death — it says "no sign of life
   * since", which is all the filesystem can honestly support.
   */
  status: 'running' | 'done' | 'stale';
  /** Tool calls this agent has issued so far (from its own transcript). */
  callCount: number;
  /** Name of the most recent tool call while running; null when done/unknown. */
  currentTool: string | null;
  /** Short task label when the prompt opens with one; null when not derivable. */
  label: string | null;
  /** Last write to this agent's transcript (ISO), or null when unreadable. */
  updatedAt: string | null;
  /** Resolved model from a child transcript message, when present. */
  model: string | null;
  /** Resolved effort from a child transcript message, when present. */
  effort: string | null;
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

/**
 * Silence after which an unfinished agent is reported `stale` instead of
 * `running`. Matches the workflow-level stale guard in workflow-status.service:
 * generous enough that one long tool call (a build, a big grep) cannot trip it,
 * short enough that a killed run stops claiming to work within the same session.
 */
export const AGENT_STALE_MS = 15 * 60 * 1000;

/** `agent-<id>.jsonl` — the id charset is fixed by the harness (hex-ish token). */
const AGENT_FILE_RE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

type AgentScanState = {
  offset: number;
  size: number;
  callCount: number;
  currentTool: string | null;
  model: string | null;
  effort: string | null;
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

const NO_JOURNAL_AGENTS: JournalAgents = Object.freeze({ order: [], resulted: new Set<string>() }) as JournalAgents;

/** Journal agents of `wfId`, read through the pinned workflows dir on a (wf, mtime, size) memo. */
async function readJournalAgentsCached(workflows: SessionArtifactDir, wfId: string): Promise<JournalAgents> {
  const child = await workflows.openFile(`${wfId}/journal.jsonl`);
  if (!('handle' in child)) return NO_JOURNAL_AGENTS;
  try {
    const memoKey = `${workflows.realpath}/${wfId}`;
    const cacheKey = `${memoKey}:${child.stat.mtimeMs}:${child.stat.size}`;
    const hit = journalAgentsCache.get(cacheKey);
    if (hit) return hit;
    const parsed = parseJournalAgents(await child.handle.readFile({ encoding: 'utf8' }));
    // Single-entry-per-journal memo: an older key for the same journal is dead weight.
    for (const key of journalAgentsCache.keys()) {
      if (key.startsWith(`${memoKey}:`)) journalAgentsCache.delete(key);
    }
    journalAgentsCache.set(cacheKey, parsed);
    return parsed;
  } catch {
    return NO_JOURNAL_AGENTS;
  } finally {
    await workflows.closeFile(child);
  }
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
 * them into that agent's running totals. `key` names the file's cursor (its
 * realpath); `handle` is its pinned descriptor. Never throws.
 */
async function scanAgentTranscript(key: string, handle: FileHandle): Promise<AgentScanState> {
  let state = agentScanStates.get(key);
  if (!state) {
    state = {
      offset: 0,
      size: 0,
      callCount: 0,
      currentTool: null,
      model: null,
      effort: null,
      label: null,
      labelResolved: false,
    };
    agentScanStates.set(key, state);
  }

  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch {
    return state;
  }

  // Rotation/truncation: the cursor and the derived totals no longer describe
  // this file, so recount from zero rather than reporting a stale sum.
  if (size < state.offset) {
    state.offset = 0;
    state.callCount = 0;
    state.currentTool = null;
    state.model = null;
    state.effort = null;
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
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, end - start, start);
    chunk = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return state;
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

    let row: { effort?: unknown; message?: {
      content?: unknown; model?: unknown; effort?: unknown; reasoning_effort?: unknown;
    } };
    try {
      row = JSON.parse(trimmed) as { message?: { content?: unknown } };
    } catch {
      continue;
    }
    const content = row?.message?.content;
    if (typeof row.message?.model === 'string') state.model = row.message.model;
    const effort = row.effort ?? row.message?.effort ?? row.message?.reasoning_effort;
    if (typeof effort === 'string') state.effort = effort;
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
   * wf_synthetic_1a7845b5-de1: journal last written 19:03, agent transcript still growing at
   * 19:11 — eight minutes where "journal quiet" would have meant "dead" and been
   * wrong. Callers combine this with the journal mtime to get the workflow's real
   * last sign of life.
   */
  lastActivityMs: number;
};

/** Agent ids are harness tokens; anything else is never joined onto a child name. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type AgentFileView = { mtimeMs: number; scan: AgentScanState | null };

/** mtime and folded totals of one agent transcript, opened through the pinned dir. */
async function viewAgentFile(workflows: SessionArtifactDir, wfId: string, agentId: string): Promise<AgentFileView> {
  if (!AGENT_ID_RE.test(agentId)) return { mtimeMs: 0, scan: null };
  const child = await workflows.openFile(`${wfId}/agent-${agentId}.jsonl`);
  if (!('handle' in child)) return { mtimeMs: 0, scan: null };
  try {
    return { mtimeMs: Number(child.stat.mtimeMs), scan: await scanAgentTranscript(child.realpath, child.handle) };
  } finally {
    await workflows.closeFile(child);
  }
}

/** One composer row from an agent's journal state and its file view. */
function agentRow(agentId: string, index: number, done: boolean, view: AgentFileView, now: number): WorkflowAgentRow {
  // An unfinished agent is only "running" while its transcript still moves.
  // A missing transcript (mtimeMs === 0) cannot prove recency either, so it
  // is stale rather than running — absence of a file is not a heartbeat.
  const silentFor = view.mtimeMs > 0 ? now - view.mtimeMs : Number.POSITIVE_INFINITY;
  const stale = !done && silentFor >= AGENT_STALE_MS;
  return {
    agentId,
    ordinal: index + 1,
    status: done ? 'done' : stale ? 'stale' : 'running',
    callCount: view.scan?.callCount ?? 0,
    // Only a genuinely live agent has a "current" tool. For a finished one it
    // would read as still-in-flight; for a stale one it is worse — it was the
    // tool it died on, rendered as though it were happening now.
    currentTool: done || stale ? null : view.scan?.currentTool ?? null,
    label: view.scan?.label ?? null,
    updatedAt: view.mtimeMs > 0 ? new Date(view.mtimeMs).toISOString() : null,
    model: view.scan?.model ?? null,
    effort: view.scan?.effort ?? null,
  };
}

/**
 * Reads the agent rows for ONE workflow, through the session's pinned
 * `subagents/workflows` directory.
 *
 * @param workflows The pinned `subagents/workflows` directory.
 * @param wfId      The workflow entry name (`wf_*`).
 */
export async function readWorkflowAgents(
  workflows: SessionArtifactDir,
  wfId: string,
  options: { now?: number } = {},
): Promise<WorkflowAgentsResult> {
  const now = options.now ?? Date.now();
  const { order, resulted } = await readJournalAgentsCached(workflows, wfId);

  // A workflow whose journal has no agent records yet (just spawned, or an
  // unreadable journal) legitimately has nothing to show.
  if (order.length === 0) {
    return { agents: [], truncated: false, lastActivityMs: 0 };
  }

  const truncated = order.length > MAX_AGENTS_PER_WORKFLOW;
  const visible = truncated ? order.slice(0, MAX_AGENTS_PER_WORKFLOW) : order;
  const views = await Promise.all(visible.map((agentId) => viewAgentFile(workflows, wfId, agentId)));
  const lastActivityMs = views.reduce((latest, view) => Math.max(latest, view.mtimeMs), 0);
  const agents = visible.map((agentId, index) => agentRow(agentId, index, resulted.has(agentId), views[index], now));
  return { agents, truncated, lastActivityMs };
}

/**
 * Guard used by the caller when it walks a workflow directory listing, so a
 * stray file can never be mistaken for an agent transcript.
 */
export function isAgentTranscriptFile(fileName: string): boolean {
  return AGENT_FILE_RE.test(fileName);
}
