/**
 * ADR-200 §8 / M-6 — the supervised opencode chat cell
 * (NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT) persists the prompt into the vendor
 * transcript and message_authors, and the assistant text into the transcript.
 * Each is redacted against the keys that can enter the turn; other providers
 * keep their text byte for byte.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME, DATABASE_PATH and the
// harness roots before any app module reads them.
// eslint-disable-next-line boundaries/dependencies -- the shared hermetic test sandbox
import { removeSandbox } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, messageAuthorsDb } = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const { providerSecretsService } = await import('@/modules/providers/index.js');
const { cliTurnSupervisorRedactionInternals: internals } = await import('./cli-turn-supervisor.service.js');

await initializeDatabase();
_resetProviderSecretsServerKeyCache();
const sender = userDb.createUser('cli-sup-sender', 'hash', 'user');
const peer = userDb.createUser('cli-sup-peer', 'hash', 'user');
const SENDER_KEY = ['tp', 'supervised-sender-key-0123456789'].join('-');
const PEER_KEY = ['glm', 'supervised-peer-key-0123456789'].join('-');
providerSecretsService.setKey(sender.id, 'qwen', SENDER_KEY);
providerSecretsService.setKey(peer.id, 'glm', PEER_KEY);

after(() => {
  closeConnection();
  removeSandbox();
});

test('an opencode prompt is redacted before transcript and message_authors persist it', () => {
  const prompt = `please use ${SENDER_KEY}`;
  assert.equal(internals.redactOpenCodePrompt('opencode', sender.id, prompt), 'please use [REDACTED]');
  assert.equal(internals.redactOpenCodePrompt('codex', sender.id, prompt), prompt, 'other cells unchanged');
});

test('the persisted assistant text is redacted against every session sender', () => {
  messageAuthorsDb.recordUserMessage('opencode_supervised_x', sender.id, 'hi');
  messageAuthorsDb.recordUserMessage('opencode_supervised_x', peer.id, 'hello');
  const text = `a ${SENDER_KEY} b ${PEER_KEY}`;
  assert.equal(internals.redactOpenCodeSessionText('opencode', 'opencode_supervised_x', text), 'a [REDACTED] b [REDACTED]');
  assert.equal(internals.redactOpenCodeSessionText('qwen', 'opencode_supervised_x', text), text);
});

test('both persist calls of the supervised turn use the redacted prompt', () => {
  const source = fs.readFileSync(new URL('./cli-turn-supervisor.service.ts', import.meta.url), 'utf8');
  assert.match(source, /message: persistedPrompt/u);
  assert.match(source, /recordUserMessage\(sessionId, input\.userId, persistedPrompt\)/u);
  assert.doesNotMatch(source, /recordUserMessage\([^)]*input\.prompt\)/u);
  assert.match(source, /redactOpenCodeSessionText\(claimed\.provider, claimed\.sessionId, claimed\.text\)/u);
});

test('the hosted-result-store receives redacted assistant text for opencode only', () => {
  messageAuthorsDb.recordUserMessage('opencode_supervised_store', sender.id, 'hi');
  const stored: Array<{ hostedResult?: { text: string } }> = [];
  const fake = {
    finishExecution: (input: { hostedResult?: { text: string } }) => { stored.push(input); return 'finished'; },
    startExecution: () => 'started',
  } as never;
  const result = { provider: 'opencode', model: 'opencode/default', sessionId: 'opencode_supervised_store',
    isNewSession: true, text: `answer ${SENDER_KEY}` };

  const wrapped = internals.redactingResultRepository('opencode', 'opencode_supervised_store', fake) as unknown as {
    finishExecution: (input: unknown) => unknown; startExecution: () => unknown;
  };
  assert.equal(wrapped.finishExecution({ runId: 'r', hostedResult: result }), 'finished');
  assert.equal(stored[0].hostedResult?.text, 'answer [REDACTED]');
  assert.equal(result.text, `answer ${SENDER_KEY}`, 'the caller input is not mutated');
  assert.equal(wrapped.startExecution(), 'started', 'other methods pass through');
  wrapped.finishExecution({ runId: 'r2' });
  assert.equal(stored[1].hostedResult, undefined, 'a failed turn carries no result to redact');

  assert.equal(internals.redactingResultRepository('codex', 'opencode_supervised_store', fake), fake,
    'other providers keep the plain repository');
});

test('the live reply and a replay returned to the client are redacted with the same helper', () => {
  const source = fs.readFileSync(new URL('./cli-turn-supervisor.service.ts', import.meta.url), 'utf8');
  assert.match(source, /repository: redactingResultRepository\(input\.provider, sessionId\)/u);
  assert.match(source, /const text = redactOpenCodeSessionText\(input\.provider, sessionId, result\.text\);/u);
  assert.match(source, /const text = redactOpenCodeSessionText\(replay\.provider, replay\.sessionId, replay\.text\);/u);
  assert.doesNotMatch(source, /return \{ text: (result|replay)\.text/u);
  // The returned value for this session is exactly the redacted text.
  assert.equal(
    internals.redactOpenCodeSessionText('opencode', 'opencode_supervised_store', `live ${SENDER_KEY}`),
    'live [REDACTED]',
  );
});
