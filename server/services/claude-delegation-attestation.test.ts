import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareClaudeReviewedDelegation, verifiedClaudeExecutable, REVIEWED_CLAUDE_SHA256 } from './claude-delegation-admission.js';

const sample = async () => ({ cpuPercent: 1, memoryPercent: 2, measuredAt: 1000 });
function options() { return { env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '99' }, pathToClaudeCodeExecutable: 'claude', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }; }

test('verified launch pins path, omits breadth env and preserves existing hooks', async () => {
  const value = options(); const original = value.hooks.PreToolUse[0];
  assert.equal(await prepareClaudeReviewedDelegation(value, 'delegate_review', { sample, now: () => 1000, verify: async () => '/verified/claude' }), true);
  assert.equal(value.pathToClaudeCodeExecutable, '/verified/claude');
  assert.equal(value.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '10');
  assert.equal(Object.hasOwn(value.env, 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'), false);
  assert.strictEqual(value.hooks.PreToolUse[0], original);
  assert.equal(value.hooks.PreToolUse.length, 2);
});

test('unverified builds, stale samples and unknown level retain original options', async () => {
  for (const kind of ['mismatch', 'throw', 'stale', 'cpu80', 'unknown']) {
    const value = options(); const before = structuredClone(value);
    const ok = await prepareClaudeReviewedDelegation(value, kind === 'unknown' ? { verified: true } : 'delegate_review', {
      now: () => 1000,
      sample: async () => ({ cpuPercent: kind === 'cpu80' ? 80 : 1, memoryPercent: 2, measuredAt: kind === 'stale' ? -1 : 1000 }),
      verify: async () => { if (kind === 'throw') throw Error('private'); return null; },
    });
    assert.equal(ok, false); assert.deepEqual(value, before);
  }
});

test('file verification resolves realpath and refuses mismatch, mutation, missing and hash failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 't1601-attest-'));
  try {
    const file = path.join(dir, 'binary'); const link = path.join(dir, 'claude');
    await writeFile(file, 'fixture'); await symlink(file, link);
    assert.equal(await verifiedClaudeExecutable(link, {}, { hash: async () => REVIEWED_CLAUDE_SHA256 }), file);
    assert.equal(await verifiedClaudeExecutable(link, {}), null);
    assert.equal(await verifiedClaudeExecutable(link, {}, { hash: async () => { await writeFile(file, 'changed bytes'); return REVIEWED_CLAUDE_SHA256; } }), null);
    assert.equal(await verifiedClaudeExecutable(link, {}, { hash: async () => { throw Error('no'); } }), null);
    assert.equal(await verifiedClaudeExecutable(path.join(dir, 'missing'), {}), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
