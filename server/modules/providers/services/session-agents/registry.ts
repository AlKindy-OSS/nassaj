/**
 * ADR-218: in-memory source of truth for "the agents of session S".
 *
 * One row per agent, keyed by its agent id (the CLI's `task_id`, also the
 * `<task-id>` of every notification, including after a SendMessage resume).
 * Until the agent id is known (an `Agent` tool_use precedes its task_started)
 * the row is keyed `tool:<tool_use_id>` and re-keyed on binding. Every
 * tool_use id that drove the agent (the delegation, each resuming SendMessage)
 * is kept for joining with stream rows.
 *
 * Bounded: rows per session, sessions overall (oldest non-live first), and
 * ended rows age out. Running rows never age out: only a structured end or the
 * exit of the run that drives them (`runExited`) changes them.
 */

export type AgentSource = 'claude-subagent' | 'workflow';
export type AgentState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
export type AgentAccuracy = 'live' | 'reconstructed';
export type RunToken = symbol | string;

export type AgentRow = {
  key: string;
  sessionId: string;
  source: AgentSource;
  agentId?: string;
  toolUseIds: string[];
  label: string;
  agentType?: string;
  model?: string;
  effort?: string;
  background: boolean;
  state: AgentState;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  lastEventAt: number;
  accuracy: AgentAccuracy;
  /** Run that last drove the row; internal, never serialized. */
  runToken?: RunToken;
};

export type PublicAgentRow = Omit<AgentRow, 'runToken'>;

/** Identifies a row: the agent id first, a tool_use id second. */
export type AgentRef = { agentId?: string | null; toolUseId?: string | null };

export type AgentDetails = {
  label?: string | null;
  agentType?: string | null;
  model?: string | null;
  effort?: string | null;
};

export type AgentEventContext = { at: number; accuracy: AgentAccuracy; runToken?: RunToken | null };

export type AgentStart = AgentRef & AgentDetails & { background?: boolean };

export type RegistryOptions = {
  maxRowsPerSession?: number;
  maxSessions?: number;
  endedTtlMs?: number;
  now?: () => number;
  onChange?: (sessionId: string) => void;
};

type Bucket = { rows: Map<string, AgentRow>; byToolUse: Map<string, string>; touchedAt: number };

const MAX_TOOL_USE_IDS = 20;

/** True when the row can no longer change by itself (anything but running). */
const isSettled = (row: AgentRow): boolean => row.state !== 'running';
const settledAt = (row: AgentRow): number => row.endedAt ?? row.lastEventAt;

export class SessionAgentRegistry {
  private readonly sessions = new Map<string, Bucket>();
  private readonly maxRows: number;
  private readonly maxSessions: number;
  private readonly endedTtlMs: number;
  private readonly now: () => number;
  private readonly onChange: (sessionId: string) => void;

  constructor(options: RegistryOptions = {}) {
    this.maxRows = options.maxRowsPerSession ?? 200;
    this.maxSessions = options.maxSessions ?? 500;
    this.endedTtlMs = options.endedTtlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => undefined);
  }

  /** Opens (or completes) a row; an already settled row only gains details. */
  start(sessionId: string, start: AgentStart, ctx: AgentEventContext): void {
    const bucket = this.bucket(sessionId, true)!;
    let row = this.find(bucket, start);
    if (row && start.agentId) row = this.rekey(bucket, row, start.agentId);
    if (!row) {
      const key = start.agentId ?? (start.toolUseId ? `tool:${start.toolUseId}` : null);
      if (!key) return;
      row = this.insert(bucket, { key, sessionId, source: 'claude-subagent', toolUseIds: [], label: '',
        background: false, state: 'running', startedAt: ctx.at, lastEventAt: ctx.at, accuracy: ctx.accuracy,
        ...(start.agentId ? { agentId: start.agentId } : {}) });
    }
    this.addToolUseId(bucket, row, start.toolUseId);
    fillDetails(row, start);
    if (start.background) row.background = true;
    if (!isSettled(row)) this.drive(row, ctx);
    this.changed(sessionId, bucket);
  }

  /** Binds a provisional `tool:<id>` row to its agent id (merging a row already keyed by it). */
  bind(sessionId: string, toolUseId: string, agentId: string, ctx: AgentEventContext): void {
    const bucket = this.bucket(sessionId, false);
    const row = bucket ? this.find(bucket, { toolUseId }) : undefined;
    if (!bucket || !row || row.key === agentId) return;
    this.rekey(bucket, row, agentId);
    row.lastEventAt = Math.max(row.lastEventAt, ctx.at);
    this.changed(sessionId, bucket);
  }

  /** Adds details (resolved model, label) without touching the state. */
  update(sessionId: string, ref: AgentRef, details: AgentDetails): void {
    const bucket = this.bucket(sessionId, false);
    const row = bucket ? this.find(bucket, ref) : undefined;
    if (!bucket || !row) return;
    if (details.model && row.model !== details.model) {
      row.model = details.model;
      this.changed(sessionId, bucket);
    }
  }

  /** Marks the agent as running in the background: a later delegation result no longer ends it. */
  markBackgrounded(sessionId: string, ref: AgentRef): void {
    const bucket = this.bucket(sessionId, false);
    const row = bucket ? this.find(bucket, ref) : undefined;
    if (!bucket || !row || row.background) return;
    row.background = true;
    this.changed(sessionId, bucket);
  }

  /** A SendMessage resumed the agent: running again under the run that resumed it. */
  resume(sessionId: string, agentId: string, toolUseId: string | null, ctx: AgentEventContext): void {
    const bucket = this.bucket(sessionId, true)!;
    let row = this.find(bucket, { agentId });
    if (!row) {
      row = this.insert(bucket, { key: agentId, sessionId, source: 'claude-subagent', agentId, toolUseIds: [],
        label: '', background: true, state: 'running', startedAt: ctx.at, lastEventAt: ctx.at,
        accuracy: ctx.accuracy });
    }
    this.addToolUseId(bucket, row, toolUseId);
    row.background = true;
    row.state = 'running';
    delete row.endedAt;
    this.drive(row, ctx);
    this.changed(sessionId, bucket);
  }

  /** A structured end. Only a running (or unknown) row ends; the first terminal state wins. */
  end(sessionId: string, ref: AgentRef, state: Exclude<AgentState, 'running'>, ctx: AgentEventContext): void {
    const bucket = this.bucket(sessionId, false);
    const row = bucket ? this.find(bucket, ref) : undefined;
    if (!bucket || !row || (row.state !== 'running' && row.state !== 'unknown')) return;
    row.state = state;
    row.endedAt = ctx.at;
    row.lastEventAt = Math.max(row.lastEventAt, ctx.at);
    if (ctx.accuracy === 'live') row.accuracy = 'live';
    this.changed(sessionId, bucket);
  }

  /** The delegation's own tool_result ends a foreground agent, never a backgrounded one. */
  endForeground(sessionId: string, toolUseId: string, state: 'done' | 'failed', ctx: AgentEventContext): void {
    const bucket = this.bucket(sessionId, false);
    const row = bucket ? this.find(bucket, { toolUseId }) : undefined;
    if (!row || row.background) return;
    this.end(sessionId, { agentId: row.key, toolUseId }, state, ctx);
  }

  /** The run's CLI exited: rows it still drove are no longer known to be running. */
  runExited(sessionId: string, runToken: RunToken, at: number): void {
    const bucket = this.bucket(sessionId, false);
    if (!bucket) return;
    let changed = false;
    for (const row of bucket.rows.values()) {
      if (row.state !== 'running' || row.runToken !== runToken) continue;
      row.state = 'unknown';
      row.lastEventAt = Math.max(row.lastEventAt, at);
      changed = true;
    }
    if (changed) this.changed(sessionId, bucket);
  }

  /**
   * No run of the session is alive: running rows no run claimed (reconstructed
   * while a run was live) are no longer known to be running either.
   */
  settleUnowned(sessionId: string, at: number): void {
    const bucket = this.bucket(sessionId, false);
    if (!bucket) return;
    let changed = false;
    for (const row of bucket.rows.values()) {
      if (row.state !== 'running' || row.runToken !== undefined || row.source !== 'claude-subagent') continue;
      row.state = 'unknown';
      row.lastEventAt = Math.max(row.lastEventAt, at);
      changed = true;
    }
    if (changed) this.changed(sessionId, bucket);
  }

  /**
   * Merges reconstructed rows: a row the registry already holds (by key or by
   * a shared tool_use id) only gains missing details; live state always wins.
   */
  adopt(sessionId: string, rows: readonly AgentRow[]): void {
    if (rows.length === 0) return;
    const bucket = this.bucket(sessionId, true)!;
    for (const incoming of rows) {
      let row = bucket.rows.get(incoming.key)
        ?? incoming.toolUseIds.map((id) => this.find(bucket, { toolUseId: id })).find(Boolean);
      if (row && incoming.agentId) row = this.rekey(bucket, row, incoming.agentId);
      if (!row) {
        row = this.insert(bucket, { ...incoming, sessionId, toolUseIds: [], accuracy: 'reconstructed' });
        delete row.runToken;
      }
      incoming.toolUseIds.forEach((id) => this.addToolUseId(bucket, row!, id));
      fillDetails(row, incoming);
    }
    this.prune(bucket);
    this.changed(sessionId, bucket);
  }

  /** Rows of a session after ageing out ended ones; `runToken` stripped. */
  list(sessionId: string): PublicAgentRow[] {
    const bucket = this.bucket(sessionId, false);
    if (!bucket) return [];
    this.prune(bucket);
    if (bucket.rows.size === 0) this.sessions.delete(sessionId);
    return [...bucket.rows.values()].map(({ runToken: _runToken, ...row }) => ({ ...row, toolUseIds: [...row.toolUseIds] }));
  }

  /** Internal rows of a session (reconstruction reads its scratch registry with it). */
  rows(sessionId: string): AgentRow[] {
    return [...(this.sessions.get(sessionId)?.rows.values() ?? [])];
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private bucket(sessionId: string, create: boolean): Bucket | undefined {
    let bucket = this.sessions.get(sessionId);
    if (bucket) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, bucket);
      bucket.touchedAt = this.now();
      return bucket;
    }
    if (!create) return undefined;
    if (this.sessions.size >= this.maxSessions) this.evictSession();
    bucket = { rows: new Map(), byToolUse: new Map(), touchedAt: this.now() };
    this.sessions.set(sessionId, bucket);
    return bucket;
  }

  /** Drops the least recently touched session with no running row (or, failing that, the oldest). */
  private evictSession(): void {
    let victim: string | undefined;
    for (const [id, bucket] of this.sessions) {
      if (![...bucket.rows.values()].some((row) => row.state === 'running')) {
        victim = id;
        break;
      }
    }
    victim ??= this.sessions.keys().next().value;
    if (victim !== undefined) this.sessions.delete(victim);
  }

  private find(bucket: Bucket, ref: AgentRef): AgentRow | undefined {
    if (ref.agentId) {
      const row = bucket.rows.get(ref.agentId);
      if (row) return row;
    }
    const key = ref.toolUseId ? bucket.byToolUse.get(ref.toolUseId) : undefined;
    return key ? bucket.rows.get(key) : undefined;
  }

  private insert(bucket: Bucket, row: AgentRow): AgentRow {
    if (bucket.rows.size >= this.maxRows) this.evictRow(bucket);
    bucket.rows.set(row.key, row);
    return row;
  }

  /** Oldest settled row first; with none settled, the oldest row. */
  private evictRow(bucket: Bucket): void {
    const rows = [...bucket.rows.values()];
    const settled = rows.filter(isSettled).sort((a, b) => settledAt(a) - settledAt(b));
    const victim = settled[0] ?? rows.sort((a, b) => a.startedAt - b.startedAt)[0];
    if (victim) this.remove(bucket, victim);
  }

  private remove(bucket: Bucket, row: AgentRow): void {
    bucket.rows.delete(row.key);
    for (const id of row.toolUseIds) if (bucket.byToolUse.get(id) === row.key) bucket.byToolUse.delete(id);
  }

  /** Re-keys `row` to `agentId`, folding in a row already holding that key. */
  private rekey(bucket: Bucket, row: AgentRow, agentId: string): AgentRow {
    if (row.key === agentId) return row;
    const existing = bucket.rows.get(agentId);
    this.remove(bucket, row);
    if (existing) {
      row.toolUseIds.forEach((id) => this.addToolUseId(bucket, existing, id));
      fillDetails(existing, row);
      existing.background ||= row.background;
      existing.startedAt = Math.min(existing.startedAt, row.startedAt);
      return existing;
    }
    row.key = agentId;
    row.agentId = agentId;
    bucket.rows.set(agentId, row);
    row.toolUseIds.forEach((id) => bucket.byToolUse.set(id, agentId));
    return row;
  }

  private addToolUseId(bucket: Bucket, row: AgentRow, toolUseId: string | null | undefined): void {
    if (!toolUseId) return;
    bucket.byToolUse.set(toolUseId, row.key);
    if (row.toolUseIds.includes(toolUseId)) return;
    row.toolUseIds.push(toolUseId);
    if (row.toolUseIds.length > MAX_TOOL_USE_IDS) {
      const dropped = row.toolUseIds.splice(1, 1)[0];
      if (bucket.byToolUse.get(dropped) === row.key) bucket.byToolUse.delete(dropped);
    }
  }

  /** The run now driving a running row (live events promote a reconstructed row). */
  private drive(row: AgentRow, ctx: AgentEventContext): void {
    row.lastEventAt = Math.max(row.lastEventAt, ctx.at);
    if (ctx.runToken) row.runToken = ctx.runToken;
    if (ctx.accuracy === 'live') row.accuracy = 'live';
  }

  private prune(bucket: Bucket): void {
    const cutoff = this.now() - this.endedTtlMs;
    for (const row of [...bucket.rows.values()]) {
      if (isSettled(row) && settledAt(row) < cutoff) this.remove(bucket, row);
    }
  }

  private changed(sessionId: string, bucket: Bucket): void {
    if (bucket.rows.size === 0 && this.sessions.get(sessionId) === bucket) this.sessions.delete(sessionId);
    try {
      this.onChange(sessionId);
    } catch {
      /* a listener must never break the registry */
    }
  }
}

/** Fills only the details a row lacks; never overwrites a known value. */
function fillDetails(row: AgentRow, details: AgentDetails): void {
  if (!row.label && details.label) row.label = details.label;
  if (!row.agentType && details.agentType) row.agentType = details.agentType;
  if (!row.model && details.model) row.model = details.model;
  if (!row.effort && details.effort) row.effort = details.effort;
}
