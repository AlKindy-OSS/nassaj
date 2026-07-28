/**
 * T-873(2) — `Agent`-path orphan reader (VISIBILITY + EXTRACTION ONLY).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * When a background `Agent` (the Agent tool, NOT a `Workflow`) dies, nassaj sees
 * nothing: no orphan badge, no "result never delivered" card, no completion row.
 * The only recovery to date has been the coordinator doing it BY HAND (`tail` on
 * the agent transcript + `git log`). The raw material, however, is complete and
 * permanent on disk — the loss was purely in the in-memory delivery hop. This
 * module turns that manual `tail` into a typed read.
 *
 * SCOPE — ORTHOGONAL to workflow-reconcile.service.ts
 * ---------------------------------------------------
 * `workflow-reconcile` reads ONLY `<sessionDir>/subagents/workflows/wf_*` and is
 * deliberately capped there (T-825). This reader reads ONLY the sibling
 * `<sessionDir>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json`. The two
 * trees are disjoint, the two shapes are disjoint (journal `started`/`result`
 * keys vs. an agent transcript's record stream), so neither can ever claim the
 * other's completion. Workflow subagent transcripts live UNDER `workflows/` and
 * are therefore never seen here.
 *
 * HARD LIMIT — READ-ONLY. NOTHING HERE LAUNCHES OR RESUMES ANYTHING.
 * There is no spawn, no exec, no write, no resume trigger in this file or in any
 * of its consumers. The standing veto on automatic agent resume (two committees)
 * is structural here, not a convention: the module's entire output is data.
 *
 * THE THREE SIGNALS (measured on 606 real `agent-*.jsonl` files, not assumed)
 * --------------------------------------------------------------------------
 *   START      — the FIRST record's `timestamp` (ADR-051's launch moment; the
 *                harness writes it for every agent without exception).
 *   COMPLETION — the LAST record is `type:'assistant'` carrying a `text` block.
 *                That text IS the report that was never delivered, verbatim.
 *                548/606.
 *   CUT        — the LAST record is `type:'user'` whose text starts with
 *                `[Request interrupted`. Two wordings exist in the wild
 *                (`…by user]`, `…by user for tool use]`). 53/606.
 *
 * THREE MEASURED CONSTRAINTS THAT SHAPE THE CLASSIFIER
 * ----------------------------------------------------
 * 1. `stop_reason` IS NOT USABLE and is never read here. Of the completed
 *    agents, 95 carry `stop_reason:null` — keying off it mis-classifies them.
 *    The incident transcript's own final assistant record has `stop_reason:null`
 *    while being a genuine, complete report.
 * 2. POSITION DECIDES, NOT PRESENCE. 41 agents contain `[Request interrupted]`
 *    somewhere in the MIDDLE and then went on to finish. Only the LAST record is
 *    consulted.
 * 3. NO FALSE `settled`. A last record that is a bare `tool_use`/`thinking`
 *    (agent cut mid-turn) or a bare `tool_result` (the "no trace" class the
 *    harness itself warns about: "stopped via the UI, an SDK interrupt, or agent
 *    teardown — these leave no transcript marker") is reported as
 *    {@link AgentOutcome.outcome} `'unknown'` WITH A REASON — never as completed
 *    and never as settled. Deciding those needs evidence this file does not
 *    have, so it declines to decide.
 *
 *    Two shapes that LOOK complete are declined for the same reason, because the
 *    only tolerable direction of error here is towards `'unknown'`:
 *      (a) MIXED RECORD — an assistant record carrying text AND a `tool_use`.
 *          The model narrated, called a tool, and the transcript ends before the
 *          tool returned: the turn never closed. Today's harness splits narration
 *          and tool calls into two records, so this is 0/614 on the live corpus —
 *          but had it been read as `'completed'`, a format change would have
 *          degraded SILENTLY towards a false settlement. The tool_use check runs
 *          BEFORE the text check precisely so that ordering is not an accident.
 *      (b) TORN TAIL — bytes exist after the last newline that do not parse as
 *          JSON. That is a write cut mid-record: `parseRecords` would skip the
 *          torn line and hand the classifier the PREVIOUS record, which is often
 *          a final assistant text ⇒ a false `'completed'` for a file that was
 *          still being written. Measured: 614/614 real transcripts end with a
 *          newline, so an unparseable trailing fragment is never the healthy
 *          shape and the signal costs no false positives.
 *
 * WHY A BOUNDED TAIL READ
 * -----------------------
 * The 606 agent transcripts total ~230 MB (largest single file 2.2 MB, largest
 * single LINE 574 KB), so streaming them whole on a request path is not viable.
 * Classification only ever depends on the LAST record, so the reader pulls a
 * bounded tail window. Measured on the real corpus, a 1 MiB window reaches the
 * decisive record in 606/606 files (256 KiB reaches 604/606). When the window
 * still fails to yield a parseable record the outcome is `'unknown'` with reason
 * `'window-truncated'` — a declined verdict, never a guessed one.
 *
 * FAIL-SAFE: every path degrades to `'unknown'`/null and never throws, mirroring
 * `readJournalKeySets`' contract.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';

/**
 * Bytes read from the END of an agent transcript. 1 MiB reaches the decisive
 * record in 606/606 real transcripts while capping worst-case I/O per agent.
 */
export const DEFAULT_TAIL_BYTES = 1024 * 1024;

/**
 * Bytes read from the START of an agent transcript to recover the launch
 * timestamp. The first record embeds the full spawn prompt, so it can be large;
 * 256 KiB covers it comfortably. A first line longer than this yields
 * `startedAt: null` (declined), never a wrong timestamp.
 */
const HEAD_BYTES = 256 * 1024;

/**
 * Upper bound on the recovered final-report text. Longer reports are truncated
 * and flagged via {@link AgentOutcome.finalTextTruncated} so a caller never
 * mistakes a clipped report for the whole one.
 */
const MAX_FINAL_TEXT_CHARS = 20000;

/** Both interruption wordings observed across the corpus. */
const INTERRUPTION_PREFIX = '[Request interrupted';

/**
 * Terminal outcome of one `Agent` run, decided from its transcript alone.
 *
 *   - `'completed'`   — a final assistant text report exists on disk.
 *   - `'interrupted'` — the transcript ends with the harness' explicit cut marker.
 *   - `'unknown'`     — NOT decidable from the file. Never treat as completed,
 *                       never as settled. `unknownReason` says why.
 */
export type AgentTerminalOutcome = 'completed' | 'interrupted' | 'unknown';

/**
 * Why an outcome was declined. Non-null exactly when `outcome === 'unknown'`, so
 * a caller/UI can distinguish "still working" from "died leaving no marker" from
 * "we could not read it" — three very different things that must not collapse
 * into one ambiguous badge.
 *
 *   - `'in-flight-turn'`     — ends on an assistant record whose turn never
 *                              closed: a bare `tool_use`/`thinking`, OR text
 *                              followed by a `tool_use` that never returned.
 *                              Mid-turn (either alive right now, or cut).
 *   - `'no-terminal-marker'` — ends on a bare `tool_result` (or any other shape):
 *                              the harness-documented "leaves no transcript
 *                              marker" teardown class.
 *   - `'torn-tail'`          — the file ends mid-record (unparseable bytes after
 *                              the last newline): it was cut while being written,
 *                              so the last COMPLETE record is not the last event.
 *   - `'window-truncated'`   — the tail window held no parseable record.
 *   - `'unreadable'`         — stat/read failed, or the file is empty.
 */
export type AgentUnknownReason =
  | 'in-flight-turn'
  | 'no-terminal-marker'
  | 'torn-tail'
  | 'window-truncated'
  | 'unreadable';

/** The `agent-<id>.meta.json` sidecar the server has ignored until now. */
export type AgentMeta = {
  agentType: string | null;
  description: string | null;
  /**
   * THE CORRECT JOIN KEY to the parent transcript. Written at LAUNCH, unlike
   * `toolUseResult.agentId` which is written at RESULT time and therefore does
   * not exist for an agent that never produced a result. Measured coverage of
   * interrupted agents: 50% via `toolUseResult.agentId` vs 100% here.
   */
  toolUseId: string | null;
  spawnDepth: number | null;
  model: string | null;
  parentAgentId: string | null;
};

/** One agent's transcript verdict. */
export type AgentOutcome = {
  agentId: string;
  outcome: AgentTerminalOutcome;
  /** Non-null exactly when `outcome === 'unknown'`. */
  unknownReason: AgentUnknownReason | null;
  /** First record's timestamp (ISO) — the launch moment. */
  startedAt: string | null;
  /** Last record's timestamp (ISO). */
  lastActivityAt: string | null;
  /** Transcript mtime (ISO) — the freshness signal, never a liveness claim. */
  updatedAt: string | null;
  /**
   * The final assistant text: the undelivered report, verbatim. Present for
   * `'completed'`, and ALSO for `'interrupted'`/`'unknown'` when the agent had
   * produced a report before being cut — which is exactly the incident shape
   * (work finished, then killed 63s later, report never delivered).
   */
  finalText: string | null;
  /** True when `finalText` was clipped at {@link MAX_FINAL_TEXT_CHARS}. */
  finalTextTruncated: boolean;
  /** The verbatim cut marker, when `outcome === 'interrupted'`. */
  interruptionText: string | null;
};

/** Extracts the concatenated `text` blocks of a record's message, or null. */
function readMessageText(record: AnyRecord): string | null {
  const content = (record?.message as AnyRecord | undefined)?.content;
  if (typeof content === 'string') {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of content as AnyRecord[]) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** True when a record's message content holds at least one block of `type`. */
function hasBlock(record: AnyRecord, type: string): boolean {
  const content = (record?.message as AnyRecord | undefined)?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return (content as AnyRecord[]).some((part) => part && part.type === type);
}

/**
 * The pure classifier: verdict from the LAST record alone (constraint 2).
 *
 * Deliberately does NOT look at `stop_reason` (constraint 1) and deliberately
 * refuses to guess (constraint 3). Total and side-effect free.
 */
export function classifyLastRecord(
  lastRecord: AnyRecord | null,
): { outcome: AgentTerminalOutcome; unknownReason: AgentUnknownReason | null } {
  if (!lastRecord) {
    return { outcome: 'unknown', unknownReason: 'window-truncated' };
  }

  const type = lastRecord.type;

  if (type === 'assistant') {
    // AN UNCLOSED TURN BEATS THE PRESENCE OF TEXT. A record holding text AND a
    // `tool_use` means the model narrated, called a tool, and the transcript ends
    // before the result came back — the turn never closed, so this is NOT a
    // completion even though a readable report is sitting right there (the caller
    // still receives that text as `finalText`; what it does not receive is a
    // false verdict). This check must stay ABOVE the text check.
    if (hasBlock(lastRecord, 'tool_use')) {
      return { outcome: 'unknown', unknownReason: 'in-flight-turn' };
    }
    // A final assistant TEXT block is the completion signal — the report itself.
    if (readMessageText(lastRecord) !== null) {
      return { outcome: 'completed', unknownReason: null };
    }
    // Ends on tool_use/thinking with no text: the turn never closed. Could be a
    // live agent mid-tool, or one killed before the tool returned. Not decidable
    // here, and emphatically NOT a completion.
    return { outcome: 'unknown', unknownReason: 'in-flight-turn' };
  }

  if (type === 'user') {
    const text = readMessageText(lastRecord);
    if (text !== null && text.trimStart().startsWith(INTERRUPTION_PREFIX)) {
      return { outcome: 'interrupted', unknownReason: null };
    }
    // A bare tool_result tail (or anything else): the documented "no transcript
    // marker" teardown class.
    return { outcome: 'unknown', unknownReason: 'no-terminal-marker' };
  }

  return { outcome: 'unknown', unknownReason: 'no-terminal-marker' };
}

/**
 * True when a slice ends MID-RECORD: non-whitespace bytes follow the last
 * newline and do not parse as JSON.
 *
 * This is the only evidence a bounded read has that the file was cut while being
 * written. Without it, {@link parseRecords} quietly drops the torn line and the
 * classifier judges the PREVIOUS record — routinely a final assistant text —
 * producing a false `'completed'`. Measured on the live corpus: 614/614 healthy
 * transcripts end with a newline and 0/614 carry an unparseable trailing
 * fragment, so this signal has no false positives to trade against.
 *
 * Callers apply it only when a complete record was actually recovered; a window
 * that starts mid-line and holds no full record is `'window-truncated'`, which
 * is a different (and equally declined) verdict.
 */
export function hasTornTail(slice: string): boolean {
  const trailing = slice.slice(slice.lastIndexOf('\n') + 1).trim();
  if (!trailing) {
    return false;
  }
  try {
    JSON.parse(trailing);
    return false;
  } catch {
    return true;
  }
}

/** Parses a JSONL slice into records, skipping malformed/partial lines. */
function parseRecords(slice: string, dropFirstPartial: boolean): AnyRecord[] {
  const lines = slice.split('\n');
  if (dropFirstPartial) {
    lines.shift();
  }
  const records: AnyRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as AnyRecord);
    } catch {
      // Partial head line, or a torn line from a concurrent write. Skipped.
    }
  }
  return records;
}

/** Reads a byte range and decodes it as UTF-8. */
async function readRange(
  handle: fsp.FileHandle,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) {
    return '';
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

/** Reads an ISO timestamp field defensively. */
function readTimestamp(record: AnyRecord | null | undefined): string | null {
  const ts = record?.timestamp;
  return typeof ts === 'string' && ts.length > 0 ? ts : null;
}

/**
 * Reads one `agent-<id>.jsonl` and returns its verdict.
 *
 * Read-only, bounded, and fail-safe: any anomaly degrades to `'unknown'` with a
 * reason and never throws. Never opens the file for writing and never inspects
 * `stop_reason`.
 *
 * @param agentPath Absolute path to `<sessionDir>/subagents/agent-<id>.jsonl`.
 * @param agentId   The id parsed from the file name (used verbatim in the result).
 */
export async function readAgentOutcome(
  agentPath: string,
  agentId: string,
  options: { tailBytes?: number } = {},
): Promise<AgentOutcome> {
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;

  const unreadable: AgentOutcome = {
    agentId,
    outcome: 'unknown',
    unknownReason: 'unreadable',
    startedAt: null,
    lastActivityAt: null,
    updatedAt: null,
    finalText: null,
    finalTextTruncated: false,
    interruptionText: null,
  };

  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(agentPath, 'r');
    const stat = await handle.stat();
    const size = stat.size;
    if (size === 0) {
      return { ...unreadable, updatedAt: new Date(stat.mtimeMs).toISOString() };
    }
    const updatedAt = new Date(stat.mtimeMs).toISOString();

    // --- head: the launch record ---------------------------------------------
    const headLength = Math.min(size, HEAD_BYTES);
    const headSlice = await readRange(handle, 0, headLength);
    const newlineIndex = headSlice.indexOf('\n');
    // A first line longer than HEAD_BYTES is only usable if the whole file fit in
    // the head read; otherwise decline the timestamp rather than parse a fragment.
    const firstLine =
      newlineIndex >= 0
        ? headSlice.slice(0, newlineIndex)
        : headLength === size
          ? headSlice
          : '';
    const firstRecord = parseRecords(firstLine, false)[0] ?? null;

    // --- tail: the decisive record + the final report ------------------------
    const tailStart = Math.max(0, size - tailBytes);
    // Reuse the head slice when the file fits entirely inside it (the common
    // small-transcript case) instead of issuing a second read.
    const tailSlice =
      tailStart === 0 && headLength === size
        ? headSlice
        : await readRange(handle, tailStart, size - tailStart);
    const tailRecords = parseRecords(tailSlice, tailStart > 0);

    const lastRecord = tailRecords.length > 0 ? tailRecords[tailRecords.length - 1] : null;
    let { outcome, unknownReason } = classifyLastRecord(lastRecord);

    // A file cut mid-write: the last COMPLETE record is not the last event, so
    // whatever the classifier concluded from it is unsafe. Decline rather than
    // inherit a `'completed'` from the record before the tear. Only meaningful
    // once a full record was recovered — otherwise the verdict is already
    // `'window-truncated'` and stays that way.
    if (lastRecord && hasTornTail(tailSlice)) {
      outcome = 'unknown';
      unknownReason = 'torn-tail';
    }

    // The final assistant report: the LAST assistant record carrying text within
    // the window. For 'interrupted' this is the work the agent finished just
    // before it was cut — the report the delivery hop lost.
    let finalText: string | null = null;
    for (let index = tailRecords.length - 1; index >= 0; index -= 1) {
      const record = tailRecords[index];
      if (record.type !== 'assistant') {
        continue;
      }
      const text = readMessageText(record);
      if (text !== null) {
        finalText = text;
        break;
      }
    }
    const finalTextTruncated = finalText !== null && finalText.length > MAX_FINAL_TEXT_CHARS;

    const interruptionText =
      outcome === 'interrupted' && lastRecord ? readMessageText(lastRecord) : null;

    return {
      agentId,
      outcome,
      unknownReason,
      startedAt: readTimestamp(firstRecord),
      lastActivityAt: readTimestamp(lastRecord),
      updatedAt,
      finalText: finalTextTruncated ? finalText!.slice(0, MAX_FINAL_TEXT_CHARS) : finalText,
      finalTextTruncated,
      interruptionText,
    };
  } catch (error) {
    console.debug(
      `[agent-reconcile] could not read agent transcript ${agentPath}:`,
      error instanceof Error ? error.message : String(error),
    );
    return unreadable;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Reads a string field from the meta sidecar, or null. */
function metaString(record: AnyRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads `agent-<id>.meta.json` — the sidecar `claude-sessions.provider.ts` has
 * always skipped ("the sidecar agent-*.meta.json files are ignored"). It is the
 * ONLY place `toolUseId` exists for an agent that never produced a result, which
 * is precisely the population this feature is about.
 *
 * Fail-safe: a missing/malformed sidecar yields an all-null record, never a throw.
 */
export async function readAgentMeta(metaPath: string): Promise<AgentMeta> {
  const empty: AgentMeta = {
    agentType: null,
    description: null,
    toolUseId: null,
    spawnDepth: null,
    model: null,
    parentAgentId: null,
  };

  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return empty;
    }
    const record = parsed as AnyRecord;
    const spawnDepth = record.spawnDepth;
    return {
      agentType: metaString(record, 'agentType'),
      description: metaString(record, 'description'),
      toolUseId: metaString(record, 'toolUseId'),
      spawnDepth: typeof spawnDepth === 'number' && Number.isFinite(spawnDepth) ? spawnDepth : null,
      model: metaString(record, 'model'),
      parentAgentId: metaString(record, 'parentAgentId'),
    };
  } catch {
    // ENOENT is the norm for workflow subagents; anything else is equally benign.
    return empty;
  }
}

/**
 * Lists the direct `Agent` ids under `<sessionDir>/subagents`.
 *
 * Only the FLAT `agent-<id>.jsonl` entries are returned. `workflows/` is a
 * subdirectory and is never descended into, which is what keeps this reader
 * disjoint from `workflow-reconcile`'s tree (T-825).
 */
export async function listSessionAgentIds(subagentsDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(subagentsDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue; // skips `workflows/`
      }
      const name = entry.name;
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) {
        continue;
      }
      ids.push(name.slice('agent-'.length, -'.jsonl'.length));
    }
    return ids;
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== 'ENOENT') {
      console.debug(`[agent-reconcile] could not list ${subagentsDir}:`, fileError.message);
    }
    return [];
  }
}

/** Absolute path of an agent transcript inside a session's `subagents` dir. */
export function agentTranscriptPath(subagentsDir: string, agentId: string): string {
  return path.join(subagentsDir, `agent-${agentId}.jsonl`);
}

/** Absolute path of an agent's meta sidecar inside a session's `subagents` dir. */
export function agentMetaPath(subagentsDir: string, agentId: string): string {
  return path.join(subagentsDir, `agent-${agentId}.meta.json`);
}
