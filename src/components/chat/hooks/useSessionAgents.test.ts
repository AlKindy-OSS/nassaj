/**
 * ADR-218 (T-2070) — useSessionAgents: REST snapshot on open, `session-agents`
 * WS frames for THIS session only, reset on a session switch.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ws = vi.hoisted(() => ({ frames: new Map<string, { seq: number; frame: unknown }>() }));
const api = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ sessionAgentsFrames: ws.frames }),
}));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: api.fetch }));

import { parseSessionAgentsSnapshot, useSessionAgents } from './useSessionAgents';

const row = (sessionId: string, key: string) => ({
  key, sessionId, source: 'claude-subagent', toolUseIds: [], label: key, background: true,
  state: 'running', startedAt: 1, lastEventAt: 1, accuracy: 'live',
});

const ok = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });

beforeEach(() => {
  ws.frames = new Map();
  api.fetch.mockReset();
});

describe('useSessionAgents', () => {
  it('يجلب اللقطة عند الفتح', async () => {
    api.fetch.mockResolvedValue(ok({ supported: true, agents: [row('s1', 'a')] }));
    const { result } = renderHook(() => useSessionAgents('s1'));
    await waitFor(() => expect(result.current.agents.map((a) => a.key)).toEqual(['a']));
    expect(api.fetch.mock.calls[0][0]).toBe('/api/sessions/s1/agents/live');
  });

  it('supported:false → لا صفوف', async () => {
    api.fetch.mockResolvedValue(ok({ supported: false, agents: [] }));
    const { result } = renderHook(() => useSessionAgents('s1'));
    await waitFor(() => expect(api.fetch).toHaveBeenCalled());
    expect(result.current).toEqual({ supported: false, agents: [] });
  });

  it('يطبّق إطار الجلسة نفسها ويتجاهل إطار جلسة أخرى', async () => {
    api.fetch.mockResolvedValue(ok({ supported: true, agents: [] }));
    const { result, rerender } = renderHook(() => useSessionAgents('s1'));
    await waitFor(() => expect(api.fetch).toHaveBeenCalled());
    act(() => {
      ws.frames = new Map([['s2', { seq: 1, frame: { type: 'session-agents', sessionId: 's2', supported: true, agents: [row('s2', 'other')] } }]]);
    });
    rerender();
    expect(result.current.agents).toEqual([]);
    act(() => {
      ws.frames = new Map([...ws.frames, ['s1', { seq: 2, frame: { type: 'session-agents', sessionId: 's1', supported: true, agents: [row('s1', 'mine')] } }]]);
    });
    rerender();
    expect(result.current.agents.map((a) => a.key)).toEqual(['mine']);
  });

  it('لا يعيد ردّ REST المتأخّر القائمة إلى ما قبل إطار أحدث', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    api.fetch.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result, rerender } = renderHook(() => useSessionAgents('s1'));
    act(() => {
      ws.frames = new Map([['s1', { seq: 5, frame: { type: 'session-agents', sessionId: 's1', supported: true, agents: [row('s1', 'live')] } }]]);
    });
    rerender();
    await act(async () => { resolve(ok({ supported: true, agents: [row('s1', 'old')] })); });
    expect(result.current.agents.map((a) => a.key)).toEqual(['live']);
  });

  it('يصفّر عند تبديل الجلسة', async () => {
    api.fetch.mockImplementation(async (url: string) =>
      url.includes('/s1/') ? ok({ supported: true, agents: [row('s1', 'a')] }) : new Promise(() => undefined));
    const { result, rerender } = renderHook(({ id }) => useSessionAgents(id), { initialProps: { id: 's1' } });
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    rerender({ id: 's2' });
    expect(result.current.agents).toEqual([]);
  });

  it('يُسقط صفوف جلسة أخرى والصيغ المعطوبة', () => {
    expect(parseSessionAgentsSnapshot({ supported: true, agents: [row('s2', 'x'), { key: 1 }] }, 's1'))
      .toEqual({ supported: true, agents: [] });
    expect(parseSessionAgentsSnapshot({ agents: [] }, 's1')).toBeNull();
  });
});
