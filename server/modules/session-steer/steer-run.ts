/**
 * Run-owned steer queue (T-1903 / ADR-190). Lives on the run object, OUTSIDE
 * the prompt generator: the generator only `take()`s from it, the websocket
 * layer only `enqueue()`s into it, and the input-close logic asks
 * `hasPendingWork()` before it may close stdin.
 *
 * Life of an item: queued → (yielded) in flight → settled by the next `result`
 * → delivery confirmed from the transcript (delivered | unconfirmed).
 * Closing the input (run end, grace expiry) or aborting rejects what is still
 * queued; after close every enqueue answers turn_not_active.
 */

import type { SteerDeliveryStatus, SteerEvent, SteerRejectCode } from '../../../shared/session-steer.contract.js';

export const STEER_QUEUE_MAX = 3;
export const STEER_PER_TURN_MAX = 10;

export type SteerItem = {
  clientMsgId: string;
  senderUserId: number;
  senderName: string;
  text: string;
  wrapped: string;
  uuid: string;
};

export type SteerRunDeps = {
  sessionId: () => string | null;
  turnId: string;
  starterUserId: number | null;
  permissionMode: () => string | null;
  hooksArmed: () => boolean;
  /** Called after every accepted enqueue (the runner re-arms its input-close timer). */
  onQueued?: (item: SteerItem) => void;
  /** Broadcast to the starter and every mirror of the session. */
  broadcast: (event: SteerEvent) => void;
  persistStatus: (item: SteerItem, status: SteerDeliveryStatus) => void;
  /** Resolves true once the uuid is found in the transcript. */
  confirmDelivery: (item: SteerItem) => Promise<boolean>;
};

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

export type RunUsageAggregate = { results: number; totalCostUsd: number | null; usage: Usage };

export type EnqueueResult = { ok: true } | { ok: false; code: SteerRejectCode };

/** Creates the steer controller for one Claude run. */
export function createSteerRun(deps: SteerRunDeps) {
  const queue: SteerItem[] = [];
  const inFlight: SteerItem[] = [];
  const byUuid = new Map<string, SteerItem>();
  let waiter: ((item: SteerItem | null) => void) | null = null;
  let closedReason: SteerRejectCode | null = null;
  let accepted = 0;
  let tainted = false;
  const aggregate: RunUsageAggregate = { results: 0, totalCostUsd: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };

  const event = (type: SteerEvent['type'], item: SteerItem, deliveryStatus: SteerDeliveryStatus,
    extra: Partial<SteerEvent> = {}): SteerEvent => ({
    type, sessionId: deps.sessionId() ?? '', turnId: deps.turnId, clientMsgId: item.clientMsgId,
    sender: { userId: item.senderUserId, displayName: item.senderName },
    starterUserId: deps.starterUserId, deliveryStatus, ...extra,
  });

  const settle = (item: SteerItem, status: SteerDeliveryStatus, type: SteerEvent['type'], reason?: SteerRejectCode) => {
    try { deps.persistStatus(item, status); } catch { /* the event still reaches the members */ }
    deps.broadcast(event(type, item, status, reason ? { reason } : {}));
  };

  const confirm = (item: SteerItem) => {
    deps.confirmDelivery(item).then(found => found, () => false).then((found) => {
      settle(item, found ? 'delivered' : 'unconfirmed', 'steer-delivered');
    });
  };

  return {
    turnId: deps.turnId,
    starterUserId: deps.starterUserId,
    /** True from the first accepted injection until the run ends. */
    isTainted: () => tainted,
    everInjected: () => accepted > 0,
    isClosed: () => closedReason !== null,
    hasPendingWork: () => queue.length > 0 || inFlight.length > 0,
    hooksArmed: () => deps.hooksArmed(),
    permissionMode: () => deps.permissionMode(),
    /** The accepted item that carries this native uuid (live echo attribution). */
    findByUuid: (uuid: unknown): SteerItem | null => (typeof uuid === 'string' ? byUuid.get(uuid) ?? null : null),
    usage: (): RunUsageAggregate => ({ ...aggregate, usage: { ...aggregate.usage } }),

    /** Turn liveness and queue bounds, without side effects. */
    precheck(): SteerRejectCode | null {
      if (closedReason !== null) return closedReason;
      if (accepted >= STEER_PER_TURN_MAX) return 'steer_turn_limit';
      if (queue.length >= STEER_QUEUE_MAX) return 'steer_queue_full';
      return null;
    },

    /** Queues one authorized item; re-checks the bounds itself. */
    enqueue(item: SteerItem): EnqueueResult {
      const refused = this.precheck();
      if (refused) return { ok: false, code: refused };
      accepted += 1;
      tainted = true;
      byUuid.set(item.uuid, item);
      deps.broadcast(event('steer-queued', item, 'queued', { text: item.text }));
      if (waiter) {
        const wake = waiter; waiter = null;
        inFlight.push(item);
        wake(item);
      } else {
        queue.push(item);
      }
      deps.onQueued?.(item);
      return { ok: true };
    },

    /** Generator side: next queued item, or null once the input is closed. */
    take(): Promise<SteerItem | null> {
      const next = queue.shift();
      if (next) { inFlight.push(next); return Promise.resolve(next); }
      if (closedReason !== null) return Promise.resolve(null);
      return new Promise(resolve => { waiter = resolve; });
    },

    /** A `result` settles everything yielded before it and folds its usage in. */
    onResult(message: Record<string, any>) {
      aggregate.results += 1;
      const usage = message?.usage ?? {};
      for (const key of Object.keys(aggregate.usage) as Array<keyof Usage>) {
        if (Number.isFinite(usage[key])) aggregate.usage[key] += usage[key];
      }
      // total_cost_usd is cumulative across results of one CLI process (measured by
      // scripts/smoke/steer-taint-precedence.smoke.mjs): keep the largest, never sum.
      if (Number.isFinite(message?.total_cost_usd)) {
        aggregate.totalCostUsd = Math.max(aggregate.totalCostUsd ?? 0, message.total_cost_usd);
      }
      for (const item of inFlight.splice(0)) confirm(item);
    },

    /** Input closed or run aborted: nothing more may be delivered. */
    close(reason: 'input_closed' | 'turn_aborted') {
      if (closedReason !== null) return;
      closedReason = reason === 'turn_aborted' ? 'turn_aborted' : 'turn_not_active';
      const code = closedReason;
      for (const item of queue.splice(0)) settle(item, 'rejected', 'steer-rejected', code);
      if (reason === 'turn_aborted') {
        for (const item of inFlight.splice(0)) settle(item, 'unconfirmed', 'steer-rejected', code);
      } else {
        for (const item of inFlight.splice(0)) confirm(item);
      }
      if (waiter) { const wake = waiter; waiter = null; wake(null); }
    },
  };
}

export type SteerRun = ReturnType<typeof createSteerRun>;
