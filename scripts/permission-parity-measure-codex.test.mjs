import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  buildMeasuredCodexCandidate,
  measureCodexCandidate, defaultRunTurn,
  resolveMeasurementRuntime, readInstalledIdentity, identityDigest,
} from './permission-parity-measure-codex.mjs';

test('Codex candidate sealing rejects incomplete observations', () => {
  const complete = {
    readHost: true, writeHost: true, processHost: true, networkExternal: true, noApproval: true,
  };
  assert.match(buildMeasuredCodexCandidate({
    measuredAt: '2030-01-01T00:00:00.000Z', buildFingerprint: 'sha256:build', observation: complete,
  }).evidenceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.throws(() => buildMeasuredCodexCandidate({
    measuredAt: '2030-01-01T00:00:00.000Z', buildFingerprint: 'sha256:build',
    observation: { ...complete, networkExternal: false },
  }), /PERMISSION_CODEX_MEASUREMENT_INCOMPLETE:networkExternal/);
});

test('Codex probe reads markers and removes its temporary directory', async () => {
  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-codex-test-'));
  try {
    const result = await measureCodexCandidate({
      codexHome: '/codex-home', temporaryParent,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      execImpl: () => 'codex-cli 0.147.0',
      runTurn: async ({ prompt, executablePath, pathDirs }) => {
        assert.ok(path.isAbsolute(executablePath));
        assert.ok(Array.isArray(pathDirs));
        const nonce = prompt.match(/DONE=([a-f0-9]+)/u)?.[1];
        const commands = prompt.split('\n').slice(1);
        assert.ok(nonce);
        for (const command of commands) {
          const files = [...command.matchAll(/'([^'\n]+\.txt)'/gu)].map(match => match[1]);
          if (command.startsWith('cat ')) {
            fs.writeFileSync(files[1], fs.readFileSync(files[0], 'utf8'));
          } else if (files[0]) {
            fs.writeFileSync(files[0], nonce);
          }
        }
        return { finalResponse: `DONE=${nonce}` };
      },
    });
    assert.equal(result.candidate.body, 'codex');
    assert.deepEqual(fs.readdirSync(temporaryParent), []);
  } finally {
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  }
});

for (const field of ['serverSourceDigest', 'sdkVersion', 'cliVersion', 'nativeDigest', 'resolverDigest', 'sdkSourceDigest', 'pathClosure']) {
  test(`Codex probe refuses evidence if ${field} changes during measurement`, async () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-codex-drift-'));
    const identity = { serverSourceDigest: 'source-before', sdkVersion: '1.0.0', cliVersion: 'codex-cli 1.0.0' };
    let reads = 0;
    try {
      await assert.rejects(measureCodexCandidate({
        codexHome: '/codex-home', temporaryParent,
        readIdentity: () => (++reads === 1 ? identity : { ...identity, [field]: 'changed' }),
        runTurn: async () => ({ finalResponse: 'irrelevant: identity must be checked before sealing' }),
      }), /PERMISSION_CODEX_IDENTITY_CHANGED_DURING_MEASUREMENT/);
      assert.deepEqual(fs.readdirSync(temporaryParent), []);
    } finally {
      fs.rmSync(temporaryParent, { recursive: true, force: true });
    }
  });
}

test('Codex probe quotes shell metacharacters in its disk-backed paths literally', async () => {
  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "permission-codex-$(:)-`:`-'quote-"));
  try {
    const result = await measureCodexCandidate({
      codexHome: '/codex-home', temporaryParent, execImpl: () => 'codex-cli 0.147.0',
      runTurn: async ({ prompt, cwd }) => {
        const nonce = prompt.match(/DONE=([a-f0-9]+)/u)?.[1];
        const commands = prompt.split('\n').slice(1);
        for (const command of commands) {
          // Execute the exact generated shell, replacing only the external HTTP call.
          execFileSync('sh', ['-c', command.replace('curl -fsS --max-time 15 https://example.com/ >/dev/null', 'true')], { cwd });
        }
        return { finalResponse: `DONE=${nonce}` };
      },
    });
    assert.equal(result.probeSummary.readHost, true);
    assert.equal(result.probeSummary.writeHost, true);
    assert.deepEqual(fs.readdirSync(temporaryParent), []);
  } finally {
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  }
});


test('compiled runtime measurement matches compiled registry instead of source byte fingerprints', async () => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const artifactParent = path.join(project, '.artifacts');
  fs.mkdirSync(artifactParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifactParent, 'codex-compiled-proof-'));
  const emit = relative => {
    const source = fs.readFileSync(path.join(project, relative), 'utf8');
    const target = path.join(root, relative.replace(/\.ts$/u, '.js'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
  };
  try {
    for (const filename of ['server/shared/codex-executable.js', 'server/openai-codex.js',
      ...['capability-registry', 'parity', 'types', 'validation'].map(name => `server/modules/execution-permissions/${name}.ts`)]) emit(filename);
    const fixture = 'server/modules/execution-permissions/fixtures/permission-capabilities.v1.json';
    fs.mkdirSync(path.dirname(path.join(root, fixture)), { recursive: true });
    fs.copyFileSync(path.join(project, fixture), path.join(root, fixture));
    const compiled = await import(pathToFileURL(path.join(root, 'server/modules/execution-permissions/capability-registry.js')).href);
    const runtime = await resolveMeasurementRuntime(root);
    const compiledHelper = await import(pathToFileURL(path.join(root, 'server/shared/codex-executable.js')).href);
    assert.equal(runtime.launchOptions, compiledHelper.codexLaunchOptions);
    let usedLauncher = false;
    let captured;
    await defaultRunTurn({
      prompt: 'test', cwd: root, codexHome: root,
      ...runtime.readNative(),
      launchOptions: (...args) => { usedLauncher = true; return { ...runtime.launchOptions(...args), marker: 'compiled-launcher' }; },
      RuntimeCodex: class {
        constructor(options) { captured = options; }
        startThread() { return { run: async () => ({ finalResponse: 'test' }) }; }
      },
    });
    assert.equal(usedLauncher, true);
    assert.equal(captured.marker, 'compiled-launcher');
    const version = () => 'codex-cli 0.153.2';
    const measurement = identityDigest(readInstalledIdentity(version, runtime));
    assert.equal(compiled.resolveInstalledCodexBuildFingerprint(version).buildFingerprint, measurement);
    assert.notEqual(identityDigest(readInstalledIdentity(version)), measurement);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('provider probe rejects an unreviewed fingerprint before creating any workspace', async () => {
  await assert.rejects(measureCodexCandidate({ codexHome: '/not-used' }), /RUNTIME_ROOT_REQUIRED/);
  await assert.rejects(measureCodexCandidate({
    codexHome: '/not-used', expectedFingerprint: `sha256:${'0'.repeat(64)}`, runTurn: async () => assert.fail('must not run'),
  }), /REVIEWED_FINGERPRINT_MISMATCH/);
});

// Pure integration uses the production validators compiled in a temporary project directory.
test('measurement integration rejects bad evidence and preserves unrelated body records', async () => {
  const { integrateMeasuredCodexEvidence, loadMeasurementValidators } = await import('./permission-parity-measure-codex.mjs');
  const { preparePermissionArtifactPinUpdate } = await import('./lib/permission-release-contract.mjs');
  const crypto = await import('node:crypto');
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const seal = value => `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
  const root = fs.mkdtempSync(path.resolve('.artifacts/codex-integration-test-'));
  try {
    for (const name of ['parity', 'types', 'validation', 'capability-registry']) {
      const relative = `server/modules/execution-permissions/${name}`;
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, `${relative}.js`), ts.transpileModule(fs.readFileSync(`${relative}.ts`, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    fs.mkdirSync(path.join(root, 'server/shared'), { recursive: true });
    fs.copyFileSync('server/shared/codex-executable.js', path.join(root, 'server/shared/codex-executable.js'));
    const validators = await loadMeasurementValidators(root);
    const artifact = JSON.parse(fs.readFileSync('server/modules/execution-permissions/fixtures/permission-capabilities.v1.json'));
    const now = artifact.reference.evidence.measuredAt;
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const probeSummary = { readHost: true, writeHost: true, processHost: true, networkExternal: true, noApproval: true };
    const measurement = { schemaVersion: 1, sdkFingerprint: 'openai-codex-sdk@0.153.2', cliFingerprint: 'codex-cli@0.153.2', probeSummary,
      candidate: buildMeasuredCodexCandidate({ measuredAt: now, buildFingerprint: fingerprint, observation: probeSummary }) };
    const reviewed = { expectedFingerprint: fingerprint, registry: { buildFingerprint: fingerprint,
      sdkFingerprint: measurement.sdkFingerprint, cliFingerprint: measurement.cliFingerprint } };
    const args = { artifact, measurement, reviewed, validators, now, expectedArtifactDigest: artifact.artifactDigest };
    const output = integrateMeasuredCodexEvidence(args);
    assert.deepEqual(output.reference, artifact.reference);
    assert.deepEqual(output.unavailableBodies, artifact.unavailableBodies);
    assert.deepEqual(output.candidates.filter(c => c.body !== 'codex'), artifact.candidates.filter(c => c.body !== 'codex'));
    assert.deepEqual(output.candidates.map(c => c.body), artifact.candidates.map(c => c.body));
    assert.deepEqual(output.candidates.find(c => c.body === 'codex'), measurement.candidate);
    for (const mutate of [
      x => { x.measurement.probeSummary.noApproval = false; },
      x => { delete x.measurement.probeSummary.readHost; },
      x => { x.measurement.sdkFingerprint = 'wrong'; },
      x => { delete x.measurement.sdkFingerprint; delete x.reviewed.registry.sdkFingerprint; },
      x => { x.measurement.cliFingerprint = 'wrong'; },
      x => { x.reviewed.expectedFingerprint = `sha256:${'b'.repeat(64)}`; },
      x => { x.measurement.candidate.evidenceDigest = fingerprint; },
      x => { x.now = '2099-01-01T00:00:00.000Z'; },
      x => { x.measurement.candidate = {}; },
      x => { x.expectedArtifactDigest = fingerprint; },
      x => { x.artifact.reference.evidenceDigest = fingerprint; },
    ]) {
      const changed = structuredClone({ artifact, measurement, reviewed, now, expectedArtifactDigest: artifact.artifactDigest });
      mutate(changed);
      assert.throws(() => integrateMeasuredCodexEvidence({ ...changed, validators }));
    }
    for (const change of [x => x.candidates.push(x.candidates[0]), x => x.unavailableBodies.pop()]) {
      const changed = structuredClone(artifact); change(changed);
      const { artifactDigest: _old, ...payload } = changed;
      changed.artifactDigest = seal(payload);
      assert.throws(() => integrateMeasuredCodexEvidence({ ...args, artifact: changed, expectedArtifactDigest: changed.artifactDigest }), /CLASSIFICATION/);
    }
    const releaseSource = fs.readFileSync('scripts/lib/permission-release-contract.mjs', 'utf8');
    const oldPin = releaseSource.match(/const CAPABILITY_ARTIFACT_DIGEST = '(sha256:[a-f0-9]{64})';/u)[1];
    const updated = preparePermissionArtifactPinUpdate(releaseSource, oldPin, output.artifactDigest);
    assert.throws(() => preparePermissionArtifactPinUpdate(releaseSource, fingerprint, output.artifactDigest), /compare-and-swap/);
    assert.throws(() => preparePermissionArtifactPinUpdate(releaseSource, oldPin, 'invalid'), /invalid/);
    fs.writeFileSync(path.join(root, 'release.mjs'), updated);
    const fixtureDir = path.join(root, 'server/modules/execution-permissions/fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'permission-capabilities.v1.json'), JSON.stringify(output));
    const registry = await import(pathToFileURL(path.join(root, 'server/modules/execution-permissions/capability-registry.js')).href);
    const release = await import(pathToFileURL(path.join(root, 'release.mjs')).href);
    const build = 'c'.repeat(64);
    const contract = release.createMeasuredPermissionReleaseContract(build);
    assert.equal(contract.permissionCapabilityDigest,
      registry.computePermissionReleaseCapabilityDigest(build, contract.permissionProfileDigest, contract.permissionProtocolGeneration));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
