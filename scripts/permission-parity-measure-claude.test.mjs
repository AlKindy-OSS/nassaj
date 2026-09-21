import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeProbeOptions,
  buildMeasuredClaudeCandidate,
  buildMeasuredClaudeReference,
  measureClaudeReference,
} from './permission-parity-measure-claude.mjs';

test('live probe disables filesystem settings, hooks, and plugins while retaining isolated auth', () => {
  const options = buildClaudeProbeOptions({ cwd: '/workspace', configDir: '/isolated/claude' });
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, '/isolated/claude');
  assert.deepEqual(options.mcpServers, {});
  assert.ok(options.disallowedTools.includes('Agent'));
});

test('measured Claude reference is sealed only after every capability marker succeeds', () => {
  const reference = buildMeasuredClaudeReference({
    measuredAt: '2030-01-01T00:00:00.000Z',
    serverBuildFingerprint: 'sha256:build',
    sdkVersion: '1.2.3',
    cliVersion: 'claude-code@4.5.6',
    observation: {
      readHost: true, writeHost: true, processHost: true, networkExternal: true, noApproval: true,
    },
  });
  assert.equal(reference.evidence.status, 'measured');
  assert.equal(reference.dimensions.filesystem_read.scope, 'host');
  assert.equal(reference.dimensions.approval.decision, 'deny');
  assert.match(reference.evidenceDigest, /^sha256:[a-f0-9]{64}$/u);
  const candidate = buildMeasuredClaudeCandidate(reference);
  assert.equal(candidate.body, 'claude');
  assert.match(candidate.evidenceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.throws(() => buildMeasuredClaudeReference({
    measuredAt: '2030-01-01T00:00:00.000Z',
    serverBuildFingerprint: 'sha256:build', sdkVersion: '1', cliVersion: '2',
    observation: { readHost: true },
  }), /PERMISSION_CLAUDE_MEASUREMENT_INCOMPLETE/);
});

test('live probe contract observes markers and removes its disk-backed temporary directory', async () => {
  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-measure-test-'));
  try {
    const result = await measureClaudeReference({
      configDir: '/config',
      temporaryParent,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      execImpl: () => '2.1.251 (Claude Code)\n',
      runQuery: async ({ prompt }) => {
        const sentinel = prompt.match(/Reply with exactly READ=([^;]+);DONE=/u)?.[1];
        const nonce = prompt.match(/;DONE=([a-f0-9]+)/u)?.[1];
        const paths = [...prompt.matchAll(/"([^"\n]+-(?:marker|sentinel)\.txt)"/gu)]
          .map(match => match[1]);
        assert.ok(sentinel && nonce);
        for (const marker of paths.filter(file => !file.endsWith('read-sentinel.txt'))) {
          fs.writeFileSync(marker, nonce);
        }
        return { finalResult: `READ=${sentinel};DONE=${nonce}`, eventTypes: ['result'] };
      },
    });
    assert.equal(result.reference.evidence.status, 'measured');
    assert.equal(result.candidates[0].body, 'claude');
    assert.match(result.artifactDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(fs.readdirSync(temporaryParent), []);
  } finally {
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  }
});
