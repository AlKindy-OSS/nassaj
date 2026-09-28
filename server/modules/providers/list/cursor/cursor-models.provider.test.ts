import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// B-1283: proves getSupportedModels flags every fallback path `degraded: true`
// (short cache TTL, re-probe soon) while a live success stays unflagged, and that
// the shared CURSOR_FALLBACK_MODELS constant is never mutated.
//
// The `cursor-agent` binary is replaced by a tiny fake script whose stdout and
// exit code the tests drive through env vars, so a real spawn exercises the exact
// close/error branches without touching node:child_process globally. A separate
// mutable path lets one test point at a missing binary (spawn 'error').

let root = '';
let fakeBinary = '';
let missingBinary = '';
let CursorProviderModels: typeof import('./cursor-models.provider.js').CursorProviderModels;
let CURSOR_FALLBACK_MODELS: typeof import('./cursor-models.provider.js').CURSOR_FALLBACK_MODELS;

const setCli = (stdout: string, exitCode: number): void => {
  process.env.FAKE_CURSOR_STDOUT = stdout;
  process.env.FAKE_CURSOR_EXIT = String(exitCode);
};

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cursor-models-degraded-'));
  fakeBinary = path.join(root, 'fake-cursor-agent');
  missingBinary = path.join(root, 'does-not-exist');
  await writeFile(
    fakeBinary,
    '#!/usr/bin/env node\n'
      + 'const out = process.env.FAKE_CURSOR_STDOUT || "";\n'
      + 'if (out) process.stdout.write(out);\n'
      + 'process.exit(Number(process.env.FAKE_CURSOR_EXIT || "0"));\n',
  );
  await chmod(fakeBinary, 0o755);

  // T-1873: the harness registry honours an absolute server CURSOR_PATH override.
  process.env.CURSOR_PATH = fakeBinary;

  ({ CursorProviderModels, CURSOR_FALLBACK_MODELS } = await import('./cursor-models.provider.js'));
});

after(async () => {
  delete process.env.FAKE_CURSOR_STDOUT;
  delete process.env.FAKE_CURSOR_EXIT;
  delete process.env.CURSOR_PATH;
  await rm(root, { recursive: true, force: true });
});

test('live catalog from a successful --list-models run is NOT flagged degraded', async () => {
  setCli('Available models\nmodel-a - Model A\nmodel-b - Model B (default)\n', 0);
  const result = await new CursorProviderModels().getSupportedModels();

  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['model-a', 'model-b']);
  assert.equal(result.DEFAULT, 'model-b');
  assert.notEqual(result.degraded, true);
});

test('empty/unparsable output falls back to the degraded catalog', async () => {
  setCli('', 0);
  const result = await new CursorProviderModels().getSupportedModels();

  assert.deepEqual(result, { ...CURSOR_FALLBACK_MODELS, degraded: true });
  assert.equal(result.degraded, true);
});

test('a non-zero exit falls back to the degraded catalog', async () => {
  setCli('', 3);
  const result = await new CursorProviderModels().getSupportedModels();

  assert.deepEqual(result, { ...CURSOR_FALLBACK_MODELS, degraded: true });
});

test('a missing binary (registry refusal) falls back to the degraded catalog', async () => {
  // A missing override is refused by the registry before any spawn (T-1873).
  process.env.CURSOR_PATH = missingBinary;
  try {
    const result = await new CursorProviderModels().getSupportedModels();
    assert.deepEqual(result, { ...CURSOR_FALLBACK_MODELS, degraded: true });
  } finally {
    process.env.CURSOR_PATH = fakeBinary;
  }
});

test('a resolved binary whose spawn fails ENOENT falls back to the degraded catalog', async () => {
  // Runnable to the registry (regular file, 0755) but its interpreter is
  // missing, so the spawn itself emits 'error' ENOENT after resolution.
  const brokenBinary = path.join(root, 'broken-cursor-agent');
  await writeFile(brokenBinary, '#!/nonexistent/interpreter\n');
  await chmod(brokenBinary, 0o755);
  process.env.CURSOR_PATH = brokenBinary;
  try {
    const result = await new CursorProviderModels().getSupportedModels();
    assert.deepEqual(result, { ...CURSOR_FALLBACK_MODELS, degraded: true });
  } finally {
    process.env.CURSOR_PATH = fakeBinary;
  }
});

test('the shared CURSOR_FALLBACK_MODELS constant is never mutated', async () => {
  setCli('', 0);
  const result = await new CursorProviderModels().getSupportedModels();

  // The degraded flag lives on a fresh object, not on the shared constant.
  assert.notEqual(result, CURSOR_FALLBACK_MODELS);
  assert.notEqual(CURSOR_FALLBACK_MODELS.degraded, true);
});
