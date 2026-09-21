import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  candidateFailureCode,
  classifyServerCandidate,
  classifyServerInput,
  inspectServerCandidate,
  inspectServerActivationCandidate,
  inspectLegacyRestartDisposition,
  setLocalUpdateRuntimeIdentity,
  prepareActivationTransaction,
  readActivationTransaction,
  transitionActivationTransaction,
} from './local-preview-server-control.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const sha = (value: string) => ({ path: value, sha256: 'c'.repeat(64) });
const CONTROL_FILES = new Map([
  ['scripts/local-preview-server-activation.mjs', 'activation-control'],
  ['scripts/local-preview-ledger.mjs', 'ledger-control'],
  ['scripts/safe-restart.sh', 'restart-control'],
]);
const controlInputs = () => [...CONTROL_FILES].map(([file, contents]) => ({
  path: file, sha256: crypto.createHash('sha256').update(contents).digest('hex'),
}));
const manifest = (inputs: Array<{ path: string; sha256: string }>) => {
  const digest = crypto.createHash('sha256');
  for (const entry of [...inputs].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))) {
    digest.update(entry.path).update('\0').update(entry.sha256).update('\0');
  }
  return { schemaVersion: 1, buildId: digest.digest('hex'), inputs };
};

test('broken OID request entry fails closed and never falls through to legacy classification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-oid-control-'));
  try {
    const initialized = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const resolved = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8' });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout.trim(), path.join(root, '.git'), 'never inspect an ancestor repository');
    const requestPath = path.join(root, '.git', 'nassaj-preview-oid-control-request-v1.json');
    assert.equal(path.join(resolved.stdout.trim(), path.basename(requestPath)), requestPath);
    fs.symlinkSync(path.join(root, 'missing-request'), requestPath);
    // The dangling entry is still a present OID request: control resolution fails
    // closed with a bounded code (d98c4855) and never reaches the legacy classifier.
    assert.deepEqual(inspectServerActivationCandidate(A, root), {
      allowed: false, code: 'candidate_evidence_invalid', activationKind: 'oid',
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const manifestV2 = (inputs: Array<{ path: string; mode: number; sha256: string }>) => {
  const digest = crypto.createHash('sha256');
  for (const entry of [...inputs].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))) {
    digest.update(entry.path).update('\0').update(String(entry.mode)).update('\0').update(entry.sha256).update('\0');
  }
  return { schemaVersion: 2, buildIdMode: 'path-mode-content-sha256', buildId: digest.digest('hex'), inputs };
};

test('classifier is fail-closed for sensitive, malformed, and unclassified inputs', () => {
  assert.equal(classifyServerInput('server/routes/system.js'), 'sensitive');
  assert.equal(classifyServerInput('server/middleware/auth.js'), 'sensitive');
  assert.equal(classifyServerInput('server/modules/database/schema.ts'), 'sensitive');
  assert.equal(classifyServerInput('server/modules/providers/services/token-store.ts'), 'sensitive');
  assert.equal(classifyServerInput('server/modules/providers/oidc.routes.ts'), 'sensitive');
  assert.equal(classifyServerInput('server/modules/providers/services/catalog.ts'), 'ordinary');
  assert.equal(classifyServerInput('server/new-kind.wasm'), 'unknown');
  assert.equal(classifyServerInput('../escape.js'), 'unknown');

  const loaded = manifest([sha('server/modules/projects/services/base.ts')]);
  const sensitiveManifest = manifest([
    sha('server/modules/projects/services/base.ts'), sha('server/modules/database/schema.ts'),
  ]);
  const sensitive = classifyServerCandidate({
    expectedBuildId: sensitiveManifest.buildId, loadedBuildId: loaded.buildId,
    loadedManifest: loaded,
    candidateManifest: sensitiveManifest,
  });
  assert.equal(sensitive.allowed, false);
  assert.equal(sensitive.code, 'sensitive_candidate');

  const unknownManifest = manifest([sha('server/new-kind.wasm')]);
  const unknown = classifyServerCandidate({
    expectedBuildId: unknownManifest.buildId, loadedBuildId: loaded.buildId, loadedManifest: loaded,
    candidateManifest: unknownManifest,
  });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.code, 'unknown_candidate');
  assert.equal(classifyServerCandidate({}).allowed, false);
});

test('candidate inspection binds ledger identity and manifests to the visible generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-control-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'dist-server'));
    const loadedManifest = manifest([sha('server/modules/projects/services/base.ts'), ...controlInputs()]);
    const candidateManifest = manifest([
      { path: 'server/modules/projects/services/base.ts', sha256: 'd'.repeat(64) }, ...controlInputs(),
    ]);
    const loadedId = loadedManifest.buildId;
    const candidateId = candidateManifest.buildId;
    fs.writeFileSync(path.join(root, '.git', 'nassaj-local-preview-ledger-v1.json'), JSON.stringify({
      schemaVersion: 1,
      serverSourceGeneration: 7,
      serverState: 'built',
      serverSourceBuildId: candidateId,
      serverCandidateBuildId: candidateId,
      serverPromotedBuildId: loadedId,
      serverLoadedBuildId: loadedId,
    }));
    const candidateDir = path.join(root, '.nassaj-local-preview', 'server-candidates', candidateId);
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(path.join(candidateDir, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId: candidateId }));
    fs.writeFileSync(path.join(candidateDir, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify(candidateManifest));
    fs.writeFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId: loadedId }));
    fs.writeFileSync(path.join(root, 'dist-server', 'SERVER_INPUT_MANIFEST.json'), JSON.stringify(loadedManifest));
    for (const directory of [candidateDir, path.join(root, 'dist-server')]) {
      for (const [file, contents] of CONTROL_FILES) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), contents);
      }
    }

    const inspected = inspectServerCandidate(candidateId, root);
    assert.equal(inspected.allowed, true);
    assert.equal(inspected.generation, 7);
    assert.equal(inspectServerCandidate('e'.repeat(64), root).code, 'superseded');
    fs.writeFileSync(path.join(root, '.git', 'nassaj-local-preview-ledger-v1.json'), JSON.stringify({
      schemaVersion: 1,
      serverSourceGeneration: 7,
      serverState: 'built',
      serverSourceBuildId: candidateId,
      serverCandidateBuildId: candidateId,
      serverPromotedBuildId: loadedId,
      serverLoadedBuildId: 'e'.repeat(64),
    }));
    const stale = inspectServerCandidate(candidateId, root);
    assert.equal(stale.code, 'loaded_artifact_unavailable');
    assert.equal(stale.onDiskBuildId, loadedId);
    fs.writeFileSync(path.join(root, '.git', 'nassaj-local-preview-ledger-v1.json'), JSON.stringify({
      schemaVersion: 1,
      serverSourceGeneration: 7,
      serverState: 'built',
      serverSourceBuildId: candidateId,
      serverCandidateBuildId: candidateId,
      serverPromotedBuildId: loadedId,
      serverLoadedBuildId: loadedId,
    }));
    fs.writeFileSync(path.join(candidateDir, 'scripts', 'safe-restart.sh'), 'tampered');
    assert.equal(inspectServerCandidate(candidateId, root).code, 'candidate_identity_mismatch');
    fs.writeFileSync(path.join(candidateDir, 'scripts', 'safe-restart.sh'), CONTROL_FILES.get('scripts/safe-restart.sh')!);
    fs.rmSync(path.join(root, 'dist-server', 'SERVER_INPUT_MANIFEST.json'));
    assert.equal(inspectServerCandidate(candidateId, root).code, 'candidate_evidence_missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate inspection accepts schema-v2 manifests with canonical bytewise path ordering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-control-v2-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'dist-server'));
    const controls = controlInputs().map((entry) => ({ ...entry, mode: 0o444 }));
    const uppercasePath = {
      path: 'server/modules/projects/README.md', mode: 0o444, sha256: 'd'.repeat(64),
    };
    const loadedManifest = manifestV2([
      { path: 'server/modules/projects/base.ts', mode: 0o444, sha256: 'a'.repeat(64) },
      uppercasePath, ...controls,
    ]);
    const candidateManifest = manifestV2([
      { path: 'server/modules/projects/base.ts', mode: 0o444, sha256: 'b'.repeat(64) },
      uppercasePath, ...controls,
    ]);
    assert.notDeepEqual(
      candidateManifest.inputs.map(({ path: inputPath }) => inputPath).sort(),
      candidateManifest.inputs.map(({ path: inputPath }) => inputPath).sort((left, right) => left.localeCompare(right)),
      'fixture must exercise a path order where locale collation differs from bytewise ordering',
    );
    const loadedId = loadedManifest.buildId;
    const candidateId = candidateManifest.buildId;
    fs.writeFileSync(path.join(root, '.git', 'nassaj-local-preview-ledger-v1.json'), JSON.stringify({
      schemaVersion: 1,
      serverSourceGeneration: 9,
      serverState: 'built',
      serverSourceBuildId: candidateId,
      serverCandidateBuildId: candidateId,
      serverPromotedBuildId: loadedId,
      serverLoadedBuildId: loadedId,
    }));
    const candidateDir = path.join(root, '.nassaj-local-preview', 'server-candidates', candidateId);
    fs.mkdirSync(candidateDir, { recursive: true });
    for (const [directory, buildId, inputManifest] of [
      [candidateDir, candidateId, candidateManifest],
      [path.join(root, 'dist-server'), loadedId, loadedManifest],
    ] as const) {
      fs.writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId }));
      fs.writeFileSync(path.join(directory, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify(inputManifest));
      for (const [file, contents] of CONTROL_FILES) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), contents);
      }
    }

    const inspected = inspectServerCandidate(candidateId, root);
    assert.equal(inspected.allowed, true);
    assert.equal(inspected.code, 'ordinary_candidate');
    assert.equal(inspected.generation, 9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activation transaction is durable, identity-fenced, and CAS-like', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-transaction-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    prepareActivationTransaction({
      allowed: true, expectedServerBuildId: B, loadedBuildId: A, generation: 8,
    }, 'request-1', root);
    assert.equal(readActivationTransaction(root)?.state, 'prepared');
    assert.equal(fs.statSync(path.join(root, '.git', 'nassaj-server-activation-v1.json')).mode & 0o777, 0o600);
    assert.equal(transitionActivationTransaction(B, ['prepared'], { state: 'guard_ready' }, root)?.state, 'guard_ready');
    assert.equal(transitionActivationTransaction(A, ['guard_ready'], { state: 'complete' }, root), null);
    assert.equal(readActivationTransaction(root)?.state, 'guard_ready');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate failure diagnostics classify safe causes without leaking internal paths', () => {
  const cases = [
    [Object.assign(new Error('/private/path'), { code: 'ENOENT' }), 'candidate_evidence_missing'],
    [Object.assign(new Error('/private/path'), { code: 'EACCES' }), 'candidate_evidence_unreadable'],
    [new SyntaxError('secret input'), 'candidate_evidence_invalid'],
    [new Error('OID owner control request was superseded or is not awaiting this exact candidate.'), 'oid_candidate_not_awaiting_owner'],
    [new Error('artifact_provenance_mismatch'), 'candidate_identity_mismatch'],
    [new Error('unrecognized private detail'), 'candidate_inspection_failed'],
  ] as const;
  for (const [error, expected] of cases) assert.equal(candidateFailureCode(error), expected);
});

test('new legacy activation is denied; only exact loaded maintenance and existing matching recovery remain', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'button-only-legacy-'));
  t.after(() => { setLocalUpdateRuntimeIdentity({}); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, '.git')); const live = path.join(root, 'dist-server'); fs.mkdirSync(live);
  const inputManifest = manifest(controlInputs()), buildId = inputManifest.buildId;
  fs.writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId }));
  fs.writeFileSync(path.join(live, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify(inputManifest));
  for (const [file, content] of CONTROL_FILES) { fs.mkdirSync(path.dirname(path.join(live, file)), { recursive: true }); fs.writeFileSync(path.join(live, file), content); }
  setLocalUpdateRuntimeIdentity({ serverLoadedBuildId: buildId });
  assert.equal(inspectLegacyRestartDisposition(buildId, null, root).activationKind, 'maintenance');
  assert.equal(inspectLegacyRestartDisposition(A, null, root).code, 'node_update_button_required');
  fs.writeFileSync(path.join(live, 'scripts/safe-restart.sh'), 'changed');
  assert.equal(inspectLegacyRestartDisposition(buildId, null, root).allowed, false);
  fs.writeFileSync(path.join(live, 'scripts/safe-restart.sh'), CONTROL_FILES.get('scripts/safe-restart.sh')!);
  prepareActivationTransaction({ allowed: true, expectedServerBuildId: A, loadedBuildId: buildId, generation: 1 }, 'existing-owner-row', root);
  const before = readActivationTransaction(root);
  assert.equal(inspectLegacyRestartDisposition(A, 'different-row', root).allowed, false);
  assert.equal(inspectLegacyRestartDisposition(A, 'existing-owner-row', root).activationKind, 'legacy-resume');
  assert.deepEqual(readActivationTransaction(root), before, 'inspection does not recreate or reset recovery');
  transitionActivationTransaction(A, ['prepared'], { state: 'complete' }, root);
  assert.equal(inspectLegacyRestartDisposition(A, 'existing-owner-row', root).allowed, false);
});
