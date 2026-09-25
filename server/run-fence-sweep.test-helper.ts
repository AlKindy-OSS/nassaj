/**
 * T-1854 (qa H1c): revocation injected at every await point of a provider launch.
 *
 * A membership removal is a separate request, so it can only interleave with a
 * provider launch at a macrotask boundary — microtask-only awaits cannot be
 * split by another task. The sweep therefore revokes the run fence after N
 * event-loop turns, for N = 0, 1, 2, … until the provider has spawned BEFORE
 * the revocation. For every N it asserts the H1 invariant through the spawn /
 * fetch spy: either nothing was spawned after the revocation, or the spawned
 * process was registered synchronously so the provider's own abort bridge
 * succeeded in the microtask right after spawn.
 */
import assert from 'node:assert/strict';

export type ProbeWriter = {
  userId: number;
  runFenceRevoked: boolean;
  sessionId: string | null;
  sent: unknown[];
  send(payload: unknown): void;
  setSessionId(sessionId: string): void;
  isRunOutputRevoked(): boolean;
};

export type SpawnObservation = { revokedAtSpawn: boolean; abortedAfterSpawn: boolean | null };

export function createProbeWriter(userId = 7): ProbeWriter {
  const writer: ProbeWriter = {
    userId,
    runFenceRevoked: false,
    sessionId: null,
    sent: [],
    send(payload) { writer.sent.push(payload); },
    setSessionId(sessionId) { writer.sessionId = sessionId; },
    isRunOutputRevoked() { return writer.runFenceRevoked; },
  };
  return writer;
}

/**
 * Records one spawn/fetch: the fence state at that instant, then the abort
 * verdict from the microtask queued right after the synchronous spawn block.
 */
export function observeSpawn(
  writer: ProbeWriter,
  abort: (sessionId: string) => boolean,
  sink: { current: SpawnObservation | null },
): void {
  const observation: SpawnObservation = { revokedAtSpawn: writer.runFenceRevoked, abortedAfterSpawn: null };
  sink.current = observation;
  queueMicrotask(() => {
    observation.abortedAfterSpawn = writer.sessionId ? abort(writer.sessionId) : false;
  });
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Mocked async dependencies resolve on a LATER macrotask, as real I/O does, so
 * every await in the launch path is a point where the sweep can revoke.
 */
export const io = <T>(value: T): Promise<T> => new Promise((resolve) => setImmediate(() => resolve(value)));
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

export async function sweepRevocationAcrossLaunch(input: {
  launch: (writer: ProbeWriter) => Promise<unknown>;
  observation: { current: SpawnObservation | null };
  /** Ends a spawned run (e.g. emits `close`) so the launch promise settles. */
  settle: () => void;
  maxTurns?: number;
  deadlineMs?: number;
}): Promise<{ revokedBeforeSpawn: number; spawnedAfterRevocation: number }> {
  const maxTurns = input.maxTurns ?? 2000;
  const deadlineMs = input.deadlineMs ?? 20_000;
  let revokedBeforeSpawn = 0;
  // Read through a function: the spy mutates the sink behind the compiler's back.
  const current = (): SpawnObservation | null => input.observation.current;
  for (let turns = 0; turns <= maxTurns; turns += 1) {
    input.observation.current = null;
    const writer = createProbeWriter();
    let settled = false;
    const run = input.launch(writer).catch(() => undefined).finally(() => { settled = true; });
    for (let index = 0; index < turns && !current() && !settled; index += 1) await turn();
    const spawnedFirst = current() !== null;
    writer.runFenceRevoked = true;
    const started = Date.now();
    let ended = false;
    while (!settled && Date.now() - started < deadlineMs) {
      const seen = current();
      if (!ended && seen && seen.abortedAfterSpawn !== null) {
        ended = true;
        input.settle();
      }
      await pause();
    }
    await run;
    assert.equal(settled, true, `launch settled (turns=${turns})`);
    const observed = current();
    if (observed) {
      assert.equal(observed.revokedAtSpawn, false, `never spawned after revocation (turns=${turns})`);
      assert.equal(observed.abortedAfterSpawn, true,
        `spawned run is registered synchronously and abortable (turns=${turns})`);
    } else {
      revokedBeforeSpawn += 1;
    }
    if (spawnedFirst) return { revokedBeforeSpawn, spawnedAfterRevocation: 0 };
  }
  assert.fail(`the provider never spawned within ${maxTurns} turns`);
}

/** qa H1b: a fence already revoked at launch returns without any spawn/fetch. */
export async function launchAlreadyRevoked(input: {
  launch: (writer: ProbeWriter) => Promise<unknown>;
  observation: { current: SpawnObservation | null };
  settle: () => void;
  deadlineMs?: number;
}): Promise<void> {
  input.observation.current = null;
  const writer = createProbeWriter();
  writer.runFenceRevoked = true;
  let settled = false;
  const run = input.launch(writer).catch(() => undefined).finally(() => { settled = true; });
  const started = Date.now();
  while (!settled && !input.observation.current && Date.now() - started < (input.deadlineMs ?? 20_000)) {
    await pause();
  }
  if (input.observation.current) {
    input.settle();
    await run;
    assert.fail('spawned although the fence was revoked before launch');
  }
  assert.equal(settled, true, 'the refused launch settles');
}
