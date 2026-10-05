/**
 * useRawExecutionRecord — durable «this exact command already ran» record.
 *
 * The server keeps the latest execution per command digest (see the ledger in
 * server/services/command-board-raw.js), so the answer survives a refresh and is
 * the same whether the run started from the chat fence or from the board. The
 * fence re-reads it whenever the shared raw snapshot refreshes, which the WS
 * signal 'pending-actions-updated' already drives for both surfaces.
 */

import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import { subscribeRawExecConfig } from './useRawExecConfig';

const LOOKUP_URL = '/api/system/command-board-raw/executions/lookup';

export type RawExecutionRecord = {
  executedAt: string;
  outcome: 'success' | 'failure' | 'unknown';
  exitCode: number | null;
  executedBy: string | null;
};

/** Fail-closed parse: anything not shaped like a record is «never ran». */
export function parseExecutionRecord(value: unknown): RawExecutionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.executedAt !== 'string' || Number.isNaN(Date.parse(v.executedAt))) return null;
  if (v.outcome !== 'success' && v.outcome !== 'failure' && v.outcome !== 'unknown') return null;
  return {
    executedAt: v.executedAt,
    outcome: v.outcome,
    exitCode: typeof v.exitCode === 'number' && Number.isSafeInteger(v.exitCode) ? v.exitCode : null,
    executedBy: typeof v.executedBy === 'string' ? v.executedBy : null,
  };
}

/**
 * Does this execution belong to the block's own message? The ledger is keyed by
 * command text, so a LATER message repeating the command must not inherit an
 * earlier run. 'unknown' = no usable message time: the caller keeps the button.
 */
export function recordAppliesToMessage(
  record: RawExecutionRecord | null,
  messageTimestamp: string | number | Date | null | undefined,
): 'applies' | 'older' | 'unknown' {
  if (!record) return 'unknown';
  const sent = messageTimestamp == null ? Number.NaN : new Date(messageTimestamp).getTime();
  if (!Number.isFinite(sent)) return 'unknown';
  return Date.parse(record.executedAt) >= sent ? 'applies' : 'older';
}

/** The button retires only for a run that finished cleanly; a failure stays retryable. */
export function isExecutionDone(record: RawExecutionRecord | null): boolean {
  return record?.outcome === 'success';
}

export function useRawExecutionRecord(
  command: string,
  enabled: boolean,
): { record: RawExecutionRecord | null; refresh: () => void } {
  const [record, setRecord] = useState<RawExecutionRecord | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeRawExecConfig(refresh);
  }, [enabled, refresh]);

  useEffect(() => {
    const cmd = command.trim();
    if (!enabled || !cmd) {
      setRecord(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await (
          authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
        )(LOOKUP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd }),
        });
        const data = res.ok ? ((await res.json().catch(() => ({}))) as { execution?: unknown }) : {};
        if (!cancelled) setRecord(parseExecutionRecord(data.execution));
      } catch {
        if (!cancelled) setRecord(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [command, enabled, tick]);

  return { record, refresh };
}
