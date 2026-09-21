import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { claudeCacheTtlMinutes, latestClaudeCacheTtlMinutes } from './claude-token-usage.js';

const assistant = (cacheCreation: Record<string, number> | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    ...extra,
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 3,
        output_tokens: 10,
        cache_read_input_tokens: 1000,
        ...(cacheCreation ? { cache_creation: cacheCreation } : {}),
      },
    },
  });

describe('claudeCacheTtlMinutes (T-1765)', () => {
  it('reads the bucket Anthropic reported', () => {
    assert.equal(claudeCacheTtlMinutes({ cache_creation: { ephemeral_1h_input_tokens: 961, ephemeral_5m_input_tokens: 0 } }), 60);
    assert.equal(claudeCacheTtlMinutes({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 42 } }), 5);
  });

  it('returns null when the request wrote nothing or has no split', () => {
    assert.equal(claudeCacheTtlMinutes({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), null);
    assert.equal(claudeCacheTtlMinutes({ cache_creation_input_tokens: 500 }), null);
    assert.equal(claudeCacheTtlMinutes(null), null);
  });
});

describe('latestClaudeCacheTtlMinutes (T-1765)', () => {
  it('uses the latest main-chain assistant request that wrote to the cache', () => {
    const jsonl = [
      assistant({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 90 }),
      assistant({ ephemeral_1h_input_tokens: 961, ephemeral_5m_input_tokens: 0 }),
      assistant({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }),
    ].join('\n');
    assert.equal(latestClaudeCacheTtlMinutes(jsonl), 60);
  });

  it('ignores sidechain requests and user lines that quote subagent usage', () => {
    const quoted = JSON.stringify({
      type: 'user',
      message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 77 } } },
    });
    const jsonl = [
      assistant({ ephemeral_1h_input_tokens: 961, ephemeral_5m_input_tokens: 0 }),
      assistant({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 50 }, { isSidechain: true }),
      quoted,
    ].join('\n');
    assert.equal(latestClaudeCacheTtlMinutes(jsonl), 60);
  });

  it('returns null when no request reported a cache write', () => {
    assert.equal(latestClaudeCacheTtlMinutes(assistant(null)), null);
    assert.equal(latestClaudeCacheTtlMinutes('not json\n'), null);
  });
});
