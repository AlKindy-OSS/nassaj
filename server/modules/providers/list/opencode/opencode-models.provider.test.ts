import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';

// B-1283: proves getSupportedModels flags every fallback path `degraded: true`
// while a live success stays unflagged, and that OPENCODE_FALLBACK_MODELS is never
// mutated. The `opencode` binary is replaced by a fake whose stdout/exit code the
// tests drive, so a real spawn runs the exact close/error branches. The carrier
// flag is left OFF (default), so the fallback is byte-for-byte OPENCODE_FALLBACK_MODELS
// plus the degraded flag.

let root = '';
let fakeBinary = '';
let missingBinary = '';
let OpenCodeProviderModels: typeof import('./opencode-models.provider.js').OpenCodeProviderModels;
let OPENCODE_FALLBACK_MODELS: typeof import('./opencode-models.provider.js').OPENCODE_FALLBACK_MODELS;

const setCli = (stdout: string, exitCode: number): void => {
  process.env.FAKE_OPENCODE_STDOUT = stdout;
  process.env.FAKE_OPENCODE_EXIT = String(exitCode);
};

before(async () => {
  delete process.env.NASSAJ_OPENCODE_CARRIER;
  root = await mkdtemp(path.join(os.tmpdir(), 'opencode-models-degraded-'));
  fakeBinary = path.join(root, 'fake-opencode');
  missingBinary = path.join(root, 'does-not-exist');
  await writeFile(
    fakeBinary,
    '#!/usr/bin/env node\n'
      + 'const out = process.env.FAKE_OPENCODE_STDOUT || "";\n'
      + 'if (out) process.stdout.write(out);\n'
      + 'process.exit(Number(process.env.FAKE_OPENCODE_EXIT || "0"));\n',
  );
  await chmod(fakeBinary, 0o755);

  const realUtils = await import('@/shared/utils.js');
  mock.module('@/shared/utils.js', {
    namedExports: {
      ...realUtils,
      resolveOpenCodeBinaryPath: () => (process.env.FAKE_OPENCODE_USE_MISSING === '1' ? missingBinary : fakeBinary),
    },
  });

  ({ OpenCodeProviderModels, OPENCODE_FALLBACK_MODELS } = await import('./opencode-models.provider.js'));
});

after(async () => {
  delete process.env.FAKE_OPENCODE_STDOUT;
  delete process.env.FAKE_OPENCODE_EXIT;
  delete process.env.FAKE_OPENCODE_USE_MISSING;
  await rm(root, { recursive: true, force: true });
});

test('live catalog from a successful models run is NOT flagged degraded', async () => {
  setCli('anthropic/claude-sonnet-4-5\nopenai/gpt-5.1\n', 0);
  const result = await new OpenCodeProviderModels().getSupportedModels();

  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.1']);
  assert.notEqual(result.degraded, true);
});

test('no parsed ids falls back to the degraded catalog', async () => {
  setCli('some banner text with no model ids\n', 0);
  const result = await new OpenCodeProviderModels().getSupportedModels();

  assert.equal(result.degraded, true);
  assert.deepEqual(result.OPTIONS, OPENCODE_FALLBACK_MODELS.OPTIONS);
  assert.equal(result.DEFAULT, OPENCODE_FALLBACK_MODELS.DEFAULT);
});

test('a non-zero exit falls back to the degraded catalog', async () => {
  setCli('', 2);
  const result = await new OpenCodeProviderModels().getSupportedModels();

  assert.equal(result.degraded, true);
  assert.deepEqual(result.OPTIONS, OPENCODE_FALLBACK_MODELS.OPTIONS);
});

test('a missing binary (spawn error) falls back to the degraded catalog', async () => {
  process.env.FAKE_OPENCODE_USE_MISSING = '1';
  try {
    const result = await new OpenCodeProviderModels().getSupportedModels();
    assert.equal(result.degraded, true);
    assert.deepEqual(result.OPTIONS, OPENCODE_FALLBACK_MODELS.OPTIONS);
  } finally {
    delete process.env.FAKE_OPENCODE_USE_MISSING;
  }
});

test('the shared OPENCODE_FALLBACK_MODELS constant is never mutated', async () => {
  setCli('', 0);
  const result = await new OpenCodeProviderModels().getSupportedModels();

  assert.notEqual(result, OPENCODE_FALLBACK_MODELS);
  assert.notEqual(OPENCODE_FALLBACK_MODELS.degraded, true);
});
