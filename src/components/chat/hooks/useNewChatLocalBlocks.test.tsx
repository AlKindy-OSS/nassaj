/**
 * useNewChatLocalBlocks.test.tsx — T-2108 acceptance, in the owner's terms: "in a
 * new DeepSeek Harness chat I see 'Local models · <server>' blocks with only my
 * servers". Each agent that runs on local servers reads its own overlay, and only
 * while the picker is open or its pending choice is a local model.
 *
 * Run: npx vitest run src/components/chat/hooks/useNewChatLocalBlocks.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import { useNewChatLocalBlocks } from './useNewChatLocalBlocks';

const fetchMock = vi.fn();
vi.mock('../../../utils/api', () => ({ authenticatedFetch: (url: string) => fetchMock(url) }));

const server = (body: string) => ({
  serverId: `${body}-srv`, providerId: `nassaj_local_${body}`, label: `${body} box`,
  models: [{ value: `nassaj_local_${body}/m`, label: 'm', contextWindow: 65536, minContextWindow: 22096, eligibility: 'ok' }],
});
const bodyOf = (url: string) => url.split('/')[3];
const NO_LOCAL = { claude: false, codex: false, dsh: false };

afterEach(() => {
  fetchMock.mockReset();
  cleanup();
});

describe('useNewChatLocalBlocks', () => {
  it('lists DeepSeek Harness blocks from its own overlay route when the picker opens', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true, json: async () => ({ success: true, data: [server(bodyOf(url))] }),
    }));
    const { result } = renderHook(() => useNewChatLocalBlocks({ dialogOpen: true, pendingLocal: NO_LOCAL }));
    await waitFor(() => expect(result.current.blocks.dsh).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/dsh/local-overlay');
    expect(result.current.blocks.dsh[0]).toMatchObject({ body: 'dsh', serverLabel: 'dsh box' });
    expect(result.current.blocks.dsh[0].rows[0]).toMatchObject({ body: 'dsh', model: 'nassaj_local_dsh/m', blocked: null });
    expect(result.current.blocks.codex[0].serverLabel).toBe('codex box');
    expect(result.current.overlays.dsh?.[0].label).toBe('dsh box');
  });

  it('reads nothing while the picker is closed and no pending choice is local', () => {
    renderHook(() => useNewChatLocalBlocks({ dialogOpen: false, pendingLocal: NO_LOCAL }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads only the agent whose pending choice is a local model (its card names the server)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: [] }) });
    renderHook(() => useNewChatLocalBlocks({ dialogOpen: false, pendingLocal: { ...NO_LOCAL, dsh: true } }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/dsh/local-overlay');
  });
});
