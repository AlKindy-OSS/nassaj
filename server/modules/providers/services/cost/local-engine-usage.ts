/**
 * Local-engine accounting (T-2103, ADR-227): a turn served by the member's own
 * model server is never booked against a cloud vendor's spend or usage.
 *
 * The signal is the session's engine pin (`local:<serverId>:<ownerId>:<digest>`),
 * the same for the Claude, Codex and DSH bodies — never the body name, and never
 * the model name, since a local server may serve a model under a cloud vendor's
 * name. A local session's models are relabelled into the reserved local
 * namespace, where pricing is zero (`cost-calculator`) and the vendor is the
 * neutral `local` bucket (`model-vendor`), so every ledger downstream follows.
 *
 * The label carries no server id or digest: model labels reach the client, and
 * the pin's components must not (ADR-227 Decision 10).
 */

import { sessionsDb } from '@/modules/database/index.js';
import {
  isLocalEngineValue,
  isLocalModelId,
  LOCAL_MODEL_PROVIDER_PREFIX,
} from '@/services/isolation/local-engine-pin.js';

import type { SessionUsage } from './usage-extractors.js';

/** Carrier prefix of a model served by a local engine, inside the reserved namespace. */
export const LOCAL_USAGE_CARRIER = `${LOCAL_MODEL_PROVIDER_PREFIX}engine`;

/** The local label of a model; a label already in the local namespace is kept. */
export function localUsageLabel(model: string): string {
  return isLocalModelId(model) ? model : `${LOCAL_USAGE_CARRIER}/${model}`;
}

/**
 * True when any of the given sessions is pinned to a local engine. Several ids
 * cover a Codex child thread, which has no row of its own and runs on its
 * parent's engine. An unreadable database answers false (not local).
 */
export function isLocalPinnedSession(...sessionIds: Array<string | null | undefined>): boolean {
  try {
    return sessionIds.some((id) => Boolean(id) && isLocalEngineValue(sessionsDb.getSessionEnginePin(id!)?.engine));
  } catch {
    return false;
  }
}

/** Moves a local session's usage into the local namespace; other usage is returned as is. */
export function localizeSessionUsage(usage: SessionUsage, local: boolean): SessionUsage {
  if (!local) return usage;
  return {
    ...usage,
    perModel: usage.perModel.map((row) => ({ ...row, model: localUsageLabel(row.model) })),
    ...(usage.requests
      ? { requests: usage.requests.map((row) => ({ ...row, model: localUsageLabel(row.model) })) }
      : {}),
  };
}
