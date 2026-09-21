import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.equal(PERMISSION_UNAVAILABLE_BODIES.length, 9);
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
  const codex = resolveInstalledCodexBuildFingerprint();
  const agy = resolveInstalledAgyBuildFingerprint(() => '1.1.24' as never);
  assert.equal(claude.cliFingerprint, installed.cliFingerprint);
  assert.equal(claude.sdkFingerprint, installed.sdkFingerprint);
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
  const cli = JSON.parse(fs.readFileSync(new URL('../../../node_modules/@openai/codex/package.json', import.meta.url), 'utf8'));
  assert.equal(codex.cliFingerprint, `codex-cli@${cli.version}`);
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


test('Codex runtime and measurement bind the same native executable identity, ignoring PATH CLI', async () => {
  const { readInstalledIdentity, identityDigest } = await import('../../../scripts/permission-parity-measure-codex.mjs');
  let measuredBinary = '';
  const exec = ((binary: string) => { measuredBinary = binary; return 'codex-cli 0.153.2'; }) as never;
  const runtime = resolveInstalledCodexBuildFingerprint(exec);
  assert.ok(measuredBinary.startsWith('/'));
  assert.notEqual(measuredBinary, 'codex');
  assert.equal(runtime.buildFingerprint, identityDigest(readInstalledIdentity(exec)));
});


test('Codex build fingerprint changes when native bytes change with the same reported CLI version', async () => {
  // Pure shared native identity utility outside the module graph.
  const { readCodexExecutableIdentity } = await import('../../shared/codex-executable.js');
  const identity = readCodexExecutableIdentity();
  const sameVersion = (() => 'codex-cli 0.153.2') as never;
  const before = resolveInstalledCodexBuildFingerprint(sameVersion, () => identity);
  for (const changed of [
    { nativeDigest: 'sha256:changed-native-bytes' },
    { sdkSourceDigest: 'sha256:changed-sdk-bytes' },
    { pathClosure: [['rg', 'sha256:changed-tool-bytes']] },
  ]) {
    const after = resolveInstalledCodexBuildFingerprint(sameVersion, () => ({ ...identity, ...changed }));
    assert.equal(after.cliFingerprint, before.cliFingerprint);
    assert.notEqual(after.buildFingerprint, before.buildFingerprint);
  }
});


test('same-version native file mutation changes the registry build fingerprint', async () => {
  // Pure shared identity utility outside the module graph.
  const { readCodexExecutableIdentity, codexFileDigest } = await import('../../shared/codex-executable.js');
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const artifacts = path.join(project, '.artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'codex-registry-bytes-'));
  try {
    const binary = path.join(root, 'native');
    const native = readCodexExecutableIdentity();
    const readNative = () => ({ ...native, nativeDigest: codexFileDigest(binary) });
    const fixedVersion = (() => 'codex-cli 0.153.2') as never;
    fs.writeFileSync(binary, 'first native bytes');
    const before = resolveInstalledCodexBuildFingerprint(fixedVersion, readNative);
    fs.writeFileSync(binary, 'other native bytes');
    const after = resolveInstalledCodexBuildFingerprint(fixedVersion, readNative);
    assert.equal(after.cliFingerprint, before.cliFingerprint);
    assert.notEqual(after.buildFingerprint, before.buildFingerprint);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
