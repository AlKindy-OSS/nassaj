/**
 * ADR-216 §3.4 — the owner's "repair release-branch link".
 *
 * A node booted from a detached release tag offers (via /health
 * `sourceAttachOffered`) to re-attach the source tree to the release branch.
 * Flow: GET /api/system/update/source-attach (eligibility + `headCommit`)
 *     → POST with `{ expectedHead }` → 202 `{ operationId }`
 *     → poll GET /operations/:id every ≥2 s until succeeded | refused | failed.
 * A success queues a safe restart the owner confirms on the command board;
 * `/health.restartPending` then reports the attached-but-not-restarted state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../utils/api';

import { normalizeOpenTerminals, type OpenTerminals } from './updateJobClient';

export const SOURCE_ATTACH_BASE = '/api/system/update/source-attach';
/** The server limits polls to 60/min; 2 s keeps well inside it. */
export const SOURCE_ATTACH_POLL_MS = 2_000;
const RATE_LIMITED_POLL_MS = 10_000;

export type SourceAttachStep = 'inspect' | 'quiescence' | 'prove' | 'lease' | 'recheck' | 'apply';

export interface SourceAttachOperation {
  operationId: string;
  state: 'running' | 'succeeded' | 'refused' | 'failed';
  code: string | null;
  step: string | null;
  restartActionId: string | null;
  restartCode: string | null;
  restartReused: boolean | null;
  openTerminals: OpenTerminals | null;
}

export interface SourceAttachInfo {
  eligible: boolean;
  reason: string | null;
  version: string | null;
  tag: string | null;
  headCommit: string | null;
}

/**
 * - `loading`: reading eligibility. `ready`: the button is offered.
 * - `ineligible`: the server says not now (`info.reason`).
 * - `submitting` / `running`: request in flight / operation polling.
 * - `succeeded` | `refused` | `failed`: terminal operation (`operation`).
 * - `restartPending`: attached already, the safe restart is still to run.
 * - `error`: a request was refused before any operation existed (`error`).
 */
export type SourceAttachPhase = 'loading' | 'ready' | 'ineligible' | 'submitting' | 'running'
  | 'succeeded' | 'refused' | 'failed' | 'restartPending' | 'error';

export interface SourceAttachState {
  phase: SourceAttachPhase;
  info: SourceAttachInfo | null;
  operation: SourceAttachOperation | null;
  error: string | null;
}

const OPERATION_STATES = new Set(['running', 'succeeded', 'refused', 'failed']);
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** Validate an operation body; never trust the response as-is. */
export function normalizeSourceAttachOperation(value: unknown): SourceAttachOperation | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const operationId = text(raw.operationId);
  if (!operationId || !OPERATION_STATES.has(raw.state as string)) return null;
  return {
    operationId,
    state: raw.state as SourceAttachOperation['state'],
    code: text(raw.code),
    step: text(raw.step),
    restartActionId: text(raw.restartActionId),
    restartCode: text(raw.restartCode),
    restartReused: typeof raw.restartReused === 'boolean' ? raw.restartReused : null,
    openTerminals: normalizeOpenTerminals(raw.openTerminals),
  };
}

function normalizeInfo(raw: Record<string, unknown>): SourceAttachInfo {
  return {
    eligible: raw.eligible === true,
    reason: text(raw.reason),
    version: text(raw.version),
    tag: text(raw.tag),
    headCommit: text(raw.headCommit),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

/** Code for a refused request: the server's own, else one derived from HTTP. */
function refusalCode(status: number, body: Record<string, unknown>): string {
  if (status === 429) return 'rate_limited';
  return text(body.code) ?? (status === 401 || status === 403 ? 'forbidden' : 'unknown');
}

/**
 * Drive the repair for the open dialog. `enabled` is the owner seeing a
 * `/health` that offers it (or reports a pending restart);
 * `restartPendingAtBoot` (that /health flag) is the fallback when GET fails.
 */
export function useSourceAttach(enabled: boolean, restartPendingAtBoot: boolean) {
  const [state, setState] = useState<SourceAttachState>({ phase: 'loading', info: null, operation: null, error: null });
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFallback = useRef(restartPendingAtBoot);
  pendingFallback.current = restartPendingAtBoot;

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback((operationId: string, request: number) => {
    const tick = async () => {
      let delay = SOURCE_ATTACH_POLL_MS;
      try {
        const response = await authenticatedFetch(`${SOURCE_ATTACH_BASE}/operations/${encodeURIComponent(operationId)}`);
        if (epoch.current !== request) return;
        const body = await readJson(response);
        if (epoch.current !== request) return;
        if (response.status === 429) delay = RATE_LIMITED_POLL_MS;
        else if (!response.ok) {
          setState(prev => ({ ...prev, phase: 'error', error: refusalCode(response.status, body) }));
          return;
        } else {
          const operation = normalizeSourceAttachOperation(body);
          if (operation) {
            setState(prev => ({ ...prev, phase: operation.state, operation, error: null }));
            if (operation.state !== 'running') return;
          }
        }
      } catch {
        if (epoch.current !== request) return;
      }
      timer.current = setTimeout(() => { void tick(); }, delay);
    };
    stopPolling();
    timer.current = setTimeout(() => { void tick(); }, SOURCE_ATTACH_POLL_MS);
  }, [stopPolling]);

  const load = useCallback(async () => {
    stopPolling();
    const request = ++epoch.current;
    inFlight.current = false;
    setState({ phase: 'loading', info: null, operation: null, error: null });
    try {
      const response = await authenticatedFetch(SOURCE_ATTACH_BASE);
      const body = await readJson(response);
      if (epoch.current !== request) return;
      if (!response.ok) {
        const error = refusalCode(response.status, body);
        setState(prev => ({ ...prev, phase: pendingFallback.current ? 'restartPending' : 'error', error }));
        return;
      }
      const info = normalizeInfo(body);
      const operation = normalizeSourceAttachOperation(body.operation);
      if (operation?.state === 'running') {
        setState({ phase: 'running', info, operation, error: null });
        poll(operation.operationId, request);
        return;
      }
      if (body.restartPending === true) { setState({ phase: 'restartPending', info, operation, error: null }); return; }
      setState({ phase: info.eligible ? 'ready' : 'ineligible', info, operation: null, error: null });
    } catch {
      if (epoch.current !== request) return;
      setState(prev => ({ ...prev, phase: pendingFallback.current ? 'restartPending' : 'error', error: 'network' }));
    }
  }, [poll, stopPolling]);

  const start = useCallback(async () => {
    const expectedHead = state.info?.headCommit;
    if (inFlight.current || !expectedHead || state.phase !== 'ready') return;
    inFlight.current = true;
    const request = epoch.current;
    setState(prev => ({ ...prev, phase: 'submitting', error: null }));
    try {
      const response = await authenticatedFetch(SOURCE_ATTACH_BASE, {
        method: 'POST', body: JSON.stringify({ expectedHead }),
      });
      const body = await readJson(response);
      if (epoch.current !== request) return;
      const operationId = text(body.operationId);
      if (response.status === 202 && operationId) {
        setState(prev => ({ ...prev, phase: 'running', operation: null }));
        poll(operationId, request);
        return;
      }
      if (response.status === 409 && body.code === 'already_attached' && body.restartPending === true) {
        setState(prev => ({ ...prev, phase: 'restartPending' }));
        return;
      }
      setState(prev => ({ ...prev, phase: 'error', error: refusalCode(response.status, body) }));
    } catch {
      if (epoch.current === request) setState(prev => ({ ...prev, phase: 'error', error: 'network' }));
    } finally {
      if (epoch.current === request) inFlight.current = false;
    }
  }, [poll, state.info?.headCommit, state.phase]);

  useEffect(() => {
    if (!enabled) { epoch.current += 1; stopPolling(); return undefined; }
    void load();
    return () => { epoch.current += 1; stopPolling(); };
  }, [enabled, load, stopPolling]);

  return { state, start, reload: load };
}
