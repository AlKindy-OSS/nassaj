import { describe, expect, it } from 'vitest';

import { applyStreamFrame, streamFinalId, type StreamFrameMap } from './streamFrameLog';

const sessionId = 's1';

function finish(frames: Record<string, unknown>[]) {
  let log: StreamFrameMap = new Map();
  frames.forEach((frame, index) => { log = applyStreamFrame(log, { sessionId, ...frame }, index + 1); });
  const entry = log.get(sessionId)!;
  return { entry, id: streamFinalId(sessionId, entry) };
}

const end = { kind: 'stream_end', id: 'msg_1_end' };

describe('B-1751: streamFinalId', () => {
  it('uses the durable id every delta shares', () => {
    const { id } = finish([
      { kind: 'stream_delta', id: 'msg_1_prt_1', content: 'DO' },
      { kind: 'stream_delta', id: 'msg_1_prt_1', content: 'NE' },
      end,
    ]);
    expect(id).toBe('msg_1_prt_1');
  });

  it('keeps the synthetic id for deltas without an id or with generated ids', () => {
    expect(finish([{ kind: 'stream_delta', content: 'a' }, { kind: 'stream_end' }]).id)
      .toBe(`stream_${sessionId}_2`);
    expect(finish([
      { kind: 'stream_delta', id: 'stream_delta_0b8c6e2a-1f4d-4c1e-9a3b-2d5e6f7a8b9c', content: 'a' },
      { kind: 'stream_end' },
    ]).id).toBe(`stream_${sessionId}_2`);
  });

  it('falls back when deltas carry different ids', () => {
    const { id } = finish([
      { kind: 'stream_delta', id: 'msg_1_prt_1', content: 'a' },
      { kind: 'stream_delta', id: 'msg_1_prt_2', content: 'b' },
      { kind: 'stream_delta', id: 'msg_1_prt_1', content: 'c' },
      end,
    ]);
    expect(id).toBe(`stream_${sessionId}_4`);
  });

  it('does not carry an id into the next reply', () => {
    const { id } = finish([
      { kind: 'stream_delta', id: 'msg_1_prt_1', content: 'a' },
      end,
      { kind: 'stream_delta', content: 'b' },
      { kind: 'stream_end' },
    ]);
    expect(id).toBe(`stream_${sessionId}_4`);
  });

  it('keeps an assistant text frame id', () => {
    expect(finish([{ kind: 'text', role: 'assistant', id: 'codex-1', content: 'x' }]).id).toBe('codex-1');
  });
});
