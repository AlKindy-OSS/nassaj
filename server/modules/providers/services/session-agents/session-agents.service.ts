/**
 * ADR-218: the process-wide session agents registry and its egress.
 *
 * Fed by the live Claude stream (claude-sdk.js, one hook per event plus the
 * run's exit), lazily rebuilt from the transcript on the first read of a
 * session, and served as a full snapshot over REST and the `session-agents`
 * WS frame (debounced, delivered only to the session's visibility-checked
 * mirrors, never through the replay ring). External seams — mirror delivery,
 * run liveness, workflow reads — are injected at the composition root so this
 * module never imports the websocket graph.
 */

import { sessionsDb } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210: display masking is a leaf service shared by every viewer egress.
import { maskDisplayLabel } from '@/services/display-secret-mask.js';

import { observeClaudeAgentEvent } from './claude-agent-events.js';
import { SessionAgentRegistry, type AgentRow, type PublicAgentRow, type RunToken } from './registry.js';
import { reconstructClaudeSessionAgents } from './transcript-boot.js';

export const SESSION_AGENTS_FRAME = 'session-agents';
const DEBOUNCE_MS = 500;
const WORKFLOW_POLL_MS = 8000;
const LABEL_MAX = 80;
const BOOT_CACHE_MAX = 500;

export type SessionAgentsSnapshot = { supported: boolean; agents: PublicAgentRow[] };

export type SessionAgentsDependencies = {
  /** Sends a serialized frame to every live mirror of the session; returns how many got it. */
  deliver: (sessionId: string, serialized: string) => number;
  /** Live mirrors of the session (no frame is built for a session nobody watches). */
  countMirrors: (sessionId: string) => number;
  /** True while a run of the session is alive. */
  isRunLive: (sessionId: string) => boolean;
  /** Agent rows of the session's workflows (read-only adapter). */
  readWorkflowAgents: (sessionId: string) => Promise<PublicAgentRow[]>;
  /** Rows rebuilt from the recorded transcript. */
  reconstruct: (sessionId: string) => Promise<AgentRow[]>;
  /** Provider of a session, or null when unknown. */
  providerOf: (sessionId: string) => string | null;
  now: () => number;
  debounceMs: number;
  workflowPollMs: number;
};

const defaults: SessionAgentsDependencies = {
  deliver: () => 0,
  countMirrors: () => 0,
  isRunLive: () => false,
  readWorkflowAgents: async () => [],
  reconstruct: (sessionId) => reconstructClaudeSessionAgents(sessionId, { isRunLive: (id) => deps.isRunLive(id) }),
  providerOf: (sessionId) => {
    try {
      return sessionsDb.getSessionById(sessionId)?.provider ?? null;
    } catch {
      return null;
    }
  },
  now: Date.now,
  debounceMs: DEBOUNCE_MS,
  workflowPollMs: WORKFLOW_POLL_MS,
};

let deps: SessionAgentsDependencies = { ...defaults };
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const boots = new Map<string, Promise<void>>();
let registry = createRegistry();

function createRegistry(): SessionAgentRegistry {
  return new SessionAgentRegistry({ now: () => deps.now(), onChange: (sessionId) => scheduleBroadcast(sessionId) });
}

/** Composition root seam (server/index.js); tests also reset through it. */
export function configureSessionAgents(overrides: Partial<SessionAgentsDependencies>): void {
  deps = { ...deps, ...overrides };
}

/** Test seam: fresh registry, caches and dependencies. */
export function resetSessionAgentsForTests(overrides: Partial<SessionAgentsDependencies> = {}): SessionAgentRegistry {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  boots.clear();
  deps = { ...defaults, ...overrides };
  registry = createRegistry();
  return registry;
}

/** Live hook: one raw SDK event of a Claude run. Never throws. */
export function observeClaudeRunEvent(sessionId: string | null, raw: unknown, runToken: RunToken): void {
  try {
    observeClaudeAgentEvent(registry, sessionId, raw, { accuracy: 'live', runToken, now: deps.now });
  } catch {
    /* the agents view must never break a run */
  }
}

/**
 * Live hook at the run's exit (paired with removeSession(sid, runToken)): rows
 * that run drove become `unknown`; once no run of the session is alive, rows
 * no run claimed follow. Rows of a newer run keep their state.
 */
export function claudeRunExited(sessionId: string | null, runToken: RunToken): void {
  if (!sessionId) return;
  try {
    registry.runExited(sessionId, runToken, deps.now());
    if (!deps.isRunLive(sessionId)) registry.settleUnowned(sessionId, deps.now());
  } catch {
    /* never break the run's teardown */
  }
}

/**
 * ADR-219 م-3: true when `value` is a known agent id of the session (live or
 * rebuilt rows). Never throws; an error reads as "unknown" (the caller then
 * falls back to the agentId-shape rule).
 */
export function hasSessionAgent(sessionId: string, value: string): boolean {
  try {
    return registry.rows(sessionId).some((row) => row.key === value || row.agentId === value);
  } catch {
    return false;
  }
}

/** Rebuilds a session from its transcript once per process (bounded cache). */
function ensureBooted(sessionId: string): Promise<void> {
  let boot = boots.get(sessionId);
  if (boot) return boot;
  if (boots.size >= BOOT_CACHE_MAX) boots.delete(boots.keys().next().value as string);
  boot = deps.reconstruct(sessionId)
    .then((rows) => registry.adopt(sessionId, rows))
    .catch(() => undefined);
  boots.set(sessionId, boot);
  return boot;
}

/**
 * Full snapshot of a session's agents: running first, then most recent.
 * Callers authorize first (REST read gate, or a gated mirror).
 */
export async function getSessionAgentsSnapshot(sessionId: string): Promise<SessionAgentsSnapshot> {
  if (deps.providerOf(sessionId) !== 'claude') return { supported: false, agents: [] };
  await ensureBooted(sessionId);
  const workflows = await deps.readWorkflowAgents(sessionId).catch(() => []);
  const agents = [...registry.list(sessionId), ...workflows].map(sanitizeRow).sort(byRelevance);
  return { supported: true, agents };
}

/** The `session-agents` frame for a session. */
export async function buildSessionAgentsFrame(sessionId: string): Promise<Record<string, unknown>> {
  const snapshot = await getSessionAgentsSnapshot(sessionId);
  return { type: SESSION_AGENTS_FRAME, sessionId, ...snapshot };
}

/**
 * Unicast snapshot for one viewer (check-session-status, after its visibility
 * check). Also triggers the lazy boot for a session first opened by a mirror.
 */
export async function sendSessionAgentsSnapshot(sessionId: string, send: (frame: unknown) => void): Promise<void> {
  try {
    const frame = await buildSessionAgentsFrame(sessionId);
    if (!frame.supported) return;
    send(frame);
    pollWorkflowsIfRunning(sessionId, frame.agents as PublicAgentRow[]);
  } catch {
    /* a missing snapshot is recovered by the next change or the REST read */
  }
}

/** Debounced full-snapshot broadcast to the session's mirrors. */
export function scheduleBroadcast(sessionId: string, delayMs = deps.debounceMs): void {
  if (!sessionId || timers.has(sessionId)) return;
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    void broadcast(sessionId);
  }, delayMs);
  timer.unref?.();
  timers.set(sessionId, timer);
}

async function broadcast(sessionId: string): Promise<void> {
  try {
    if (deps.countMirrors(sessionId) === 0) return;
    const frame = await buildSessionAgentsFrame(sessionId);
    deps.deliver(sessionId, JSON.stringify(frame));
    if (frame.supported) pollWorkflowsIfRunning(sessionId, frame.agents as PublicAgentRow[]);
  } catch {
    /* the next change re-broadcasts */
  }
}

/** Workflow agents change without a Claude event; re-snapshot while one runs and someone watches. */
function pollWorkflowsIfRunning(sessionId: string, agents: readonly PublicAgentRow[]): void {
  if (agents.some((row) => row.source === 'workflow' && row.state === 'running') && deps.countMirrors(sessionId) > 0) {
    scheduleBroadcast(sessionId, deps.workflowPollMs);
  }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/** Display text: control characters out, whitespace collapsed, masked, ≤ {@link LABEL_MAX}. */
export function sanitizeLabel(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = maskDisplayLabel(value.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim());
  return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX - 1)}…` : clean;
}

function sanitizeRow(row: PublicAgentRow): PublicAgentRow {
  const out: PublicAgentRow = { ...row, label: sanitizeLabel(row.label) ?? '' };
  for (const field of ['agentType', 'model', 'effort'] as const) {
    const value = sanitizeLabel(row[field]);
    if (value) out[field] = value;
    else delete out[field];
  }
  return out;
}

function byRelevance(a: PublicAgentRow, b: PublicAgentRow): number {
  const live = Number(b.state === 'running') - Number(a.state === 'running');
  if (live !== 0) return live;
  const accurate = Number(b.accuracy === 'live') - Number(a.accuracy === 'live');
  return accurate !== 0 ? accurate : b.lastEventAt - a.lastEventAt;
}
