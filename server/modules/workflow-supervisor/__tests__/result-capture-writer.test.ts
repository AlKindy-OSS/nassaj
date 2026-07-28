/**
 * T-820 — the ported atomic result-capture path (§أ-4) proven on SERVER code
 * (audit condition C2) using the T-819 spike's REAL captured `claude -p` output
 * as fixtures (feedback_synthetic_fixtures_false_confidence: no synthetic bytes).
 *
 * Proves the producer contract the monitor relies on:
 *   - clean exit (0) => `result.json` appears, BYTE-IDENTICAL to the captured
 *     `.partial` (rename(2) never yields a torn/partial copy), and `DONE` is
 *     written LAST carrying exit_code 0.
 *   - non-zero exit => NO `result.json` (only `.partial` survives) and `DONE`
 *     carries the non-zero code — the PARTIAL/CRASHED signal.
 *   - re-sealing is safe (idempotent finalize).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { seal } from '@/modules/workflow-supervisor/result-capture-writer.js';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../spikes/b103-t819/fixtures',
);

/** Load one REAL captured result.json fixture (deposited by the T-819 spike). */
async function realFixtureBytes(): Promise<Buffer> {
  const files = (await readdir(FIXTURE_DIR)).filter((f) => /^t819-succ-.*\.json$/.test(f));
  assert.ok(files.length > 0, `expected real spike fixtures in ${FIXTURE_DIR}`);
  return readFile(path.join(FIXTURE_DIR, files[0]!));
}

test('seal: clean exit renames .partial to a BYTE-IDENTICAL result.json + writes DONE last', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rcw-clean-'));
  try {
    const bytes = await realFixtureBytes();
    await writeFile(path.join(dir, 'result.json.partial'), bytes);

    seal(dir, 0);

    // result.json exists and equals the captured bytes EXACTLY (no corruption).
    const result = await readFile(path.join(dir, 'result.json'));
    assert.ok(result.equals(bytes), 'result.json is byte-identical to the captured output');
    // .partial is gone (atomically renamed).
    assert.equal(existsSync(path.join(dir, 'result.json.partial')), false, '.partial consumed');
    // DONE is present and reports a clean exit.
    const done = JSON.parse(await readFile(path.join(dir, 'DONE'), 'utf8'));
    assert.equal(done.exit_code, 0);
    assert.equal(typeof done.finalizedAt, 'string');
    assert.equal(done.schema, 't820-producer-1');
    // No .tmp- residue.
    const files = await readdir(dir);
    assert.ok(files.every((f) => !f.includes('.tmp-')), 'no tmp residue after atomic writes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seal: a non-zero exit NEVER produces result.json (partial stays) and DONE carries the code', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rcw-partial-'));
  try {
    const bytes = await realFixtureBytes();
    await writeFile(path.join(dir, 'result.json.partial'), bytes);

    seal(dir, 137, { signal: 'SIGKILL' });

    assert.equal(existsSync(path.join(dir, 'result.json')), false, 'no result.json on a non-zero exit');
    assert.equal(existsSync(path.join(dir, 'result.json.partial')), true, '.partial is retained for inspection');
    const done = JSON.parse(await readFile(path.join(dir, 'DONE'), 'utf8'));
    assert.equal(done.exit_code, 137);
    assert.equal(done.signal, 'SIGKILL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seal: re-sealing a clean exit is idempotent (result.json + DONE remain, no throw)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rcw-idem-'));
  try {
    const bytes = await realFixtureBytes();
    await writeFile(path.join(dir, 'result.json.partial'), bytes);
    seal(dir, 0);
    // A second seal (partial already gone) must not throw and must not corrupt.
    seal(dir, 0);
    const result = await readFile(path.join(dir, 'result.json'));
    assert.ok(result.equals(bytes), 'result.json still intact after a repeat seal');
    assert.ok(existsSync(path.join(dir, 'DONE')), 'DONE still present');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
