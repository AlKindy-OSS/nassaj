/**
 * B-1616 (ADR-206 containment slice): the per-launch Codex multi-agent config, the
 * operator cap knob, the engine lookup and the tail gate.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_SINGLE_AGENT_CONFIG,
  codexConfigArgv,
  codexMultiAgentConfig,
  codexRunMayDelegate,
  resolveCodexAgentCap,
  resolveCodexMultiAgentEngine,
} from '../codex-multi-agent.js';

// Owner decision 2026-10-13: no sub-agent count cap from Nassaj; Codex decides.
test('by default no thread-cap key is set: Codex\'s own default or the user config decides', () => {
  assert.equal(resolveCodexAgentCap({}), null);
  assert.deepEqual({ ...codexMultiAgentConfig(resolveCodexAgentCap({})) }, { 'features.multi_agent': false });
  assert.deepEqual(codexConfigArgv(codexMultiAgentConfig(null)), ['--config', 'features.multi_agent=false']);
  assert.ok(Object.isFrozen(codexMultiAgentConfig(null)));
});

test('NASSAJ_CODEX_AGENT_CAP is an optional override: any positive integer, else no override', () => {
  const valid: Array<[string, number]> = [['1', 1], ['4', 4], [' 7 ', 7], ['16', 16], ['17', 17], ['1000', 1000], ['007', 7]];
  for (const [raw, expected] of valid) assert.equal(resolveCodexAgentCap({ NASSAJ_CODEX_AGENT_CAP: raw }), expected, raw);
  for (const raw of ['', '0', '-2', '2.5', '1e1', '0x4', 'three', '4 4', '9007199254740992', undefined]) {
    assert.equal(resolveCodexAgentCap({ NASSAJ_CODEX_AGENT_CAP: raw }), null, String(raw));
  }
});

test('an override pins both thread keys (v2 wins over agents.*); an invalid direct cap pins nothing', () => {
  assert.deepEqual({ ...codexMultiAgentConfig(1) }, { 'features.multi_agent': false,
    'agents.max_concurrent_threads_per_session': 1, 'features.multi_agent_v2.max_concurrent_threads_per_session': 2 });
  assert.equal(codexMultiAgentConfig(40)['features.multi_agent_v2.max_concurrent_threads_per_session'], 41);
  for (const bad of [0, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual({ ...codexMultiAgentConfig(bad) }, { 'features.multi_agent': false }, String(bad));
  }
});

test('the single-agent config leaves only the root slot on v2 and argv renders TOML scalars', () => {
  assert.deepEqual(codexConfigArgv(CODEX_SINGLE_AGENT_CONFIG), [
    '--config', 'features.multi_agent=false',
    '--config', 'agents.max_concurrent_threads_per_session=1',
    '--config', 'features.multi_agent_v2.max_concurrent_threads_per_session=1',
  ]);
});

test('the tail gate: always on v2 and unknown, on v1 only when the v1 flag is on, never on none', () => {
  const off = codexMultiAgentConfig(null);
  const on = { ...off, 'features.multi_agent': true };
  assert.equal(codexRunMayDelegate('v2', off), true);
  assert.equal(codexRunMayDelegate('unknown', off), true);
  assert.equal(codexRunMayDelegate('v1', off), false);
  assert.equal(codexRunMayDelegate('v1', on), true);
  assert.equal(codexRunMayDelegate('none', off), false);
  assert.equal(codexRunMayDelegate('none', on), false);
});

test('the engine comes from the run home catalog; anything unreadable is unknown', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-engine-'));
  try {
    const file = path.join(home, 'models_cache.json');
    assert.equal(await resolveCodexMultiAgentEngine(home, 'gpt-6-astra'), 'unknown', 'no catalog');
    writeFileSync(file, JSON.stringify({ models: [
      { slug: 'gpt-6-astra', multi_agent_version: 'v2' },
      { slug: 'gpt-5.6-luna', multi_agent_version: 'v1' },
      { slug: 'gpt-5.5' },
      { slug: 'future', multi_agent_version: 'v3' },
    ] }));
    assert.equal(await resolveCodexMultiAgentEngine(home, 'gpt-6-astra'), 'v2');
    assert.equal(await resolveCodexMultiAgentEngine(home, 'gpt-5.6-luna'), 'v1');
    assert.equal(await resolveCodexMultiAgentEngine(home, 'gpt-5.5'), 'none');
    assert.equal(await resolveCodexMultiAgentEngine(home, 'future'), 'unknown');
    assert.equal(await resolveCodexMultiAgentEngine(home, 'unlisted'), 'unknown');
    assert.equal(await resolveCodexMultiAgentEngine(home, undefined), 'unknown', 'config default model');
    assert.equal(await resolveCodexMultiAgentEngine(null, 'gpt-6-astra'), 'unknown');
    // A rewritten catalog is re-read (cache keyed by inode/size/mtime).
    writeFileSync(file, JSON.stringify({ models: [{ slug: 'gpt-6-astra', multi_agent_version: 'v1' }] }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(await resolveCodexMultiAgentEngine(home, 'gpt-6-astra'), 'v1');
    writeFileSync(file, '{not json');
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    assert.equal(await resolveCodexMultiAgentEngine(home, 'gpt-6-astra'), 'unknown', 'malformed');
    const other = mkdtempSync(path.join(os.tmpdir(), 'codex-engine-link-'));
    try {
      writeFileSync(path.join(other, 'real.json'), JSON.stringify({ models: [{ slug: 'm', multi_agent_version: 'v1' }] }));
      symlinkSync(path.join(other, 'real.json'), path.join(other, 'models_cache.json'));
      assert.equal(await resolveCodexMultiAgentEngine(other, 'm'), 'unknown', 'a symlinked catalog is not followed');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// qa VETO item 2 (B-1616): the catalog is read through one pinned no-follow descriptor
// with a bounded read, so nothing planted between a stat and a by-name read is consumed.
test('a hard-linked catalog is refused (single-link pinned open), the same file alone is read', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-engine-link-'));
  try {
    const file = path.join(home, 'models_cache.json');
    writeFileSync(file, JSON.stringify({ models: [{ slug: 'm', multi_agent_version: 'v1' }] }));
    linkSync(file, path.join(home, 'second-name.json'));
    assert.equal(await resolveCodexMultiAgentEngine(home, 'm'), 'unknown');
    unlinkSync(path.join(home, 'second-name.json'));
    assert.equal(await resolveCodexMultiAgentEngine(home, 'm'), 'v1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the read is bounded to 8 MB and bound to the opened descriptor, not the name', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-engine-bound-'));
  try {
    const file = path.join(home, 'models_cache.json');
    const catalog = JSON.stringify({ models: [{ slug: 'm', multi_agent_version: 'v2' }] });
    writeFileSync(file, catalog);
    // Grows past the cap after the descriptor's fstat: refused, never read to the end.
    const grown = await resolveCodexMultiAgentEngine(home, 'm', {
      beforeRead: () => { appendFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)); },
    });
    assert.equal(grown, 'unknown');
    writeFileSync(file, catalog);
    utimesSync(file, new Date(), new Date(Date.now() + 20_000));
    // The name is swapped for a symlink after the open: the opened file is what is read.
    const other = path.join(home, 'planted.json');
    writeFileSync(other, JSON.stringify({ models: [{ slug: 'm', multi_agent_version: 'v1' }] }));
    const swapped = await resolveCodexMultiAgentEngine(home, 'm', {
      beforeRead: () => { unlinkSync(file); symlinkSync(other, file); },
    });
    assert.equal(swapped, 'v2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
