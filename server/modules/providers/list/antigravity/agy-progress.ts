/**
 * ADR-199 P5: agy plan and subagent progress, computed once per turn end.
 *
 * - Plan: `brain/<uuid>/task.md`, a markdown checklist (`[ ]` pending, `[/]` in
 *   progress, `[x]` done; also seen wrapped in backticks). There is one file per
 *   brain and agy overwrites it, so it only describes the conversation's LAST
 *   turn and is never stamped on an earlier one.
 * - Subagents: `invoke_subagent` tool calls in the transcript
 *   (`args.Subagents` = JSON text of `[{Role, TypeName, Prompt}]`). The next
 *   GENERIC step lists the child `conversationId`s in order, and a later
 *   SYSTEM_MESSAGE whose header says `sender=<conversationId>` is the child's
 *   report, which settles it. Labels are the role only, never the prompt.
 *
 * Both live (agy-cli.js close handler) and history (fetchHistory) call
 * `buildAgyTurnProgressRows` with the same step summaries, so ids match and the
 * client keeps one copy.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  buildProgressPlan,
  buildProgressSubagent,
  type ProgressPlan,
} from '@/shared/progress-normalize.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

type AnyRecord = Record<string, any>;

const BRAIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_FILE = 'task.md';
const TASK_FILE_MAX_BYTES = 256 * 1024;
const MAX_SUBAGENTS_PER_TURN = 50;
const CHILD_TRANSCRIPT_MAX_BYTES = 1024 * 1024;
const CHECKBOX_LINE = /^\s*(?:[-*+]|\d+[.)])\s+`?\[(.)\]`?\s+(.+?)\s*$/;
const CHECKBOX_STATUS: Readonly<Record<string, string>> = Object.freeze({
  ' ': 'pending', x: 'completed', X: 'completed', '/': 'in_progress',
});
const CONVERSATION_ID = /"conversationId"\s*:\s*"([0-9a-f-]{36})"/gi;
const MESSAGE_SENDER = /\bsender=([0-9a-f-]{36})\b/i;

/** The part of one transcript step that progress needs; large text is dropped. */
export type AgyProgressStep = {
  stepIndex: number;
  type: string;
  createdAt?: string;
  /** Role labels of an `invoke_subagent` call, in order. */
  invoked?: string[];
  /** Child conversation ids listed by a GENERIC step, in order. */
  conversationIds?: string[];
  /** Sender conversation id of a SYSTEM_MESSAGE. */
  sender?: string;
};

/**
 * Reduces one parsed transcript line to a progress step.
 * @returns the step, or null for a line without a usable step index.
 */
export function summarizeAgyProgressStep(line: unknown): AgyProgressStep | null {
  if (!line || typeof line !== 'object') return null;
  const record = line as AnyRecord;
  if (!Number.isSafeInteger(record.step_index) || record.step_index < 0) return null;
  const step: AgyProgressStep = { stepIndex: record.step_index, type: String(record.type || '') };
  if (typeof record.created_at === 'string') step.createdAt = record.created_at;
  const invoked = readInvokedRoles(record.tool_calls);
  if (invoked.length > 0) step.invoked = invoked;
  if (step.type === 'GENERIC' && typeof record.content === 'string' && record.content.includes('conversationId')) {
    step.conversationIds = [...record.content.matchAll(CONVERSATION_ID)].map((match) => match[1].toLowerCase());
  }
  if (step.type === 'SYSTEM_MESSAGE' && typeof record.content === 'string') {
    const sender = MESSAGE_SENDER.exec(record.content.slice(0, 4096));
    if (sender) step.sender = sender[1].toLowerCase();
  }
  return step;
}

/** Role labels of every `invoke_subagent` call on one step. */
function readInvokedRoles(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const roles: string[] = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object' || (call as AnyRecord).name !== 'invoke_subagent') continue;
    let list: unknown = (call as AnyRecord).args?.Subagents;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch { list = []; }
    }
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const record = entry && typeof entry === 'object' ? entry as AnyRecord : {};
      const role = typeof record.Role === 'string' && record.Role.trim() ? record.Role : record.TypeName;
      roles.push(typeof role === 'string' ? role : '');
    }
  }
  return roles;
}

/** Step summaries of a whole transcript text; malformed lines are skipped. */
export function summarizeAgyTranscript(transcript: string): AgyProgressStep[] {
  const steps: AgyProgressStep[] = [];
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const step = summarizeAgyProgressStep(JSON.parse(line));
      if (step) steps.push(step);
    } catch {
      // Skip malformed lines; the transcript is append-only jsonl.
    }
  }
  return steps;
}

/** Step index the last turn starts after: just before its USER_INPUT, else -1. */
export function lastAgyTurnBaseline(steps: readonly AgyProgressStep[]): number {
  let lastUser = -1;
  for (const step of steps) {
    if (step.type === 'USER_INPUT' && step.stepIndex > lastUser) lastUser = step.stepIndex;
  }
  return lastUser > 0 ? lastUser - 1 : -1;
}

/**
 * Plan from task.md checklist text. Lines that are not checklist items are
 * ignored; an unknown box character counts as pending.
 */
export function agyChecklistPlan(markdown: string): ProgressPlan | null {
  const entries: Array<{ label: string; status: string }> = [];
  for (const line of markdown.split('\n')) {
    const match = CHECKBOX_LINE.exec(line);
    if (!match) continue;
    entries.push({ label: plainMarkdown(match[2]), status: CHECKBOX_STATUS[match[1]] ?? 'pending' });
  }
  return buildProgressPlan('artifact', entries);
}

/** Markdown links keep their text only (no file URLs), code ticks are dropped. */
function plainMarkdown(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '');
}

/**
 * Reads `<brainRoot>/<brainUUID>/task.md` only when it really lives inside the
 * given brain root: the uuid is validated, the brain dir's realpath must be a
 * direct child of the root's realpath, and the file is opened without
 * following a symlink and size-capped.
 * @returns the text, or null when absent, unsafe or unreadable.
 */
export async function readAgyTaskFile(brainRoot: string, brainUUID: string): Promise<string | null> {
  if (typeof brainRoot !== 'string' || !brainRoot || !BRAIN_UUID.test(brainUUID)) return null;
  let handle: fsp.FileHandle | null = null;
  try {
    const realRoot = await fsp.realpath(brainRoot);
    const realBrain = await fsp.realpath(path.join(realRoot, brainUUID));
    if (path.dirname(realBrain) !== realRoot) return null;
    handle = await fsp.open(path.join(realBrain, TASK_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > TASK_FILE_MAX_BYTES) return null;
    return await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Brain root and uuid of a transcript path laid out as
 * `<root>/<uuid>/.system_generated/logs/transcript.jsonl`, the path history
 * already reads; null for any other layout.
 */
export function agyBrainOfTranscript(transcriptPath: unknown): { brainRoot: string; brainUUID: string } | null {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  const normalized = path.normalize(transcriptPath);
  const logs = path.dirname(normalized);
  const system = path.dirname(logs);
  const brain = path.dirname(system);
  if (path.basename(normalized) !== 'transcript.jsonl' || path.basename(logs) !== 'logs'
    || path.basename(system) !== '.system_generated') return null;
  const brainUUID = path.basename(brain);
  if (!BRAIN_UUID.test(brainUUID)) return null;
  return { brainRoot: path.dirname(brain), brainUUID };
}

/**
 * Status rows for the turn after `afterStepIndex`: one with `plan` (when
 * task.md yields one) and one per invoked subagent. Ids are derived from the
 * brain and the turn's first step, so the live and history copies match.
 */
export function buildAgyTurnProgressRows(input: {
  steps: readonly AgyProgressStep[];
  afterStepIndex: number;
  brainUUID: string;
  sessionId: string;
  plan: ProgressPlan | null;
  childTools?: Map<string, Array<{ name: string; status?: string }>>;
}): NormalizedMessage[] {
  const turn = input.steps.filter((step) => step.stepIndex > input.afterStepIndex)
    .sort((a, b) => a.stepIndex - b.stepIndex);
  if (turn.length === 0) return [];
  const turnKey = turn.find((step) => step.type === 'USER_INPUT')?.stepIndex ?? input.afterStepIndex + 1;
  const timestamp = turn[turn.length - 1].createdAt;
  const idBase = `antigravity_${input.brainUUID}_progress_${turnKey}`;
  const base = { sessionId: input.sessionId, provider: 'antigravity' as const, kind: 'status' as const, timestamp };
  const rows: NormalizedMessage[] = [];
  if (input.plan) rows.push(createNormalizedMessage({ ...base, id: `${idBase}_plan`, plan: input.plan }));
  turnSubagents(turn).forEach((record, index) => {
    // Antigravity's invoke_subagent transcript gives Role/TypeName only; its
    // task listing/report does not expose child model, effort, or tool events.
    const subagent = buildProgressSubagent({
      id: `${idBase}_agent_${index}`,
      parentId: null,
      ...record,
      agentName: record.label,
      ...(record.conversationId && input.childTools?.has(record.conversationId)
        ? { tools: input.childTools.get(record.conversationId) } : {}),
    });
    if (subagent) rows.push(createNormalizedMessage({ ...base, id: `${idBase}_agent_${index}`, subagent }));
  });
  return rows;
}

/** The GENERIC child listing answering the invoke at `position`, before any later invoke. */
function childListingAfter(turn: readonly AgyProgressStep[], position: number): AgyProgressStep | undefined {
  for (const later of turn.slice(position + 1)) {
    if (later.conversationIds) return later;
    if (later.invoked) return undefined;
  }
  return undefined;
}

/** Invoked subagents of one turn with their settled state. */
function turnSubagents(turn: readonly AgyProgressStep[]): Array<{
  label: string; state: 'running' | 'completed'; conversationId?: string;
}> {
  const reported = new Set(turn.map((step) => step.sender).filter(Boolean));
  const result: Array<{ label: string; state: 'running' | 'completed' }> = [];
  turn.forEach((step, position) => {
    if (!step.invoked) return;
    const listing = childListingAfter(turn, position);
    step.invoked.forEach((label, index) => {
      if (result.length >= MAX_SUBAGENTS_PER_TURN) return;
      const child = listing?.conversationIds?.[index];
      result.push({
        label,
        state: child && reported.has(child) ? 'completed' : 'running',
        ...(child ? { conversationId: child } : {}),
      });
    });
  });
  return result;
}

/** Reads child tool names from their sibling conversation transcripts. */
export async function readAgyChildTools(
  brainRoot: string,
  steps: readonly AgyProgressStep[],
): Promise<Map<string, Array<{ name: string }>>> {
  const ids = [...new Set(steps.flatMap((step) => step.conversationIds ?? []))];
  const tools = new Map<string, Array<{ name: string }>>();
  if (!ids.length) return tools;
  let realRoot: string;
  try { realRoot = await fsp.realpath(brainRoot); } catch { return tools; }
  for (const id of ids) {
    if (!BRAIN_UUID.test(id)) continue;
    let handle: fsp.FileHandle | null = null;
    try {
      const brainDir = await fsp.realpath(path.join(realRoot, id));
      if (path.dirname(brainDir) !== realRoot) continue;
      const systemDir = await fsp.realpath(path.join(brainDir, '.system_generated'));
      if (path.dirname(systemDir) !== brainDir) continue;
      const logsDir = await fsp.realpath(path.join(systemDir, 'logs'));
      if (path.dirname(logsDir) !== systemDir) continue;
      const file = path.join(logsDir, 'transcript.jsonl');
      handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      const start = Math.max(0, stat.size - CHILD_TRANSCRIPT_MAX_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
      }
      const childTools: Array<{ name: string }> = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row: AnyRecord;
        try { row = JSON.parse(line) as AnyRecord; } catch { continue; }
        if (!Array.isArray(row.tool_calls)) continue;
        for (const call of row.tool_calls) {
          const name = call && typeof call.name === 'string' ? call.name : '';
          if (name) childTools.push({ name });
        }
      }
      if (childTools.length) tools.set(id, childTools.slice(-100));
    } catch {
      // Missing, linked or unreadable child transcripts do not affect the parent.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return tools;
}
