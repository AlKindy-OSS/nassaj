import { createHash } from 'node:crypto';
import path from 'node:path';

import type { SkillObservation, SkillSummary } from '../../../../shared/skillObservations.js';

type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
export const safeNativeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** Domain-separated opaque identifiers never contain transcript arguments or paths. */
export const skillHash = (domain: string, ...values: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(['skill-v1', domain, ...values])).digest('hex');

export type SkillIdentity = { key: string; name: string };
export type NativeSkillEvent =
  | { kind: 'call'; callId: string; name: string; args: RecordValue; timestamp: string | null }
  | { kind: 'result'; callId: string; outcome: SkillObservation['outcome']; shellOutcome: SkillObservation['outcome'] };

const timestamp = (value: unknown): string | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const parseArgs = (value: unknown): RecordValue => {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
};

/** Extract only native structured tool calls/results; never assistant prose or exec code. */
export function nativeSkillEvents(entry: RecordValue, provider: 'claude' | 'codex'): NativeSkillEvent[] {
  if (provider === 'claude') {
    const content = record(entry.message).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((value): NativeSkillEvent[] => {
      const block = record(value);
      if (entry.type === 'assistant' && block.type === 'tool_use' && safeNativeId(block.id)) {
        return [{ kind: 'call', callId: block.id, name: String(block.name ?? ''),
          args: record(block.input), timestamp: timestamp(entry.timestamp) }];
      }
      if (entry.type === 'user' && block.type === 'tool_result' && safeNativeId(block.tool_use_id)) {
        const detail = record(entry.toolUseResult);
        const completed = detail.interrupted === false && !detail.backgroundTaskId && !detail.task_id;
        return [{ kind: 'result', callId: block.tool_use_id,
          outcome: block.is_error === true ? 'failed' : 'succeeded',
          shellOutcome: block.is_error === true || detail.interrupted === true ? 'failed'
            : completed ? 'succeeded' : 'unknown' }];
      }
      return [];
    });
  }
  const payload = record(entry.payload);
  if (entry.type !== 'response_item' || !safeNativeId(payload.call_id)) return [];
  if (payload.type === 'function_call') return [{ kind: 'call', callId: payload.call_id,
    name: typeof payload.namespace === 'string' ? `${payload.namespace}.${payload.name}` : String(payload.name ?? ''),
    args: parseArgs(payload.arguments), timestamp: timestamp(entry.timestamp) }];
  if (payload.type !== 'function_call_output') return [];
  const output = parseArgs(payload.output);
  const text = typeof payload.output === 'string' ? payload.output : '';
  // Native exec envelopes have status BEFORE the Output field. File contents cannot supply it.
  const exit = text.match(/^(?:Chunk ID: [^\n]+\n)?Wall time: [^\n]+\nProcess exited with code (\d+)\n(?:Final output|Output):/);
  const code = typeof output.exit_code === 'number' ? output.exit_code : exit ? Number(exit[1]) : null;
  return [{ kind: 'result', callId: payload.call_id,
    outcome: output.isError === true ? 'failed' : output.isError === false ? 'succeeded' : 'unknown',
    shellOutcome: output.isError === true || code !== null && code !== 0 ? 'failed'
      : code === 0 ? 'succeeded' : 'unknown' }];
}

/** Deliberately tiny shell grammar: one literal cat operand, no expansion or compound shell. */
export function literalSkillRead(command: unknown): string | null {
  if (typeof command !== 'string' || command.length > 4096) return null;
  const match = /^cat\s+(?:'([^'\n]+)'|"([^"$`\\\n]+)"|([^\s'"$`\\;|&<>()[\]{}*?!]+))\s*$/.exec(command);
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

/** Classify direct evidence using an owner-scoped definition resolver supplied by the adapter. */
export function classifySkillCall(
  event: Extract<NativeSkillEvent, { kind: 'call' }>, provider: 'claude' | 'codex',
  resolveDefinition: (target: string) => SkillIdentity | null,
  resolveInvocation: (name: string) => SkillIdentity | null = () => null,
  identityScope = 'unresolved',
): { identity: SkillIdentity; evidence: SkillObservation['evidence'] } | null {
  if (provider === 'claude' && event.name === 'Skill' && typeof event.args.skill === 'string') {
    const name = event.args.skill;
    return { identity: resolveInvocation(name) ?? { key: skillHash('invocation', provider, identityScope, name),
      name: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(name) ? name : 'Unresolved skill' }, evidence: 'invocation' };
  }
  let target: unknown;
  if (['Read', 'read_file', 'functions.read_file'].includes(event.name)) {
    target = event.args.file_path ?? event.args.path;
  } else if (['Bash', 'exec_command', 'functions.exec_command'].includes(event.name)) {
    if (event.args.run_in_background === true) return null;
    target = literalSkillRead(event.args.command ?? event.args.cmd);
  }
  if (typeof target !== 'string' || path.basename(target) !== 'SKILL.md') return null;
  const identity = resolveDefinition(target);
  return identity ? { identity, evidence: 'read' } : null;
}

/** Counters retain failed/unknown attempts and never estimate actual application. */
export function summarizeSkills(observations: Iterable<SkillObservation>): SkillSummary {
  const summary: SkillSummary = { observedDistinct: 0, invocationAttempts: 0, invocationSucceeded: 0,
    invocationFailed: 0, invocationPending: 0, invocationUnknown: 0, readSucceeded: 0,
    readFailed: 0, readPending: 0, readUnknown: 0, totalActual: null };
  const keys = new Set<string>();
  for (const item of observations) {
    keys.add(item.skillKey);
    if (item.evidence === 'invocation') summary.invocationAttempts++;
    const suffix = item.outcome[0].toUpperCase() + item.outcome.slice(1);
    const key = `${item.evidence}${suffix}` as Exclude<keyof SkillSummary, 'totalActual'>;
    summary[key]++;
  }
  summary.observedDistinct = keys.size;
  return summary;
}
