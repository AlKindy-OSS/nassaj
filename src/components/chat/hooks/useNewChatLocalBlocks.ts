/**
 * useNewChatLocalBlocks — the "local models · <server>" blocks of the new-chat
 * picker, one set per coding agent that runs on local servers (LOCAL_BODIES:
 * Claude, Codex, DeepSeek Harness; ADR-227 Decision 10, T-2107 stage 5, T-2108).
 * An agent's overlay is read only while its body × local matrix cell is open, and
 * only when the picker is open or that agent's pending choice is a local model
 * (its card names the server).
 */
import { useMemo } from 'react';

import {
  LOCAL_BODIES,
  localCellOpen,
  localPickerBlocks,
  type LocalBody,
  type LocalOverlayServer,
  type LocalPickerBlock,
} from '../view/subcomponents/localOverlayRows';

import { useLocalOverlay } from './useLocalOverlay';

/** This picker only renders for a chat that does not exist yet. */
const NEW_CHAT = { isNewChat: true, chatEngine: null, chatModel: '' } as const;

type Input = {
  dialogOpen: boolean;
  /** Per agent: is its pending choice a local model? */
  pendingLocal: Record<LocalBody, boolean>;
};

export type NewChatLocalBlocks = {
  overlays: Record<LocalBody, LocalOverlayServer[] | null>;
  blocks: Record<LocalBody, LocalPickerBlock[]>;
};

/** Maps every local body to a value. */
function perBody<T>(value: (body: LocalBody) => T): Record<LocalBody, T> {
  return Object.fromEntries(LOCAL_BODIES.map((body) => [body, value(body)])) as Record<LocalBody, T>;
}

export function useNewChatLocalBlocks({ dialogOpen, pendingLocal }: Input): NewChatLocalBlocks {
  const open = perBody(localCellOpen);
  const reads = (body: LocalBody) => open[body] && (dialogOpen || pendingLocal[body]);
  // One hook call per body of the fixed LOCAL_BODIES list, in its order.
  const claude = useLocalOverlay('claude', reads('claude'));
  const codex = useLocalOverlay('codex', reads('codex'));
  const dsh = useLocalOverlay('dsh', reads('dsh'));
  const { claude: claudeOpen, codex: codexOpen, dsh: dshOpen } = open;
  return useMemo(() => {
    const overlays = { claude, codex, dsh };
    const cells = { claude: claudeOpen, codex: codexOpen, dsh: dshOpen };
    return {
      overlays,
      blocks: perBody((body) => localPickerBlocks(body, overlays[body] ?? [], NEW_CHAT, cells[body])),
    };
  }, [claude, codex, dsh, claudeOpen, codexOpen, dshOpen]);
}
