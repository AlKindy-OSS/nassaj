import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it, mock } from 'node:test';

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || path.join(process.cwd(), '.artifacts'), 'vendor-response-identity-'));
mock.method(os, 'homedir', () => scratch);
process.env.DATABASE_PATH = path.join(scratch, 'empty-test.sqlite');
fs.writeFileSync(process.env.DATABASE_PATH, '');
const { initializeDatabase, closeConnection, sessionsDb, responseTurnMetricsDb } =
  await import('@/modules/database/index.js');
const { appendVendorTranscriptTurn, vendorTranscriptPath, vendorProviderRoot } =
  await import('../shared/vendor/vendor-transcript.js');
const { VendorSessionsProvider } = await import('../shared/vendor/vendor-sessions.provider.js');
const { settleTurnTiming } = await import('../services/turn-timing.service.js');
const { applyResponseTurnMetrics } = await import('../services/sessions.service.js');
await initializeDatabase();
after(() => {
  closeConnection();
  mock.restoreAll();
  fs.rmSync(scratch, { recursive: true, force: true });
});

for (const providerName of ['qwen', 'hermes'] as const) {
  it(`${providerName}: saved assistant ID survives reload and joins only its completed response metric`, async () => {
    const sessionId = `${providerName}-identity`;
    const file = vendorTranscriptPath(providerName, sessionId, scratch);
    sessionsDb.createSession(sessionId, providerName, scratch, undefined, undefined, undefined, file);
    await appendVendorTranscriptTurn(providerName, sessionId, scratch, 'user', 'prompt');
    const partial = await appendVendorTranscriptTurn(providerName, sessionId, scratch, 'assistant', 'progress', {
      model: 'model-a',
    });
    const first = await appendVendorTranscriptTurn(providerName, sessionId, scratch, 'assistant', 'same answer', {
      model: 'model-a', finalAnswer: true,
    });
    const second = await appendVendorTranscriptTurn(providerName, sessionId, scratch, 'assistant', 'same answer', {
      model: 'model-b', finalAnswer: true,
    });
    assert.ok(first && second && partial);
    assert.notEqual(first, second, 'equal text is not an identity');
    assert.equal(settleTurnTiming({
      sessionId, assistantMessageId: second, turnId: `${providerName}-turn-2`,
      startedAt: '2026-09-05T12:00:00Z', completedAt: '2026-09-05T12:00:02Z',
    }).responseTurnMetric?.durationMs, 2000);
    const provider = new VendorSessionsProvider({ provider: providerName });
    const firstRead = await provider.fetchHistory(sessionId, { projectPath: scratch });
    const secondRead = await provider.fetchHistory(sessionId, { projectPath: scratch });
    assert.deepEqual(firstRead.messages.map((row) => row.id), secondRead.messages.map((row) => row.id));
    assert.deepEqual(firstRead.messages.map((row) => row.timestamp), secondRead.messages.map((row) => row.timestamp));
    applyResponseTurnMetrics(secondRead.messages, responseTurnMetricsDb.listForMessages(
      sessionId, secondRead.messages.map((row) => row.id),
    ));
    assert.equal(secondRead.messages.find((row) => row.id === partial)?.isFinalAnswer, false);
    assert.equal(secondRead.messages.find((row) => row.id === first)?.responseTurnMetric, undefined);
    assert.equal(secondRead.messages.find((row) => row.id === second)?.responseTurnMetric?.durationMs, 2000);
    assert.equal(secondRead.messages.find((row) => row.id === second)?.model, 'model-b');
    assert.equal(secondRead.messages.find((row) => row.id === second)?.isFinalAnswer, true);
  });
}

it('a failed transcript append returns no identity and cannot create a response metric', async () => {
  const root = vendorProviderRoot('deepseek');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.writeFileSync(root, 'synthetic blocked directory');
  const sessionId = 'failed-append';
  sessionsDb.createSession(sessionId, 'deepseek', scratch);
  const id = await appendVendorTranscriptTurn('deepseek', sessionId, scratch, 'assistant', 'visible reply', {
    finalAnswer: true,
  });
  assert.equal(id, null);
  assert.deepEqual(settleTurnTiming({
    sessionId, assistantMessageId: id,
    startedAt: '2026-09-05T12:00:00Z', completedAt: '2026-09-05T12:00:02Z',
  }), {});
  assert.equal(responseTurnMetricsDb.sumSessionDuration(sessionId), null);
});

it('legacy text-only history remains visible without inventing model or timing', async () => {
  const file = vendorTranscriptPath('glm', 'legacy', scratch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'legacy' } })}\n`);
  const history = await new VendorSessionsProvider({ provider: 'glm' }).fetchHistory('legacy', { projectPath: scratch });
  assert.equal(history.messages[0]?.content, 'legacy');
  assert.equal(history.messages[0]?.model, undefined);
  assert.equal(history.messages[0]?.responseTurnMetric, undefined);
});
