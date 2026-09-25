/**
 * T-1854 (qa H1c) — hosted vendors: a run fence revoked at any await point of
 * the launch (resolveResumeModel, writeTranscriptMeta ~137, appendTranscript
 * ~152) either prevents the fetch, or the AbortController is registered
 * (active.set ~159) in the same synchronous block, so abortVendorSession
 * succeeds right after the fetch starts.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

/* eslint-disable boundaries/no-unknown -- shared provider-sweep helper lives beside the launchers. */
import {
  createProbeWriter,
  io,
  launchAlreadyRevoked,
  observeSpawn,
  sweepRevocationAcrossLaunch,
  type ProbeWriter,
  type SpawnObservation,
} from '../../../../run-fence-sweep.test-helper.js';
/* eslint-enable boundaries/no-unknown */

const url = (relativePath: string) => new URL(relativePath, import.meta.url).href;
mock.module(url('../../../../services/provider-run-presence.js'), {
  namedExports: { beginProviderRun: () => ({ end: () => undefined }) },
});
mock.module(url('../../../../services/isolation/resolve-provider-env.js'), {
  namedExports: { resolveProviderEnv: () => ({ KIMI_API_KEY: 'fixture-key' }) },
});
mock.module(url('../../services/sessions.service.js'), { namedExports: { sessionsService: {} } });
mock.module(url('../../services/provider-models.service.js'), {
  namedExports: {
    providerModelsService: { resolveResumeModel: () => io('fixture'), seedSessionModel: () => io(undefined) },
  },
});
mock.module(url('./vendor-transcript.js'), {
  namedExports: { appendVendorTranscript: () => io(undefined), writeVendorTranscriptMeta: () => io(undefined) },
});

let currentWriter: ProbeWriter = createProbeWriter();
const observation: { current: SpawnObservation | null } = { current: null };
const { createVendorSpawn, abortVendorSession } = await import('./vendor-runtime.js');
const spawnKimi = createVendorSpawn('kimi');

mock.method(globalThis, 'fetch', (_url: string, init: { signal: AbortSignal }) => {
  observeSpawn(currentWriter, (sessionId) => abortVendorSession('kimi', sessionId), observation);
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
});

const launch = (writer: ProbeWriter) => {
  currentWriter = writer;
  return spawnKimi('hello', { cwd: process.cwd() }, writer);
};
// The abort measured right after the fetch rejects it; nothing else to end.
const settle = () => undefined;

test('qa H1c vendor: revocation at every await point never leaves an unabortable fetch', async () => {
  const outcome = await sweepRevocationAcrossLaunch({ launch, observation, settle });
  assert.ok(outcome.revokedBeforeSpawn >= 1, 'at least one pre-fetch await point was exercised');
});

test('qa H1b vendor: a fence already revoked at launch never fetches', async () => {
  await launchAlreadyRevoked({ launch, observation, settle });
});
