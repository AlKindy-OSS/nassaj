import { describe, expect, it } from 'vitest';

import { applyStreamFrame, type StreamFrameMap } from './streamFrameLog';

const sessionId = 'resumed-session';

const delta = (run: string, content: string, sequence: number) => ({
  sessionId, kind: 'stream_delta', content, responseToMessageId: run, sequence,
});
const final = (run: string, id: string, content: string, sequence: number) => ({
  sessionId, kind: 'text', role: 'assistant', id, content, responseToMessageId: run, sequence,
});

function play(frames: any[]): StreamFrameMap {
  return frames.reduce(
    (map: StreamFrameMap, frame, index) => applyStreamFrame(map, frame, index + 1),
    new Map() as StreamFrameMap,
  );
}

describe('server sequence line restarting for a new run (registry entry dropped)', () => {
  it('shows the reply of a later run whose sequence restarts below the previous high-water mark', () => {
    const frames = play([
      delta('run-1', 'a', 1), delta('run-1', 'b', 2), delta('run-1', 'c', 3),
      final('run-1', 'msg-1', 'abc', 4),
      // >120 s later the server dropped the registry entry: the line restarts at 1.
      final('run-2', 'msg-2', 'الرد الجديد', 1),
    ]);
    const entry = frames.get(sessionId)!;
    expect(entry.frame.id).toBe('msg-2');
    expect(entry.text).toBe('الرد الجديد');
    expect(entry.completed?.map(item => item.frame.id)).toEqual(['msg-1']);
  });

  it('keeps following the restarted line (later deltas of the new run are not dropped)', () => {
    const frames = play([
      final('run-1', 'msg-1', 'old', 5),
      delta('run-2', 'x', 1), delta('run-2', 'y', 2),
    ]);
    expect(frames.get(sessionId)!.text).toBe('xy');
  });

  it('still drops a genuine duplicate of the same run', () => {
    const frames = play([delta('run-1', 'a', 1), delta('run-1', 'b', 2)]);
    expect(applyStreamFrame(frames, delta('run-1', 'b', 2), 9)).toBe(frames);
  });

  it('drops a late frame of the PREVIOUS run instead of finalizing the run now streaming', () => {
    const frames = play([
      delta('run-1', 'a', 1), delta('run-1', 'b', 2),
      delta('run-2', 'x', 1),
    ]);
    const late = applyStreamFrame(frames, { sessionId, kind: 'stream_end', responseToMessageId: 'run-1', sequence: 2 }, 9);
    expect(late).toBe(frames);
    expect(late.get(sessionId)!.ended).toBe(false);
    expect(late.get(sessionId)!.text).toBe('x');
  });

  it('remembers every earlier run, not only the one right before', () => {
    const frames = play([
      final('run-1', 'm1', 'one', 3), final('run-2', 'm2', 'two', 1), delta('run-3', 'x', 1),
    ]);
    const late = applyStreamFrame(frames, delta('run-1', 'z', 2), 9);
    expect(late).toBe(frames);
  });

  it('known limit: runs without any run id keep the sequence floor (no safe client signal)', () => {
    const bare = (content: string, sequence: number) => ({
      sessionId, kind: 'text', role: 'assistant', id: content, content, sequence,
    });
    const frames = play([bare('first', 4), bare('second', 1)]);
    expect(frames.get(sessionId)!.frame.id).toBe('first');
  });

  it('known limit: after the head is evicted (64-session window) the floor still applies', () => {
    let frames = play([final('run-1', 'm1', 'one', 4)]);
    for (let i = 0; i < 64; i += 1) {
      frames = applyStreamFrame(frames, { sessionId: `other-${i}`, kind: 'stream_delta', content: 'o', sequence: 1 }, 100 + i);
    }
    expect(frames.has(sessionId)).toBe(false);
    expect(applyStreamFrame(frames, final('run-2', 'm2', 'two', 1), 999)).toBe(frames);
  });
});
