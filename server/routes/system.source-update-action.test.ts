/**
 * B-1583: writer ↔ reader contract for `activation-action.json`. The action is
 * built by the updater's own builder (with and without `previousRuntimeOid`)
 * and must pass the command-board reader that gates the safe restart; the
 * recovery reader shares the same shape rule, so the two cannot drift again.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.JWT_SECRET = 'source-update-action-contract-secret-0123456789';
const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'source-update-action-'));
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { readCanonicalSourceUpdateAction } = await import('./system.js');
const { buildSourceUpdateAction, isSourceUpdateActionShape } = await import('../../scripts/lib/source-update-action-schema.mjs');

const BUILD = 'b'.repeat(64);

function candidate(t: test.TestContext, overrides: Record<string, unknown> = {}, raw?: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(sandbox, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidateRoot = path.join(fs.realpathSync(root), 'tx-contract');
  fs.mkdirSync(candidateRoot);
  const action = raw ?? buildSourceUpdateAction({
    transactionId: 'tx-contract', originalHead: 'a'.repeat(40), targetCommit: 'c'.repeat(40),
    version: '1.0.0.1', manifestPath: path.join(candidateRoot, 'candidate-manifest.json'),
    manifestSha256: 'd'.repeat(64), expectedServerBuildId: BUILD, ...overrides,
  });
  const file = path.join(candidateRoot, 'activation-action.json');
  // Same bytes and mode the updater writes.
  fs.writeFileSync(file, `${JSON.stringify(action)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { file, candidateRoot, action };
}

test('an action without previousRuntimeOid passes the strict reader', (t) => {
  const { file, candidateRoot, action } = candidate(t);
  assert.equal(Object.hasOwn(action, 'previousRuntimeOid'), false);
  const read = readCanonicalSourceUpdateAction(file, candidateRoot, BUILD);
  assert.equal(read?.targetCommit, 'c'.repeat(40));
});

test('an action carrying previousRuntimeOid (B-1264) passes the strict reader', (t) => {
  const { file, candidateRoot, action } = candidate(t, { previousRuntimeOid: 'e'.repeat(40) });
  assert.equal(action.previousRuntimeOid, 'e'.repeat(40));
  const read = readCanonicalSourceUpdateAction(file, candidateRoot, BUILD);
  assert.equal(read?.previousRuntimeOid, 'e'.repeat(40));
});

test('the builder drops a malformed previousRuntimeOid instead of persisting it', () => {
  for (const value of [null, '', 'not-a-commit', 'E'.repeat(40), 'e'.repeat(39)]) {
    const action = buildSourceUpdateAction({ transactionId: 'tx', originalHead: 'a'.repeat(40), targetCommit: 'c'.repeat(40),
      version: '1', manifestPath: '/m', manifestSha256: 'd'.repeat(64), expectedServerBuildId: BUILD, previousRuntimeOid: value });
    assert.equal(Object.hasOwn(action, 'previousRuntimeOid'), false, String(value));
  }
});

test('a malformed previousRuntimeOid is still rejected', (t) => {
  const base = buildSourceUpdateAction({ transactionId: 'tx-contract', originalHead: 'a'.repeat(40),
    targetCommit: 'c'.repeat(40), version: '1', manifestPath: 'x', manifestSha256: 'd'.repeat(64),
    expectedServerBuildId: BUILD });
  for (const extra of [{ previousRuntimeOid: 'not-a-commit' }, { previousRuntimeOid: null }]) {
    const fixture = candidate(t, {}, { ...base, ...extra });
    const raw = { ...fixture.action, manifestPath: path.join(fixture.candidateRoot, 'candidate-manifest.json') };
    fs.writeFileSync(fixture.file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    assert.throws(() => readCanonicalSourceUpdateAction(fixture.file, fixture.candidateRoot, BUILD),
      /source_update_action_invalid/, JSON.stringify(extra));
  }
});

test('T-2004: an unknown key and a newer minor id pass the reader (open world)', (t) => {
  const { file, candidateRoot, action } = candidate(t);
  const raw = { ...action, schema: 'nassaj-source-update-activation/v1.3', addedLater: { any: 'shape' } };
  fs.writeFileSync(file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
  const read = readCanonicalSourceUpdateAction(file, candidateRoot, BUILD);
  assert.equal(read?.targetCommit, 'c'.repeat(40));
});

test('T-2004: a newer major is refused by name, even for another build', (t) => {
  const { file, candidateRoot, action } = candidate(t);
  fs.writeFileSync(file, `${JSON.stringify({ ...action, schema: 'nassaj-source-update-activation/v2' })}\n`, { mode: 0o600 });
  for (const build of [BUILD, 'f'.repeat(64)]) {
    assert.throws(() => readCanonicalSourceUpdateAction(file, candidateRoot, build), /source_update_action_schema_unsupported/);
  }
});

test('a missing required key is rejected', (t) => {
  const { file, candidateRoot, action } = candidate(t);
  const { originalHead: _dropped, ...rest } = action;
  fs.writeFileSync(file, `${JSON.stringify(rest)}\n`, { mode: 0o600 });
  assert.throws(() => readCanonicalSourceUpdateAction(file, candidateRoot, BUILD), /source_update_action_invalid/);
});

test('another build\'s action is ignored, not rejected', (t) => {
  const { file, candidateRoot } = candidate(t);
  assert.equal(readCanonicalSourceUpdateAction(file, candidateRoot, 'f'.repeat(64)), null);
});

test('parity: the shared shape accepts exactly what the builder emits', () => {
  const args = { transactionId: 'tx', originalHead: 'a'.repeat(40), targetCommit: 'c'.repeat(40), version: '1',
    manifestPath: '/m', manifestSha256: 'd'.repeat(64), expectedServerBuildId: BUILD };
  assert.equal(isSourceUpdateActionShape(buildSourceUpdateAction(args)), true);
  assert.equal(isSourceUpdateActionShape(buildSourceUpdateAction({ ...args, previousRuntimeOid: 'e'.repeat(40) })), true);
  // Key order is part of the activation identity hash; it must not change.
  assert.deepEqual(Object.keys(buildSourceUpdateAction({ ...args, previousRuntimeOid: 'e'.repeat(40) })), [
    'schema', 'transactionId', 'originalHead', 'targetCommit', 'version', 'manifestPath', 'manifestSha256',
    'expectedServerBuildId', 'previousRuntimeOid',
  ]);
});

test('golden: a 2.3.1.0 writer\'s exact bytes keep their activation identity hash', () => {
  const { createHash } = crypto;
  const args = {
    transactionId: 'update-golden-0001', originalHead: '1'.repeat(40), targetCommit: '2'.repeat(40), version: '2.3.1.0',
    manifestPath: '/srv/app/.git/nassaj-source-update/candidates/update-golden-0001/candidate-manifest.json',
    manifestSha256: '3'.repeat(64), expectedServerBuildId: '4'.repeat(64),
  };
  const identity = (action: object) => createHash('sha256').update(JSON.stringify(action)).digest('hex');
  // Pinned from the object literal source-updater.js wrote before the shared builder existed.
  assert.equal(identity(buildSourceUpdateAction({ ...args, previousRuntimeOid: '5'.repeat(40) })),
    'db05e4ff4522774f1debeaee1ad1b68f6993546f0a8ce729c3bd4c638518c67d');
  assert.equal(identity(buildSourceUpdateAction({ ...args, previousRuntimeOid: null })),
    '8ac9fc01a9f1279743a10783d25d7b4a735e76175f832b3fe9015a5628158dca');
});

test('a non-string field never coerces into a valid shape', () => {
  const args = { transactionId: 'tx', originalHead: 'a'.repeat(40), targetCommit: 'c'.repeat(40), version: '1',
    manifestPath: '/m', manifestSha256: 'd'.repeat(64), expectedServerBuildId: BUILD };
  assert.equal(isSourceUpdateActionShape({ ...buildSourceUpdateAction(args), transactionId: 12345 }), false);
  assert.equal(isSourceUpdateActionShape({ ...buildSourceUpdateAction(args), originalHead: ['a'.repeat(40)] }), false);
  assert.equal(isSourceUpdateActionShape({ ...buildSourceUpdateAction(args), previousRuntimeOid: ['e'.repeat(40)] }), false);
});
