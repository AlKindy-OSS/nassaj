// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import '../../shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure shared resolver and its test fixture, outside the module graph.
import { acquireCodexLaunchIdentity } from '../../shared/codex-executable.js';
import { createCodexMachineFixture } from '../../shared/tests/codex-release-fixture.js';

import artifact from './fixtures/permission-capabilities.v1.json' with { type: 'json' };
import { CLAUDE_REFERENCE_VECTOR_V1 } from './fixtures/claude-reference-v1.js';
import { evaluateParity } from './parity.js';
import {
  PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
  PERMISSION_UNAVAILABLE_BODIES,
  resolveInstalledAgyBuildFingerprint,
  resolveInstalledClaudeBuildFingerprint,
  resolveInstalledCodexBuildFingerprint,
  resolveMeasuredPermissionCandidate,
  validateUnavailablePermissionBody,
} from './capability-registry.js';

const measuredCodex = artifact.candidates.find(candidate => candidate.body === 'codex')!;

// T-1872: a machine Codex release fixture stands in for ~/.local/bin/codex.
const machineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-registry-machine-'));
const machine = createCodexMachineFixture(machineRoot);
const savedCodexPath = process.env.CODEX_PATH;
process.env.CODEX_PATH = machine.launcher;
after(() => {
  if (savedCodexPath === undefined) delete process.env.CODEX_PATH; else process.env.CODEX_PATH = savedCodexPath;
  fs.rmSync(machineRoot, { recursive: true, force: true });
});
const machineIdentity = () => acquireCodexLaunchIdentity({ readVersion: () => '0.156.0' });

const context = Object.freeze({
  launchId: 'launch-1', principalId: 'user:1', sessionId: null,
  projectId: 'project-1', workspacePath: '/workspace/project', provider: 'claude',
  body: 'claude', engine: 'sdk', entrypoint: 'ws.chat', purpose: 'sdk_turn' as const,
});

const installed = Object.freeze({
  buildFingerprint: CLAUDE_REFERENCE_VECTOR_V1.referenceBuildFingerprint,
  sdkFingerprint: CLAUDE_REFERENCE_VECTOR_V1.referenceSdkFingerprint,
  cliFingerprint: CLAUDE_REFERENCE_VECTOR_V1.referenceCliFingerprint,
});

test('sealed measured Claude candidate reaches parity only while evidence and binaries match', () => {
  assert.match(PERMISSION_CAPABILITY_ARTIFACT_DIGEST, /^sha256:[a-f0-9]{64}$/u);
  const candidate = resolveMeasuredPermissionCandidate(
    context, '2026-09-03T00:00:00.000Z', installed,
  );
  assert.ok(candidate);
  assert.equal(evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, candidate).kind, 'parity');
  assert.equal(resolveMeasuredPermissionCandidate(
    context, '2026-10-03T00:00:00.000Z', installed,
  )?.evidence.evaluatedAt, '2026-10-03T00:00:00.000Z');
  const stale = resolveMeasuredPermissionCandidate(
    context, '2026-10-03T00:00:00.000Z', installed,
  );
  assert.equal(evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, stale).kind, 'deny');
});

test('unknown body and installed binary drift are unavailable', () => {
  assert.equal(resolveMeasuredPermissionCandidate({ ...context, body: 'cursor' },
    '2026-09-03T00:00:00.000Z', installed), null);
  const drifted = resolveMeasuredPermissionCandidate(context, '2026-09-03T00:00:00.000Z', {
    ...installed, cliFingerprint: 'claude-code@9.9.9',
    buildFingerprint: 'sha256:drifted',
  });
  assert.equal(evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, drifted).kind, 'deny');
});

test('measured Codex candidate reaches parity under its measured build', () => {
  const codex = resolveMeasuredPermissionCandidate(
    { ...context, provider: 'openai', body: 'codex' },
    measuredCodex.evidence.measuredAt,
    { buildFingerprint: measuredCodex.evidence.measuredBuildFingerprint },
  );
  assert.equal(evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, codex).kind, 'parity');
});

test('measured Antigravity is classified but remains non-parity on forbidden surfaces', () => {
  const identity = resolveInstalledAgyBuildFingerprint(() => '1.1.24' as never);
  const candidate = resolveMeasuredPermissionCandidate(
    { ...context, provider: 'antigravity', body: 'antigravity', engine: 'cli', purpose: 'spawn' },
    '2026-09-03T00:00:00.000Z',
    identity,
  );
  assert.ok(candidate);
  assert.equal(evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, candidate).kind, 'deny');
  assert.equal(PERMISSION_UNAVAILABLE_BODIES.length, 8);
  assert.ok(PERMISSION_UNAVAILABLE_BODIES.some(item => item.body === 'cursor'));
});

test('unavailable-body records reject malformed reasons, dates, and extra keys', () => {
  const valid = { body: 'cursor', reasonCode: 'AUTHENTICATION_UNAVAILABLE', observedAt: '2026-09-01T05:19:00.000Z' };
  assert.equal(validateUnavailablePermissionBody(valid), true);
  assert.equal(validateUnavailablePermissionBody({ ...valid, reasonCode: 'auth missing' }), false);
  assert.equal(validateUnavailablePermissionBody({ ...valid, observedAt: 'yesterday' }), false);
  assert.equal(validateUnavailablePermissionBody({ ...valid, detail: 'secret' }), false);
  assert.equal(validateUnavailablePermissionBody({ ...valid, body: 'unknown' }), false);
});

test('installed Codex source identity remains distinct from compiled measured evidence', () => {
  const claude = resolveInstalledClaudeBuildFingerprint(() => '2.1.258 (Claude Code)' as never);
  const codex = resolveInstalledCodexBuildFingerprint(machineIdentity());
  const agy = resolveInstalledAgyBuildFingerprint(() => '1.1.24' as never);
  assert.equal(claude.cliFingerprint, installed.cliFingerprint);
  // The SDK identity is measured from the installed package, not copied from the
  // sealed reference; an SDK upgrade past the measured one is drift, never parity.
  const installedSdk = JSON.parse(fs.readFileSync(
    new URL('../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(claude.sdkFingerprint, `anthropic-claude-agent-sdk@${installedSdk.version}`);
  assert.match(claude.buildFingerprint, /^sha256:[a-f0-9]{64}$/u);
  // Source adapters have changed since the sealed reference measurement. A matching
  // version string must not upgrade those changed bytes to measured parity.
  assert.notEqual(claude.buildFingerprint, installed.buildFingerprint);
  const claudeParity = evaluateParity(CLAUDE_REFERENCE_VECTOR_V1,
    resolveMeasuredPermissionCandidate(context, '2026-09-03T00:00:00.000Z', claude));
  assert.equal(claudeParity.kind, 'deny');
  if (claudeParity.kind === 'deny') assert.ok(claudeParity.reasonCodes.includes('BINARY_DRIFT'));
  const sdk = JSON.parse(fs.readFileSync(new URL('../../../node_modules/@openai/codex-sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(codex.sdkFingerprint, `openai-codex-sdk@${sdk.version}`);
  // T-1872: the CLI is the machine release, not the SDK-bundled npm package.
  assert.equal(codex.cliFingerprint, 'codex-cli@0.156.0');
  // Until part 2 re-measures the machine release, full delegation must report drift.
  const drifted = evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, resolveMeasuredPermissionCandidate(
    { ...context, body: 'codex' }, measuredCodex.evidence.measuredAt, codex,
  ));
  assert.equal(drifted.kind, 'deny');
  if (drifted.kind === 'deny') assert.ok(drifted.reasonCodes.includes('BINARY_DRIFT'));
  // Independently derive current source identity; the sealed evidence stays unchanged.
  const hashJson = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  const adapterSource = fs.readFileSync(new URL('../../agy-cli.js', import.meta.url), 'utf8');
  assert.deepEqual(agy, {
    buildFingerprint: hashJson({ cliVersion: '1.1.24', serverSourceDigest: hashJson(adapterSource),
      suiteId: 'agy-production-cli-full-delegation-v1' }),
    cliFingerprint: 'agy@1.1.24',
  });
});


test('Codex runtime and measurement bind the same machine identity object', async () => {
  const { readInstalledIdentity, identityDigest } = await import('../../../scripts/permission-parity-measure-codex.mjs');
  const { codexFingerprintFields } = await import('../../shared/codex-executable.js');
  const identity = machineIdentity();
  const runtime = resolveInstalledCodexBuildFingerprint(identity);
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const sdk = JSON.parse(fs.readFileSync(path.join(project, 'node_modules/@openai/codex-sdk/package.json'), 'utf8'));
  const measured = readInstalledIdentity({
    root: project, acquire: () => identity, fingerprintFields: codexFingerprintFields, sdkVersion: sdk.version,
  });
  assert.equal(measured.launchIdentity, identity);
  assert.equal(runtime.buildFingerprint, identityDigest(measured));
  assert.throws(() => resolveInstalledCodexBuildFingerprint(undefined as never), /CLI_VERSION_INVALID/u);
});


test('Codex build fingerprint changes when release bytes change with the same reported version', () => {
  const identity = machineIdentity();
  const before = resolveInstalledCodexBuildFingerprint(identity);
  for (const changed of [
    { nativeDigest: 'sha256:changed-native-bytes' },
    { treeDigest: 'sha256:changed-resource-bytes' },
    { resolverDigest: 'sha256:changed-resolver-bytes' },
  ]) {
    const after = resolveInstalledCodexBuildFingerprint(Object.freeze({ ...identity, ...changed }));
    assert.equal(after.cliFingerprint, before.cliFingerprint);
    assert.notEqual(after.buildFingerprint, before.buildFingerprint);
  }
});


test('same-version release file mutation changes the registry build fingerprint', () => {
  const before = resolveInstalledCodexBuildFingerprint(machineIdentity());
  fs.appendFileSync(path.join(machine.release, 'codex-resources', 'bwrap'), 'patched');
  const after = resolveInstalledCodexBuildFingerprint(machineIdentity());
  assert.equal(after.cliFingerprint, before.cliFingerprint);
  assert.notEqual(after.buildFingerprint, before.buildFingerprint);
});
