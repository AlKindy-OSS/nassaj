/** Synthetic journal rows preserving representative liveness shapes. */
export const INCIDENT_WF_ID = 'wf_synthetic_partial';
export const COMPLETED_WF_ID = 'wf_synthetic_completed';

type JournalLine = Record<string, unknown>;
const key = (index: number): string => `synthetic-key-${String(index).padStart(2, '0')}`;
const agent = (index: number): string => `synthetic-agent-${String(index).padStart(2, '0')}`;
const started = (index: number, attempt = 1): JournalLine => ({
  type: 'started', key: key(index), agentId: `${agent(index)}-attempt-${attempt}`,
});
const result = (index: number, attempt = 1): JournalLine => ({
  type: 'result',
  key: key(index),
  agentId: `${agent(index)}-attempt-${attempt}`,
  result: { content: 'synthetic result' },
});

export const INCIDENT_JOURNAL_LINES: JournalLine[] = [
  ...Array.from({ length: 16 }, (_, index) => started(index + 1)),
  ...Array.from({ length: 15 }, (_, index) => result(index + 1)),
];

export const COMPLETED_JOURNAL_LINES: JournalLine[] = [
  ...Array.from({ length: 7 }, (_, index) => started(index + 1)),
  ...[1, 2, 3, 4].map((index) => started(index, 2)),
  ...[5, 6, 7].map((index) => result(index)),
  ...[1, 2, 3, 4].map((index) => result(index, 2)),
];

export function toJsonl(lines: JournalLine[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}
