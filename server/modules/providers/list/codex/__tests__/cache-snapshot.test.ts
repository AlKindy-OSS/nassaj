import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCacheSnapshot, latestClaudeTokenUsage } from '../../claude/claude-token-usage.js';
import { extractCodexTokenBudget, accumulateCodexCoordinatorUsage } from '../codex-token-budget.js';
import { HistoryTransferLedger } from '../../../services/history-budget.service.js';

const claude = (usage: object) => ({ type: 'assistant', uuid: 'event-a', sequence: 7,
  timestamp: '2026-09-13T10:00:00Z', message: { model: 'model-a', usage } });
const raw = { input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 };
const codex = (usage: object, transport: 'history' | 'live' = 'live') => extractCodexTokenBudget(
  { type: 'turn.completed', usage }, 'model-a', 'session-a', transport)!;

test('Claude raw total includes read/write once; source metadata survives history', () => {
  const event = claude(raw);
  const live = claudeCacheSnapshot(event, 'session-a')!;
  const history = latestClaudeTokenUsage(JSON.stringify(event), 'session-a').cacheSnapshot!;
  assert.equal(live.inputTokens, 1000);
  assert.equal(live.cacheReadTokens! / live.inputTokens!, .6);
  assert.equal(history.transport, 'history');
  assert.equal(history.observedAt, event.timestamp);
  assert.equal(history.eventId, 'event-a');
  assert.equal(history.sequence, 7);
  assert.deepEqual({ ...history, receivedAt: '', transport: '' }, { ...live, receivedAt: '', transport: '' });
});
test('raw presence, safe sum and true zero do not inherit legacy default zeros', () => {
  for (const invalid of [undefined, null, -1, NaN, Infinity, '600', Number.MAX_SAFE_INTEGER + 1]) {
    const value = claudeCacheSnapshot(claude({ ...raw, cache_read_input_tokens: invalid }), 's')!;
    assert.equal(value.cacheReadTokens, null);
    assert.equal(value.inputTokens, null);
  }
  assert.equal(claudeCacheSnapshot(claude({ ...raw, input_tokens: Number.MAX_SAFE_INTEGER }), 's')!.inputTokens, null);
  assert.equal(claudeCacheSnapshot(claude({ ...raw, cache_read_input_tokens: 0 }), 's')!.cacheReadTokens, 0);
  assert.equal(claudeCacheSnapshot(claude({}), 's')!.inputTokens, null);
  assert.equal(claudeCacheSnapshot({ ...claude(raw), parent_tool_use_id: 'child' }, 's'), null);
});
test('Codex input is inclusive and turn/session/request scopes never mix', () => {
  const value = codex({ input_tokens: 1000, cached_input_tokens: 600 });
  assert.equal(value.cacheSnapshot!.inputTokens, 1000);
  assert.equal(value.cacheSnapshot!.scope, 'turn');
  assert.equal(value.cacheSnapshot!.observedAt, null);
  assert.equal(value.used, null);
  const mixed = extractCodexTokenBudget({ info: { last_token_usage: { input_tokens: 20 },
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 600 } } })!;
  assert.equal(mixed.cacheSnapshot!.scope, 'last_request');
  assert.equal(mixed.cacheSnapshot!.cacheReadTokens, null);
  assert.equal(extractCodexTokenBudget({ info: { total_token_usage: { input_tokens: 1000 } } })!.cacheSnapshot!.scope, 'session');
  const next = codex({ input_tokens: 10 });
  assert.equal(accumulateCodexCoordinatorUsage(value, next).cacheSnapshot!.cacheReadTokens, null);
});
test('bounded transport keeps whole snapshot and rejects invalid metadata', () => {
  const ledger = new HistoryTransferLedger();
  const handle = ledger.acquire('usage');
  const value = codex({ input_tokens: 1000, cached_input_tokens: 600 }, 'history');
  assert.deepEqual(handle.commitUsage(value)!.cacheSnapshot, value.cacheSnapshot);
  assert.equal(handle.commitUsage({ ...value, cacheSnapshot: null })!.cacheSnapshot, null);
  assert.throws(() => handle.commitUsage({ ...value, cacheSnapshot: { ...value.cacheSnapshot, scope: 'invented' } }));
  handle.release();
});
test('compaction and model replacement do not resurrect old Claude cache', () => {
  const before = JSON.stringify(claude(raw));
  const compact = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(latestClaudeTokenUsage(before + '\n' + compact, 's').cacheSnapshot, null);
  const newModel = { ...claude({ input_tokens: 12 }), message: { model: 'model-b', usage: { input_tokens: 12 } } };
  const after = latestClaudeTokenUsage(before + '\n' + JSON.stringify(newModel), 'new-session').cacheSnapshot!;
  assert.equal(after.modelId, 'model-b');
  assert.equal(after.sessionId, 'new-session');
  assert.equal(after.cacheReadTokens, null);
});
