/**
 * Unit tests of the context guard core and its adapters (T-2087, ADR-223).
 * Fixtures are derived from recorded data (see __fixtures__/README.md).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  claudeIdFromCatalogOption, claudeServedModel, createClaudeContextAdapter, normalizeClaudeModel,
} from './adapters/claude.adapter.js';
import { createCodexContextAdapter, scanCodexRollout } from './adapters/codex.adapter.js';
import { createOpenCodeContextAdapter, lastOpenCodeFill, windowFromLimit } from './adapters/opencode.adapter.js';
import { lastServedClaudeModel, resolveClaudeCompactionModel } from './claude-compaction-model.js';
import { defaultReserveTokens, evaluateFit } from './context-fit.js';
import { createContextGuard, isCompactionCommand } from './context-guard.service.js';
import type { ContextFitAdapter, GuardSession, Observation } from './types.js';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const CATALOG = JSON.parse(fixture('claude-catalog.json'));
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'context-guard-unit-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const session = (provider: string, engineProvider: string | null = null): GuardSession => ({
  sessionId: 'sid-1', provider, jsonlPath: null, engineProvider,
});

test('evaluateFit: fits, too_small and unknown with declared and default reserves', () => {
  assert.equal(defaultReserveTokens(200_000), 20_000);
  assert.equal(defaultReserveTokens(1_000_000), 32_000);
  assert.deepEqual(evaluateFit({ usedTokens: 180_000, windowTokens: 200_000 }),
    { verdict: 'fits', used: 180_000, budget: 180_000, window: 200_000 });
  assert.equal(evaluateFit({ usedTokens: 180_001, windowTokens: 200_000 }).verdict, 'too_small');
  assert.equal(evaluateFit({ usedTokens: 50_000, windowTokens: 64_000, reserveTokens: 16_384 }).verdict, 'too_small');
  assert.deepEqual(evaluateFit({ usedTokens: null, windowTokens: 64_000 }),
    { verdict: 'unknown', used: null, budget: 57_600, window: 64_000 });
  for (const windowTokens of [null, 0, -1, Number.NaN]) {
    assert.equal(evaluateFit({ usedTokens: 10, windowTokens }).verdict, 'unknown');
  }
  assert.equal(evaluateFit({ usedTokens: 1, windowTokens: 100, reserveTokens: 500 }).budget, 0, 'reserve ≤ window');
});

test('isCompactionCommand matches only /compact at the start of the trimmed text', () => {
  for (const yes of ['/compact', ' /compact', '/compact keep notes', '/compact\nfocus']) assert.ok(isCompactionCommand(yes));
  for (const no of ['/compaction', 'please /compact', '/Compact', '', null, 42]) assert.equal(isCompactionCommand(no), false);
});

test('claude: catalog aliases map to full ids; unknown values do not', async () => {
  const options = async () => CATALOG;
  assert.equal(await normalizeClaudeModel('haiku', options), 'claude-haiku-5-5');
  assert.equal(await normalizeClaudeModel('default', options), 'claude-opus-5-5');
  assert.equal(await normalizeClaudeModel('Claude-Opus-4-8', options), 'claude-opus-4-8');
  assert.equal(await normalizeClaudeModel('kimi-k3', options), null);
  assert.equal(await normalizeClaudeModel('claude-unknown', options), null);
  assert.equal(claudeIdFromCatalogOption({ value: 'opus[1m]', label: 'Opus 4.8' }), 'claude-opus-4-8[1m]');
  assert.equal(claudeIdFromCatalogOption({
    value: 'default', description: 'Use the default model (currently Opus 5.5 (1M context))',
  }), 'claude-opus-5-5[1m]');
  assert.equal(claudeIdFromCatalogOption({ value: 'x', label: 'Custom' }), null);
});

test('claude: usage, compaction boundary and vendor engine', async () => {
  let text = fixture('claude-tail.jsonl');
  const adapter = createClaudeContextAdapter({
    transcriptKey: async () => 'k', readTranscriptTail: async () => text, catalogOptions: async () => CATALOG,
  });
  assert.deepEqual(await adapter.observe(session('claude')), { usedTokens: 238_894, modelId: 'claude-opus-5-5' });
  text = fixture('claude-compacted-tail.jsonl');
  assert.deepEqual(await adapter.observe(session('claude')), { usedTokens: null, modelId: null });
  assert.equal(await adapter.observationKey(session('claude', 'deepseek')), null);
  assert.equal(await adapter.normalizeModel('haiku', session('claude', 'kimi')), null);
  assert.equal((await adapter.windowFor('claude-haiku-5-5', session('claude'), { usedTokens: 1, modelId: null })).windowTokens, 200_000);
  const missing = createClaudeContextAdapter({
    transcriptKey: async () => null, readTranscriptTail: async () => null, catalogOptions: async () => [],
  });
  assert.deepEqual(await missing.observe(session('claude')), { usedTokens: null, modelId: null });
});

test('codex: last count, compaction voids it, the fresh count after it counts', async () => {
  const lines = fixture('codex-rollout-tail.jsonl').trim().split('\n');
  assert.deepEqual(scanCodexRollout(lines.slice(0, 2).join('\n')),
    { usedTokens: 171_686, modelId: 'gpt-6-luna', windowsByModel: { 'gpt-6-luna': 258_400 } });
  assert.equal(scanCodexRollout(lines.slice(0, 3).join('\n')).usedTokens, null, 'compacted after the count');
  assert.equal(scanCodexRollout(lines.join('\n')).usedTokens, 22_023, 'fresh count after compaction');
  assert.equal(scanCodexRollout('not json\n{}').usedTokens, null);

  const adapter = createCodexContextAdapter({ rolloutKey: async () => 'k', readRolloutTail: async () => lines.join('\n') });
  const observation = await adapter.observe(session('codex'));
  assert.equal((await adapter.windowFor('gpt-6-luna', session('codex'), observation)).windowTokens, 258_400);
  assert.equal((await adapter.windowFor('gpt-5.4', session('codex'), observation)).windowTokens, null, 'unseen model');
  assert.equal(await adapter.normalizeModel('  ', session('codex')), null);
  const empty = createCodexContextAdapter({ rolloutKey: async () => null, readRolloutTail: async () => null });
  assert.deepEqual(await empty.observe(session('codex')), { usedTokens: null, modelId: null });
});

test('opencode: last fill, windows from models.json limits and local servers', async () => {
  const base = JSON.parse(fixture('opencode-assistant-message.json'));
  const row = (data: object) => ({ data: JSON.stringify(data) });
  assert.deepEqual(lastOpenCodeFill([
    row({ role: 'user' }), row({ ...base, tokens: { input: 0, cache: { read: 0 } } }), row(base),
  ]), { usedTokens: 22_572, modelId: 'opencode/glm-5.3-flash-free' });
  assert.deepEqual(lastOpenCodeFill([{ data: 'broken' }]), { usedTokens: null, modelId: null });

  assert.deepEqual(windowFromLimit({ context: 200_000, input: 160_000, output: 32_000 }),
    { windowTokens: 200_000, reserveTokens: 40_000 });
  assert.deepEqual(windowFromLimit({ context: 1_000_000, output: 131_072 }), { windowTokens: 1_000_000, reserveTokens: 32_000 });
  assert.deepEqual(windowFromLimit({ context: 64_000 }), { windowTokens: 64_000, reserveTokens: null });
  assert.deepEqual(windowFromLimit(undefined), { windowTokens: null, reserveTokens: null });

  const adapter = createOpenCodeContextAdapter({
    findDatabase: () => path.join(scratch, 'none.db'),
    modelsJsonPath: () => path.join(FIXTURES, 'opencode-models.json'),
    localModels: () => [{ providerId: 'nassaj_local_ab', models: [{ id: 'gemma:7b', contextWindow: 32_768 }] }],
  });
  const s = session('opencode');
  const none: Observation = { usedTokens: 1, modelId: null };
  assert.deepEqual(await adapter.windowFor('zai/glm-4.5v', s, none), { windowTokens: 64_000, reserveTokens: 16_384 });
  assert.deepEqual(await adapter.windowFor('nassaj_local_ab/gemma:7b', s, none), { windowTokens: 32_768, reserveTokens: 8_192 });
  assert.deepEqual(await adapter.windowFor('nassaj_local_ab/other', s, none), { windowTokens: null, reserveTokens: null });
  assert.deepEqual(await adapter.windowFor('glm/glm-5.2', s, none), { windowTokens: null, reserveTokens: null });
  assert.equal(await adapter.normalizeModel('glm-5.2[1m]', s), null, 'a bare id names no provider');

  const absent = createOpenCodeContextAdapter({ findDatabase: () => null, modelsJsonPath: () => null, localModels: () => [] });
  assert.equal(await absent.observationKey(s), null);
  assert.deepEqual(await absent.observe(s), { usedTokens: null, modelId: null });
  assert.deepEqual(await absent.windowFor('zai/glm-4.5v', s, none), { windowTokens: null, reserveTokens: null });
});

test('compaction model: transcript only, accepted ids only, never a vendor engine', async () => {
  const tail = fixture('claude-compacted-tail.jsonl');
  assert.equal(lastServedClaudeModel(tail), 'claude-opus-5-5', 'walks back past the compaction');
  assert.equal(lastServedClaudeModel('{"type":"assistant","message":{"model":"<synthetic>"}}'), null);
  const base = { sessionId: 'sid-1', accepted: new Set(['default', 'haiku']), readTail: async () => tail };
  const official = { ...base, readEngine: () => 'anthropic' };
  assert.equal(await resolveClaudeCompactionModel({ ...official, command: '/compact' }), 'claude-opus-5-5');
  assert.equal(await resolveClaudeCompactionModel({ ...official, command: 'hello' }), null);
  assert.equal(await resolveClaudeCompactionModel({ ...official, command: '/compact', sessionId: null }), null);
  assert.equal(await resolveClaudeCompactionModel({ ...base, readEngine: () => 'kimi', command: '/compact' }), null);
  const foreign = { ...official, readTail: async () => '{"type":"assistant","message":{"model":"kimi-k3"}}' };
  assert.equal(await resolveClaudeCompactionModel({ ...foreign, command: '/compact' }), null);
  const failing = { ...official, readTail: async () => { throw new Error('io'); } };
  assert.equal(await resolveClaudeCompactionModel({ ...failing, command: '/compact' }), null);
});

/** A scripted adapter whose every read is counted. */
function scripted(observation: Observation, window = 200_000) {
  const calls = { key: 0, observe: 0 };
  let key = 'v1';
  const adapter: ContextFitAdapter = {
    normalizeModel: async (model) => (model === 'unnamed' ? null : model),
    observationKey: async () => { calls.key += 1; return key; },
    observe: async () => { calls.observe += 1; return observation; },
    windowFor: async () => ({ windowTokens: window, reserveTokens: null }),
  };
  return { adapter, calls, setKey: (next: string) => { key = next; } };
}

test('guard: cache by key and TTL, invalidation, previousModel, unnamed pins', async () => {
  let clock = 0;
  const { adapter, calls, setKey } = scripted({ usedTokens: 190_000, modelId: 'big' });
  const pins = new Map<string, string>([['p:sid-1', 'small']]);
  const guard = createContextGuard({
    adapters: { p: adapter },
    readPin: async (provider, sid) => pins.get(`${provider}:${sid}`) ?? null,
    readSession: (sid) => (sid === 'sid-1' ? session('p') : null),
    now: () => clock,
  });
  const refusal = await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: 'x' });
  assert.deepEqual(refusal, {
    code: 'context_guard_window_too_small',
    payload: { used: 190_000, budget: 180_000, model: 'small', previousModel: 'big', canCompactOnPrevious: false },
  });
  await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: 'x' });
  assert.equal(calls.observe, 1, 'second refusal served from cache');
  clock += 30_001;
  await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: 'x' });
  assert.equal(calls.observe, 2, 'expired after the TTL');
  setKey('v2');
  await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: 'x' });
  assert.equal(calls.observe, 3, 'a changed record is re-read');
  assert.equal(await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: '/compact' }), null);
  await guard.measure({ sessionId: 'sid-1', model: 'small' });
  assert.equal(calls.observe, 4, 'a /compact turn drops the cached reading');

  assert.equal(await guard.checkTurn({ provider: 'p', sessionId: null, command: 'x' }), null);
  assert.equal(await guard.checkTurn({ provider: 'other', sessionId: 'sid-1', command: 'x' }), null);
  pins.set('p:sid-1', 'unnamed');
  assert.equal(await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: 'x' }), null);
  assert.equal(guard.lastAdmittedModel('sid-1'), 'unnamed');
  assert.deepEqual(await guard.measure({ sessionId: 'nope', model: 'm' }), {
    verdict: 'unknown', used: null, budget: null, window: null, model: 'm', previousModel: null,
  });
  const report = await guard.measure({ sessionId: 'sid-1', model: 'small' });
  assert.equal(report.previousModel, 'unnamed', 'the last admitted model wins over the observed one');
});

test('guard: a session whose provider differs from the dispatch provider is not measured', async () => {
  const { adapter, calls } = scripted({ usedTokens: 190_000, modelId: 'big' });
  const guard = createContextGuard({
    adapters: { p: adapter, q: adapter },
    readPin: async () => 'small',
    readSession: () => session('q'),
  });
  assert.equal(await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: 'x' }), null);
  assert.equal(calls.observe, 0);
});

// ---- QA fixes (T-2087 review) ----

const SONNET_TAIL = fixture('claude-tail.jsonl').replaceAll('claude-opus-5-5', 'claude-sonnet-5');
const SONNET_COMPACTED = fixture('claude-compacted-tail.jsonl').replaceAll('claude-opus-5-5', 'claude-sonnet-5');
const official = { sessionId: 'sid-1', accepted: new Set(['default', 'haiku', 'sonnet[1m]']), readEngine: () => 'anthropic' };

test('HIGH-1: a Sonnet conversation past 200k is observed and compacted on the 1M variant', async () => {
  const adapter = createClaudeContextAdapter({
    transcriptKey: async () => 'k', readTranscriptTail: async () => SONNET_TAIL, catalogOptions: async () => CATALOG,
  });
  assert.deepEqual(await adapter.observe(session('claude')), { usedTokens: 238_894, modelId: 'claude-sonnet-5[1m]' });
  const compaction = (extra: object) => resolveClaudeCompactionModel({
    ...official, command: '/compact', readTail: async () => SONNET_TAIL, catalogOptions: CATALOG, ...extra,
  });
  assert.equal(await compaction({}), 'claude-sonnet-5[1m]', 'the tag lost by the transcript is restored');
  assert.equal(await compaction({ lastAdmitted: 'sonnet[1m]' }), 'sonnet[1m]', 'the last admitted model wins');
  assert.equal(await compaction({ lastAdmitted: 'haiku' }), 'claude-sonnet-5[1m]', 'an admitted model too small is skipped');
  const small = fixture('claude-tail.jsonl').replaceAll('claude-opus-5-5', 'claude-haiku-5-5');
  assert.equal(await compaction({ readTail: async () => small }), null, 'no 1M variant of Haiku → no override');
  assert.equal(await compaction({ readTail: async () => SONNET_COMPACTED }), 'claude-sonnet-5',
    'after a compaction the fill is unknown, so the served model is kept as recorded');
});

/** A tail served by `claude-sonnet-5-5` (the catalog's `sonnet`), fill (2 + 984 + cache read) = `fill`. */
const sonnetTailAt = (fill: number): string => fixture('claude-tail.jsonl')
  .replaceAll('claude-opus-5-5', 'claude-sonnet-5-5')
  .replace('"cache_read_input_tokens":237908', `"cache_read_input_tokens":${fill - 986}`);

test('T-2087: only a fill above the base window proves the 1M variant served it', () => {
  assert.equal(claudeServedModel('claude-sonnet-5', 185_000), 'claude-sonnet-5', 'over budget, inside window');
  assert.equal(claudeServedModel('claude-sonnet-5', 200_000), 'claude-sonnet-5', 'exactly the window');
  assert.equal(claudeServedModel('claude-sonnet-5', 200_001), 'claude-sonnet-5[1m]', 'beyond the window');
});

test('T-2087: after a restart, 185k on a 200k Sonnet pinned on sonnet is admitted', async () => {
  const claude = createClaudeContextAdapter({
    transcriptKey: async () => 'k', readTranscriptTail: async () => sonnetTailAt(185_000), catalogOptions: async () => CATALOG,
  });
  assert.deepEqual(await claude.observe(session('claude')), { usedTokens: 185_000, modelId: 'claude-sonnet-5-5' });
  const guard = createContextGuard({
    adapters: { claude }, readPin: async () => 'sonnet', readSession: () => session('claude', 'anthropic'),
  });
  assert.equal(await guard.checkTurn({ provider: 'claude', sessionId: 'sid-1', command: 'x' }), null);
});

test('IMPROVE-4: the post-restart path normalizes the pin once', async () => {
  const { adapter } = scripted({ usedTokens: 10, modelId: 'big' });
  let normalized = 0;
  const counting: ContextFitAdapter = { ...adapter, normalizeModel: async (m, s) => { normalized += 1; return adapter.normalizeModel(m, s); } };
  const guard = createContextGuard({
    adapters: { p: counting }, readPin: async () => 'small', readSession: () => session('p'),
  });
  assert.equal(await guard.checkTurn({ provider: 'p', sessionId: 'sid-1', command: 'x' }), null);
  assert.equal(normalized, 1);
});

test('the refusal says whether the provider can compact on the previous model', async () => {
  const claude = createClaudeContextAdapter({
    transcriptKey: async () => 'k', readTranscriptTail: async () => fixture('claude-tail.jsonl'), catalogOptions: async () => CATALOG,
  });
  const guard = createContextGuard({
    adapters: { claude }, readPin: async () => 'haiku', readSession: () => session('claude', 'anthropic'),
  });
  const refusal = await guard.checkTurn({ provider: 'claude', sessionId: 'sid-1', command: 'x' });
  assert.equal(refusal?.payload.canCompactOnPrevious, true);
});
