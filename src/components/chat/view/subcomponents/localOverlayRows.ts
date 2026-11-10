/**
 * localOverlayRows.ts — the "local models · <server>" blocks under the Claude body
 * (ADR-227 Decision 10, T-2098 stage 3b). Pure and DOM-free.
 *
 * The rows come from GET /api/providers/claude/local-overlay, looped as data: no
 * runtime or vendor name is written here (ADR-194). Eligibility is the server's
 * static verdict; this module adds only the chat-pin rules the picker owes the
 * member before the spawn refuses:
 *
 *   - a local model starts only a NEW chat;
 *   - a chat pinned to a local server offers only that server's models;
 *   - a chat pinned elsewhere offers no local row ("start a new chat").
 *
 * The server never sends the composite pin (`local:<id>:…`); the chat's server is
 * read from its local model id (`<providerId>/<model>`), so no raw pin text can
 * reach a label.
 */

import { actionableEngineCells } from '../../../../../shared/bodyEngineMatrix';
import { LOCAL_ENGINE, isLocalModelId } from '../../../../../shared/localEngine';

import type { PickerRow } from './modelPickerRows';

/** The server's static verdict for one model (claude-local-overlay.js). */
export type LocalOverlayEligibility =
  | 'ok'
  | 'model_id_reserved'
  | 'context_unknown'
  | 'context_too_small'
  | 'base_url_unsupported'
  | 'tls_name_requires_relay'
  | 'address_untested';

export type LocalOverlayModel = {
  value: string;
  label: string;
  contextWindow: number | null;
  eligibility: LocalOverlayEligibility;
};

export type LocalOverlayServer = {
  serverId: string;
  providerId: string;
  label: string;
  models: LocalOverlayModel[];
};

/** Why a local row cannot be picked here: the server's verdict or a pin rule. */
export type LocalRowBlock = Exclude<LocalOverlayEligibility, 'ok'> | 'new_chat_only' | 'other_server';

/** Server verdicts the member fixes in the server's settings (a link is offered). */
const FIXABLE_IN_SETTINGS: ReadonlySet<LocalRowBlock> = new Set([
  'context_unknown',
  'context_too_small',
  'address_untested',
  'base_url_unsupported',
  'tls_name_requires_relay',
  'model_id_reserved',
]);

export type LocalPickerRow = PickerRow & {
  engineProvider: typeof LOCAL_ENGINE;
  providerId: string;
  /** null = selectable. */
  blocked: LocalRowBlock | null;
  /** True when the fix lives in the server's settings. */
  fixInSettings: boolean;
};

export type LocalPickerBlock = {
  providerId: string;
  serverLabel: string;
  rows: LocalPickerRow[];
};

/** Where the open chat stands on the engine axis. */
export type LocalChatContext = {
  /** No conversation exists yet: the next send creates it. */
  isNewChat: boolean;
  /** The chat's engine stamp (`local`, a vendor id) or null. */
  chatEngine: string | null;
  /** The chat's effective model id. */
  chatModel: string;
};

/**
 * True while the Claude × local matrix cell is actionable. The picker follows the
 * matrix's own convention (`actionableEngineCells`): a cell that is a barrier is
 * hidden, not greyed — so the blocks stay absent until T-2103 flips the cell.
 */
export function claudeLocalCellOpen(): boolean {
  return actionableEngineCells('claude').some((cell) => cell.engine === LOCAL_ENGINE);
}

/** The provider id (`nassaj_local_<hex>`) of a local model id, or null. */
export function localProviderOfModel(model: string | null | undefined): string | null {
  if (!isLocalModelId(model)) return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

/** True when the open chat runs on a local server (stamp or model id). */
export function isLocalChat(ctx: LocalChatContext): boolean {
  return !ctx.isNewChat && (ctx.chatEngine === LOCAL_ENGINE || isLocalModelId(ctx.chatModel));
}

function pinBlock(ctx: LocalChatContext, providerId: string): LocalRowBlock | null {
  if (ctx.isNewChat) return null;
  if (!isLocalChat(ctx)) return 'new_chat_only';
  return localProviderOfModel(ctx.chatModel) === providerId ? null : 'other_server';
}

/**
 * The local blocks for the picker. Empty when the matrix cell is closed or the
 * overlay is empty. A pin rule outranks the server's verdict: a model that could
 * never run in THIS chat says so first.
 */
export function localPickerBlocks(
  overlay: readonly LocalOverlayServer[],
  ctx: LocalChatContext,
  cellOpen: boolean = claudeLocalCellOpen(),
): LocalPickerBlock[] {
  if (!cellOpen) return [];
  return overlay
    .filter((server) => server.models.length > 0)
    .map((server) => {
      const pinned = pinBlock(ctx, server.providerId);
      return {
        providerId: server.providerId,
        serverLabel: server.label,
        rows: server.models.map((model): LocalPickerRow => {
          const blocked = pinned ?? (model.eligibility === 'ok' ? null : model.eligibility);
          return {
            key: `claude:local-model:${model.value}`,
            model: model.value,
            label: model.label,
            engine: { key: 'localServer', vars: {} },
            engineProvider: LOCAL_ENGINE,
            locked: false,
            providerId: server.providerId,
            blocked,
            fixInSettings: blocked !== null && FIXABLE_IN_SETTINGS.has(blocked),
          };
        }),
      };
    });
}

/** A local server named for display: the member's label, or a deleted server. */
export type LocalServerName = { kind: 'server'; label: string } | { kind: 'deleted' };

/**
 * Names the local server a local model id belongs to — never the raw pin.
 * `deleted` when that server is no longer in the overlay; null for a non-local id.
 */
export function localServerForModel(
  overlay: readonly LocalOverlayServer[],
  model: string,
): LocalServerName | null {
  const providerId = localProviderOfModel(model);
  if (!providerId) return null;
  const server = overlay.find((entry) => entry.providerId === providerId);
  return server ? { kind: 'server', label: server.label } : { kind: 'deleted' };
}

/** How to name the open chat's local server; null for a chat that is not local. */
export function localChatServer(
  overlay: readonly LocalOverlayServer[],
  ctx: LocalChatContext,
): LocalServerName | null {
  if (!isLocalChat(ctx)) return null;
  return localServerForModel(overlay, ctx.chatModel) ?? { kind: 'deleted' };
}

/** The label of a local model id from the overlay, or undefined. */
export function localModelLabel(
  overlay: readonly LocalOverlayServer[],
  model: string,
): string | undefined {
  for (const server of overlay) {
    const hit = server.models.find((entry) => entry.value === model);
    if (hit) return hit.label;
  }
  return undefined;
}
