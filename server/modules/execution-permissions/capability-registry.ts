import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Pure native-package identity utility; does not import a runtime or database module.
import { readCodexExecutableIdentity } from '../../shared/codex-executable.js';

import capabilityArtifact from './fixtures/permission-capabilities.v1.json' with { type: 'json' };
import { computeCandidateEvidenceDigest, computeReferenceEvidenceDigest } from './parity.js';
import type { CanonicalLaunchContext, PermissionCandidateVector } from './types.js';
import { validatePermissionCandidateVector } from './validation.js';

const SUITE_ID = 'claude-production-sdk-full-delegation-v1';
type InstalledPermissionIdentity = Readonly<{
  buildFingerprint: string;
  sdkFingerprint?: string;
  cliFingerprint?: string;
}>;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
};

const digest = (value: unknown): string => `sha256:${crypto.createHash('sha256')
  .update(JSON.stringify(stableValue(value))).digest('hex')}`;
const orderedDigest = (value: unknown): string => `sha256:${crypto.createHash('sha256')
  .update(JSON.stringify(value)).digest('hex')}`;

const installedPackageVersion = (packageName: string): string => {
  let directory = path.dirname(new URL(import.meta.url).pathname);
  for (;;) {
    const packageFile = path.join(directory, 'node_modules', ...packageName.split('/'), 'package.json');
    if (fs.existsSync(packageFile)) {
      const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
        name?: string; version?: string;
      };
      if (parsed.name === packageName && parsed.version) return parsed.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`PERMISSION_PACKAGE_VERSION_UNAVAILABLE:${packageName}`);
    directory = parent;
  }
};

const artifactPayload = {
  schemaVersion: capabilityArtifact.schemaVersion,
  reference: capabilityArtifact.reference,
  candidates: capabilityArtifact.candidates,
  unavailableBodies: capabilityArtifact.unavailableBodies,
};

const expectedBodies = new Set([
  'claude', 'codex', 'cursor', 'antigravity', 'opencode', 'kimi',
  'deepseek', 'glm', 'hermes', 'qwen', 'sakana',
]);
const classifiedBodies = [
  ...capabilityArtifact.candidates.map(candidate => candidate.body),
  ...capabilityArtifact.unavailableBodies.map(item => item.body),
];
const isUnavailableBodyRecord = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'body,observedAt,reasonCode') return false;
  if (typeof record.body !== 'string' || !expectedBodies.has(record.body)
    || typeof record.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(record.reasonCode)
    || typeof record.observedAt !== 'string') return false;
  const timestamp = Date.parse(record.observedAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === record.observedAt;
};

if (digest(artifactPayload) !== capabilityArtifact.artifactDigest
  || computeReferenceEvidenceDigest(capabilityArtifact.reference as never)
    !== capabilityArtifact.reference.evidenceDigest
  || capabilityArtifact.candidates.some(candidate =>
    !validatePermissionCandidateVector(candidate)
    || computeCandidateEvidenceDigest(candidate as never) !== candidate.evidenceDigest)
  || classifiedBodies.length !== expectedBodies.size
  || new Set(classifiedBodies).size !== classifiedBodies.length
  || classifiedBodies.some(body => !expectedBodies.has(body))) {
  throw new Error('PERMISSION_CAPABILITY_ARTIFACT_INVALID');
}

if (capabilityArtifact.unavailableBodies.some(item => !isUnavailableBodyRecord(item))) {
  throw new Error('PERMISSION_CAPABILITY_UNAVAILABLE_BODY_INVALID');
}

const candidates = new Map<string, PermissionCandidateVector>();
for (const candidate of capabilityArtifact.candidates) {
  if (candidates.has(candidate.body)) throw new Error('PERMISSION_CAPABILITY_BODY_DUPLICATE');
  candidates.set(candidate.body, Object.freeze(candidate as PermissionCandidateVector));
}

const normalizeClaudeCliVersion = (value: string): string => {
  const version = value.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  if (!version) throw new Error('PERMISSION_CLAUDE_CLI_VERSION_INVALID');
  return `claude-code@${version}`;
};

/** Measure the installed Claude adapter/SDK/CLI identity using the same formula as the live probe. */
export const resolveInstalledClaudeBuildFingerprint = (
  execImpl: typeof execFileSync = execFileSync,
): Readonly<{ buildFingerprint: string; sdkFingerprint: string; cliFingerprint: string }> => {
  const serverSource = fs.readFileSync(new URL('../../claude-sdk.js', import.meta.url), 'utf8');
  const sdkVersion = installedPackageVersion('@anthropic-ai/claude-agent-sdk');
  const rawCliVersion = String(execImpl('claude', ['--version'], {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  return Object.freeze({
    buildFingerprint: digest({
      serverSourceDigest: digest(serverSource),
      sdkVersion,
      cliVersion: rawCliVersion,
      suiteId: SUITE_ID,
    }),
    sdkFingerprint: `anthropic-claude-agent-sdk@${sdkVersion}`,
    cliFingerprint: normalizeClaudeCliVersion(rawCliVersion),
  });
};

/** Measure the installed Codex adapter/SDK/CLI identity using the live-probe formula. */
export const resolveInstalledCodexBuildFingerprint = (
  execImpl: typeof execFileSync = execFileSync,
  readNativeIdentity = readCodexExecutableIdentity,
): Readonly<{ buildFingerprint: string; sdkFingerprint: string; cliFingerprint: string }> => {
  const serverSource = fs.readFileSync(new URL('../../openai-codex.js', import.meta.url), 'utf8');
  const sdkVersion = installedPackageVersion('@openai/codex-sdk');
  const { executablePath, pathDirs: _pathDirs, ...nativeIdentity } = readNativeIdentity();
  const rawCliVersion = String(execImpl(executablePath, ['--version'], {
    shell: false, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  const cliVersion = rawCliVersion.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  if (!cliVersion) throw new Error('PERMISSION_CODEX_CLI_VERSION_INVALID');
  return Object.freeze({
    buildFingerprint: digest({
      serverSourceDigest: digest(serverSource),
      sdkVersion,
      cliVersion: rawCliVersion,
      suiteId: 'codex-production-sdk-full-delegation-v1', ...nativeIdentity,
    }),
    sdkFingerprint: `openai-codex-sdk@${sdkVersion}`,
    cliFingerprint: `codex-cli@${cliVersion}`,
  });
};

/** Measure the installed Antigravity/agy adapter and CLI identity using its live-probe formula. */
export const resolveInstalledAgyBuildFingerprint = (
  execImpl: typeof execFileSync = execFileSync,
): Readonly<{ buildFingerprint: string; cliFingerprint: string }> => {
  const serverSource = fs.readFileSync(new URL('../../agy-cli.js', import.meta.url), 'utf8');
  const rawCliVersion = String(execImpl('agy', ['--version'], {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  const cliVersion = rawCliVersion.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  if (!cliVersion) throw new Error('PERMISSION_AGY_CLI_VERSION_INVALID');
  return Object.freeze({
    buildFingerprint: digest({
      serverSourceDigest: digest(serverSource),
      cliVersion: rawCliVersion,
      suiteId: 'agy-production-cli-full-delegation-v1',
    }),
    cliFingerprint: `agy@${cliVersion}`,
  });
};

/** Return a freshly evaluated, resealed candidate; absent/drifted bodies fail closed. */
export const resolveMeasuredPermissionCandidate = (
  context: CanonicalLaunchContext,
  evaluatedAt = new Date().toISOString(),
  installedIdentity: InstalledPermissionIdentity | null = context.body === 'claude'
    ? resolveInstalledClaudeBuildFingerprint()
    : context.body === 'codex'
      ? resolveInstalledCodexBuildFingerprint()
      : context.body === 'antigravity'
        ? resolveInstalledAgyBuildFingerprint()
        : null,
): PermissionCandidateVector | null => {
  const baseline = candidates.get(context.body);
  if (!baseline || !installedIdentity) return null;
  const { evidenceDigest: _baselineDigest, ...baselinePayload } = structuredClone(baseline);
  const draft = {
    ...baselinePayload,
    installedBuildFingerprint: installedIdentity.buildFingerprint,
    evidence: { ...baseline.evidence, evaluatedAt },
  };
  return Object.freeze({
    ...draft,
    evidenceDigest: computeCandidateEvidenceDigest(draft as PermissionCandidateVector),
  }) as PermissionCandidateVector;
};

export const PERMISSION_CAPABILITY_ARTIFACT_DIGEST = capabilityArtifact.artifactDigest;
/** Derive the manifest-bound capability seal from the measured artifact and exact generation. */
export const computePermissionReleaseCapabilityDigest = (
  serverBuildId: string,
  profileDigest: string,
  protocolGeneration: number,
): string => orderedDigest({
  schema: 'nassaj-permission-capability/v1', profileId: 'full_delegation',
  contractVersion: 'permission-parity/v1', profileDigest, protocolGeneration,
  buildId: serverBuildId, evidenceStatus: 'measured',
  artifactDigest: PERMISSION_CAPABILITY_ARTIFACT_DIGEST, verdict: 'eligible_bodies_only',
});
export const PERMISSION_UNAVAILABLE_BODIES = Object.freeze(
  structuredClone(capabilityArtifact.unavailableBodies),
);
/** Validate the fail-closed shape used for an explicitly unavailable body. */
export const validateUnavailablePermissionBody = isUnavailableBodyRecord;
