/**
 * localOverlayRows.test.ts — T-2098 stage 3b (ADR-227 Decision 10): rows,
 * eligibility, pin rules and the never-raw-pin rule of the local picker blocks.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/localOverlayRows.test.ts
 */
import { describe, expect, it } from 'vitest';

import { BODY_ENGINE_MATRIX } from '../../../../../shared/bodyEngineMatrix';

import {
  LOCAL_BODIES,
  localCellOpen,
  localChatServer,
  localPickerBlocks,
  localProviderOfModel,
  localServerForModel,
  type LocalOverlayServer,
} from './localOverlayRows';

const A = 'nassaj_local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'nassaj_local_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const overlay: LocalOverlayServer[] = [
  {
    serverId: 'srv-a',
    providerId: A,
    label: 'Desk GPU',
    models: [
      { value: `${A}/qwen3:8b`, label: 'qwen3:8b', contextWindow: 32768, minContextWindow: 18096, eligibility: 'ok' },
      { value: `${A}/tiny`, label: 'tiny', contextWindow: 4096, minContextWindow: 18096, eligibility: 'context_too_small' },
      { value: `${A}/mystery`, label: 'mystery', contextWindow: null, minContextWindow: 18096, eligibility: 'context_unknown' },
    ],
  },
  {
    serverId: 'srv-b',
    providerId: B,
    label: 'Laptop',
    models: [{ value: `${B}/llama`, label: 'llama', contextWindow: 65536, minContextWindow: 18096, eligibility: 'address_untested' }],
  },
];

const NEW_CHAT = { isNewChat: true, chatEngine: null, chatModel: '' };

describe('AC2 — one block per server, rows from the overlay data', () => {
  it('builds a block per server with the overlay labels and values', () => {
    const blocks = localPickerBlocks('claude', overlay, NEW_CHAT, true);
    expect(blocks.map((block) => block.serverLabel)).toEqual(['Desk GPU', 'Laptop']);
    expect(blocks[0].rows.map((row) => row.model)).toEqual([`${A}/qwen3:8b`, `${A}/tiny`, `${A}/mystery`]);
  });

  it('marks every row with the local engine so the send carries engineProvider=local', () => {
    const rows = localPickerBlocks('claude', overlay, NEW_CHAT, true).flatMap((block) => block.rows);
    expect(rows.every((row) => row.engineProvider === 'local' && !row.locked)).toBe(true);
    expect(rows.every((row) => row.engine.key === 'localServer')).toBe(true);
  });

  it('drops a server that offers no model', () => {
    const empty = [{ ...overlay[1], models: [] }];
    expect(localPickerBlocks('claude', empty, NEW_CHAT, true)).toEqual([]);
  });
});

describe('AC3 — eligibility', () => {
  it('keeps ok rows selectable and carries the server verdict otherwise, with a settings fix', () => {
    const [a, b] = localPickerBlocks('claude', overlay, NEW_CHAT, true);
    expect(a.rows.map((row) => row.blocked)).toEqual([null, 'context_too_small', 'context_unknown']);
    expect(a.rows.map((row) => row.fixInSettings)).toEqual([false, true, true]);
    expect(b.rows[0]).toMatchObject({ blocked: 'address_untested', fixInSettings: true });
  });
});

describe('AC4 — pin rules', () => {
  it('a chat pinned elsewhere offers no local row: start a new chat', () => {
    const ctx = { isNewChat: false, chatEngine: null, chatModel: 'claude-opus-5' };
    const rows = localPickerBlocks('claude', overlay, ctx, true).flatMap((block) => block.rows);
    expect(rows.every((row) => row.blocked === 'new_chat_only' && !row.fixInSettings)).toBe(true);
  });

  it('a vendor-engine chat is "elsewhere" too', () => {
    const ctx = { isNewChat: false, chatEngine: 'glm', chatModel: 'glm-5.2' };
    const rows = localPickerBlocks('claude', overlay, ctx, true).flatMap((block) => block.rows);
    expect(new Set(rows.map((row) => row.blocked))).toEqual(new Set(['new_chat_only']));
  });

  it('a chat on a local server offers only that server', () => {
    const ctx = { isNewChat: false, chatEngine: 'local', chatModel: `${A}/qwen3:8b` };
    const [a, b] = localPickerBlocks('claude', overlay, ctx, true);
    expect(a.rows[0].blocked).toBeNull();
    expect(a.rows[1].blocked).toBe('context_too_small');
    expect(b.rows[0].blocked).toBe('other_server');
  });

  it('recognises a local chat by its model id when the stamp is missing', () => {
    const ctx = { isNewChat: false, chatEngine: null, chatModel: `${B}/llama` };
    const [a] = localPickerBlocks('claude', overlay, ctx, true);
    expect(a.rows.every((row) => row.blocked === 'other_server')).toBe(true);
  });
});

describe('matrix cells body × local', () => {
  it('hides every block while the cell is not actionable (existing picker convention)', () => {
    expect(localPickerBlocks('claude', overlay, NEW_CHAT, false)).toEqual([]);
  });

  it('is open for the Claude, Codex and DeepSeek Harness bodies only (T-2107, T-2108)', () => {
    expect(LOCAL_BODIES).toEqual(['claude', 'codex', 'dsh']);
    for (const body of LOCAL_BODIES) expect(localCellOpen(body)).toBe(true);
    for (const body of ['antigravity', 'opencode', 'kimi']) expect(localCellOpen(body)).toBe(false);
    const cell = BODY_ENGINE_MATRIX.dsh.find((entry) => entry.engine === 'local');
    expect(cell?.status).toBe('available');
  });

  it('builds DeepSeek Harness blocks with the floor its spawn needs (T-2108)', () => {
    const dshOverlay = [{ ...overlay[0], models: [{ ...overlay[0].models[0], minContextWindow: 22096 }] }];
    const [block] = localPickerBlocks('dsh', dshOverlay, NEW_CHAT);
    expect(block).toMatchObject({ body: 'dsh', serverLabel: 'Desk GPU' });
    expect(block.rows[0]).toMatchObject({
      key: `dsh:local-model:${A}/qwen3:8b`, body: 'dsh', blocked: null, minContextWindow: 22096,
    });
  });

  it('keys each row by its body and carries the floor that body needs', () => {
    const codexOverlay = [{ ...overlay[0], models: [{ ...overlay[0].models[1], minContextWindow: 28096 }] }];
    const [block] = localPickerBlocks('codex', codexOverlay, NEW_CHAT, true);
    expect(block.body).toBe('codex');
    expect(block.rows[0]).toMatchObject({ key: `codex:local-model:${A}/tiny`, minContextWindow: 28096 });
  });
});

describe('AC5 — never the raw pin', () => {
  // The composite pin shape `local:<serverId>:<ownerId>:<digest>` (ADR-227 §4).
  const RAW_PIN = /local:[^:"]+:\d+:/;

  it('names the server of a local chat by its label', () => {
    const ctx = { isNewChat: false, chatEngine: 'local', chatModel: `${A}/qwen3:8b` };
    expect(localChatServer(overlay, ctx)).toEqual({ kind: 'server', label: 'Desk GPU' });
  });

  it('names a server that left the overlay as deleted', () => {
    const ctx = { isNewChat: false, chatEngine: 'local', chatModel: 'nassaj_local_cccccccccccccccccccccccccccccccc/x' };
    expect(localChatServer(overlay, ctx)).toEqual({ kind: 'deleted' });
  });

  it('never reads a server out of a composite pin string', () => {
    const pin = `local:srv-a:7:${'f'.repeat(32)}`;
    expect(localProviderOfModel(pin)).toBeNull();
    expect(localServerForModel(overlay, pin)).toBeNull();
    const ctx = { isNewChat: false, chatEngine: pin, chatModel: pin };
    expect(JSON.stringify(localChatServer(overlay, ctx))).not.toMatch(RAW_PIN);
  });

  it('no row text carries a pin', () => {
    const text = JSON.stringify(localPickerBlocks('claude', overlay, NEW_CHAT, true));
    expect(text).not.toMatch(RAW_PIN);
  });
});
