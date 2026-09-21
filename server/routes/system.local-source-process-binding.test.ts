import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.JWT_SECRET = 'local-source-binding-test-secret-0123456789';
const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'source-process-binding-'));
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { assertLocalSourceActivationProcessBinding } = await import('./system.js');
const { hashTree } = await import('../../scripts/lib/source-update-tree-identity.mjs');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(sandbox, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['dist', 'dist-server', 'node_modules']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const oid = 'a'.repeat(40), build = 'b'.repeat(64), tx = 'tx-binding';
  fs.writeFileSync(path.join(root, 'dist/BUILD_PROVENANCE.json'), JSON.stringify({ commit: oid, buildId: build }));
  fs.writeFileSync(path.join(root, 'dist-server/BUILD_PROVENANCE.json'), JSON.stringify({ commit: oid, buildId: build }));
  fs.writeFileSync(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), '{}');
  fs.writeFileSync(path.join(root, 'node_modules/fixture'), 'old');
  const candidateRoot = path.join(root, '.git/nassaj-source-update/candidates', tx); fs.mkdirSync(candidateRoot, { recursive: true });
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  const manifest = { schemaVersion: 1, txId: tx, operationBinding: { schema: 'nassaj-local-source-recovery-operation/v1',
    root, nodeIdentity: os.hostname(), transactionId: tx, previousRuntime: { pid: process.pid, startTicks, oid,
      serverBuildId: build, clientBuildId: build, controlManifestSha256: sha('{}'), actualTrees: {
        client: hashTree(path.join(root, 'dist')), server: hashTree(path.join(root, 'dist-server')),
        nodeModules: hashTree(path.join(root, 'node_modules')) } } } };
  const manifestPath = path.join(candidateRoot, 'candidate-manifest.json'), bytes = JSON.stringify(manifest);
  fs.writeFileSync(manifestPath, bytes, { mode: 0o600 });
  const action = { transactionId: tx, candidateRoot, manifestPath, manifestSha256: sha(bytes) };
  const injected = { pid: process.pid, readProcessStat: () => stat, processCwd: root, processUid: process.getuid() };
  return { root, action, injected, manifest, manifestPath };
}

test('local source activation accepts one exact process/tree binding and rejects drift before effects', t => {
  const value = fixture(t), effects: string[] = [];
  const bound = assertLocalSourceActivationProcessBinding(value.action, value.injected);
  assert.equal(bound.pid, process.pid); assert.equal(bound.root, value.root); assert.deepEqual(effects, []);
  for (const mutate of [
    () => ({ ...value.injected, pid: process.pid + 100000 }),
    () => ({ ...value.injected, readProcessStat: () => value.injected.readProcessStat().replace(` ${bound.startTicks} `, ` ${Number(bound.startTicks) + 1} `) }),
    () => ({ ...value.injected, processUid: process.getuid() + 1 }),
    () => ({ ...value.injected, processCwd: path.dirname(value.root) }),
  ]) {
    assert.throws(() => assertLocalSourceActivationProcessBinding(value.action, mutate()), /local_recovery_activation_process_changed/);
    assert.deepEqual(effects, []);
  }
  fs.writeFileSync(path.join(value.root, 'dist/BUILD_PROVENANCE.json'), '{"changed":true}');
  assert.throws(() => assertLocalSourceActivationProcessBinding(value.action, value.injected), /local_recovery_activation_runtime_changed/);
  assert.deepEqual(effects, []);
});

test('process binding call remains before activation state, maintenance, and tree effects', () => {
  const source = fs.readFileSync(new URL('./system.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function executeSourceUpdateActivation'), source.indexOf('\nexport ', source.indexOf('export async function executeSourceUpdateActivation') + 10));
  const binding = body.indexOf('assertLocalSourceActivationProcessBinding(action)');
  assert.ok(binding >= 0);
  for (const effect of ['transitionActivation(', 'maintenance.beginUpdate(', 'exchangeGenerations(']) {
    const offset = body.indexOf(effect); assert.ok(offset > binding, `${effect} must follow the process binding fence`);
  }
});
