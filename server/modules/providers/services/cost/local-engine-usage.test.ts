/** Unit cases of the local-engine accounting rules (T-2103). */

import assert from 'node:assert/strict';
import test from 'node:test';

import { priceModelUsage } from './cost-calculator.js';
import { LOCAL_USAGE_CARRIER, localizeSessionUsage, localUsageLabel } from './local-engine-usage.js';
import { resolveModelVendor, vendorDisplayName, vendorHarnesses } from './model-vendor.js';
import type { SessionUsage } from './usage-extractors.js';

const totals = { input: 1_000, output: 500, cacheWrite5m: 10, cacheWrite1h: 20, cacheRead: 30 };

const usage = (): SessionUsage => ({
  provider: 'claude',
  perModel: [{ model: 'gpt-5.6-sol', totals, requests: 2 }],
  subagentRequests: 0,
  workDurationMs: null,
  skipped: { synthetic: 0, duplicates: 0 },
  requests: [{ uuid: 'r1', model: 'gpt-5.6-sol', timestampMs: 1, isSubagent: false, totals }],
});

test('a local label is priced at exactly zero, measured and not assumed', () => {
  const priced = priceModelUsage({ model: localUsageLabel('gpt-5.6-sol'), totals, requests: 2 });
  assert.equal(priced.costUsd, 0);
  assert.equal(priced.unpricedTokens, 0);
  assert.equal(priced.assumedPrice, false);
  assert.deepEqual(priced.tokens, totals);
});

test('the local namespace resolves to the local vendor whatever the body or model name', () => {
  for (const harness of ['claude', 'codex', 'dsh', 'opencode']) {
    assert.equal(resolveModelVendor(localUsageLabel('deepseek-v4-flash'), harness), 'local');
  }
  // An OpenCode local provider id already carries the reserved prefix.
  assert.equal(resolveModelVendor('nassaj_local_abc/gpt-oss-20b', 'opencode'), 'local');
  assert.equal(resolveModelVendor('gpt-oss-20b', 'opencode'), 'openai', 'control: no prefix, no local');
  assert.equal(vendorDisplayName('local'), 'Local models');
  assert.deepEqual(vendorHarnesses('local'), []);
});

test('the local label never carries a server id and is idempotent', () => {
  assert.equal(localUsageLabel('qwen3-coder'), `${LOCAL_USAGE_CARRIER}/qwen3-coder`);
  assert.equal(localUsageLabel(localUsageLabel('qwen3-coder')), localUsageLabel('qwen3-coder'));
});

test('localizing relabels every model and request of a local session and nothing else', () => {
  const cloud = usage();
  assert.equal(localizeSessionUsage(cloud, false), cloud);

  const local = localizeSessionUsage(cloud, true);
  assert.equal(local.perModel[0].model, localUsageLabel('gpt-5.6-sol'));
  assert.equal(local.requests?.[0].model, localUsageLabel('gpt-5.6-sol'));
  assert.equal(local.perModel[0].requests, 2, 'usage itself is kept');
  assert.equal(cloud.perModel[0].model, 'gpt-5.6-sol', 'the input is not mutated');
});
