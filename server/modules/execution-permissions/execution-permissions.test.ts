import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLAUDE_REFERENCE_VECTOR_V1 } from './fixtures/claude-reference-v1.js';
import {
  computeCandidateEvidenceDigest,
  computeReferenceEvidenceDigest,
  evaluateParity,
} from './parity.js';
import { resolveEffectivePolicy } from './policy.js';
import type {
  ClaudeReferenceVector,
  PermissionCandidateVector,
  SealedPermissionPolicy,
} from './types.js';
import {
  validateClaudeReferenceVector,
  validateLaunchContext,
  validatePermissionCandidateVector,
  validateSealedPermissionPolicy,
} from './validation.js';

const clone = <T>(value: T): T => structuredClone(value);

const measuredReference = (): ClaudeReferenceVector => {
  const draft = clone(CLAUDE_REFERENCE_VECTOR_V1) as unknown as Record<string, unknown>;
  draft.referenceBuildFingerprint = 'claude-build-1.2.3';
  draft.referenceSdkFingerprint = 'claude-sdk-1.2.3';
  draft.referenceCliFingerprint = 'claude-cli-1.2.3';
  draft.evidence = {
    status: 'measured', measuredAt: '2030-01-01T00:00:00.000Z',
    validUntil: '2030-02-01T00:00:00.000Z', evaluatedAt: '2030-01-02T00:00:00.000Z',
    suiteId: 'claude-live-path-v1', measuredBuildFingerprint: 'claude-build-1.2.3',
  };
  delete draft.evidenceDigest;
  return Object.freeze({
    ...draft,
    evidenceDigest: computeReferenceEvidenceDigest(draft as Omit<ClaudeReferenceVector, 'evidenceDigest'>),
  }) as ClaudeReferenceVector;
};

const matchingCandidate = (reference = measuredReference()): PermissionCandidateVector => {
  const draft = {
    contractVersion: reference.contractVersion,
    profileId: reference.profileId,
    body: 'codex',
    installedBuildFingerprint: 'codex-build-4.5.6',
    dimensions: clone(reference.dimensions),
    enforcement: clone(reference.minimumEnforcement),
    deniedSurfaces: clone(reference.deniedSurfaces),
    evidence: {
      status: 'measured' as const, measuredAt: reference.evidence.measuredAt,
      validUntil: reference.evidence.validUntil, evaluatedAt: reference.evidence.evaluatedAt,
      suiteId: 'codex-live-path-v1', measuredBuildFingerprint: 'codex-build-4.5.6',
    },
  };
  return Object.freeze({ ...draft, evidenceDigest: computeCandidateEvidenceDigest(draft) });
};

const resealCandidate = (mutate: (draft: Record<string, any>) => void): PermissionCandidateVector => {
  const draft = clone(matchingCandidate()) as unknown as Record<string, any>;
  delete draft.evidenceDigest;
  mutate(draft);
  return { ...draft, evidenceDigest: computeCandidateEvidenceDigest(draft as PermissionCandidateVector) };
};

const launchContext = Object.freeze({
  launchId: 'launch-1', principalId: 'user:17', sessionId: 'session-1', projectId: 'project-1',
  workspacePath: '/srv/projects/example', provider: 'openai', body: 'codex', engine: 'sdk',
  entrypoint: 'websocket-chat', purpose: 'sdk_turn', effectFootprint: 'external',
});

const authority: SealedPermissionPolicy = Object.freeze({
  source: 'sealed_release_manifest', profileId: 'full_delegation',
  contractVersion: 'permission-parity/v1',
  profileDigest: `sha256:${'a'.repeat(64)}`, capabilityDigest: `sha256:${'b'.repeat(64)}`,
  protocolGeneration: 1,
});

describe('measured Claude fixture', () => {
  it('is structurally valid, sealed, fresh, and parity-capable', () => {
    assert.equal(validateClaudeReferenceVector(CLAUDE_REFERENCE_VECTOR_V1), true);
    assert.equal(computeReferenceEvidenceDigest(CLAUDE_REFERENCE_VECTOR_V1),
      CLAUDE_REFERENCE_VECTOR_V1.evidenceDigest);
    const candidate = matchingCandidate(CLAUDE_REFERENCE_VECTOR_V1);
    const result = evaluateParity(CLAUDE_REFERENCE_VECTOR_V1, candidate);
    assert.equal(result.kind, 'parity');
  });
});

describe('evaluateParity', () => {
  it('accepts exact grants and equal enforcement deterministically', () => {
    const reference = measuredReference();
    const candidate = matchingCandidate(reference);
    const first = evaluateParity(reference, candidate);
    const second = evaluateParity(reference, candidate);
    assert.equal(first.kind, 'parity');
    assert.deepEqual(first, second);
  });

  it('accepts stronger enforcement without changing grants', () => {
    const result = evaluateParity(measuredReference(), resealCandidate(draft => {
      draft.enforcement.filesystem_read = 'kernel';
    }));
    assert.equal(result.kind, 'parity');
  });

  it('denies missing, mismatched, weak, and forbidden-surface candidates', () => {
    const cases: Array<[string, (draft: Record<string, any>) => void]> = [
      ['MISSING_DIMENSION', draft => { delete draft.dimensions.tools; }],
      ['GRANT_MISMATCH', draft => { draft.dimensions.tools = { decision: 'deny', scope: 'none' }; }],
      ['WEAKER_ENFORCEMENT', draft => { draft.enforcement.tools = 'advisory'; }],
      ['FORBIDDEN_SURFACE', draft => { draft.deniedSurfaces = ['mcp', 'connectors']; }],
    ];
    for (const [reason, mutate] of cases) {
      const result = evaluateParity(measuredReference(), resealCandidate(mutate));
      assert.equal(result.kind, 'deny', reason);
      if (result.kind === 'deny') assert.ok(result.reasonCodes.includes(reason as never), reason);
    }
  });

  it('denies contract/profile mismatch and stale or drifted evidence', () => {
    const cases: Array<[string, (draft: Record<string, any>) => void]> = [
      ['CONTRACT_MISMATCH', draft => { draft.contractVersion = 'permission-parity/v2'; }],
      ['PROFILE_MISMATCH', draft => { draft.profileId = 'other_profile'; }],
      ['EVIDENCE_STALE', draft => { draft.evidence.evaluatedAt = '2030-03-01T00:00:00.000Z'; }],
      ['BINARY_DRIFT', draft => { draft.installedBuildFingerprint = 'codex-build-9.9.9'; }],
    ];
    for (const [reason, mutate] of cases) {
      const result = evaluateParity(measuredReference(), resealCandidate(mutate));
      assert.equal(result.kind, 'deny', reason);
      if (result.kind === 'deny') assert.ok(result.reasonCodes.includes(reason as never), reason);
    }
  });

  it('detects a tampered candidate that was not resealed', () => {
    const candidate = clone(matchingCandidate()) as unknown as Record<string, any>;
    candidate.dimensions.tools = { decision: 'deny', scope: 'none' };
    const result = evaluateParity(measuredReference(), candidate);
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') assert.ok(result.reasonCodes.includes('EVIDENCE_DIGEST_MISMATCH'));
  });

  it('denies malformed and unknown-dimension inputs', () => {
    const malformed = clone(matchingCandidate()) as unknown as Record<string, unknown>;
    (malformed.dimensions as Record<string, unknown>).unknown_effect = { decision: 'allow', scope: 'host' };
    const result = evaluateParity(measuredReference(), malformed);
    assert.deepEqual(result, { kind: 'deny', reasonCodes: ['MALFORMED_CANDIDATE'] });
  });
});

describe('pure launch validation and policy resolution', () => {
  it('accepts a stable launch identity for both new and resumed sessions', () => {
    const newSession = { ...launchContext, launchId: 'launch-new', sessionId: null };
    const resumedSession = { ...launchContext, launchId: 'launch-resume', sessionId: 'session-existing' };
    assert.equal(validateLaunchContext(newSession), true);
    assert.equal(validateLaunchContext(resumedSession), true);
  });

  it('validates only closed server contracts', () => {
    assert.equal(validateLaunchContext(launchContext), true);
    assert.equal(validateSealedPermissionPolicy(authority), true);
    assert.equal(validatePermissionCandidateVector(matchingCandidate()), true);
    assert.equal(validateLaunchContext({ ...launchContext, clientGrant: 'host' }), false);
    const { launchId: _launchId, ...missingLaunchId } = launchContext;
    assert.equal(validateLaunchContext(missingLaunchId), false);
    assert.equal(validateLaunchContext({ ...launchContext, purpose: 'unknown' }), false);
    assert.equal(validateLaunchContext({ ...launchContext, workspacePath: 'relative/project' }), false);
    assert.equal(validateLaunchContext({ ...launchContext, workspacePath: '/srv/../etc' }), false);
    assert.equal(validateLaunchContext({ ...launchContext, workspacePath: '/srv/project\0escape' }), false);
    assert.equal(validateSealedPermissionPolicy({ ...authority, source: 'environment' }), false);
    assert.equal(validateSealedPermissionPolicy({ ...authority, source: 'development_unsealed' }), true);
  });

  it('resolves the measured sealed fixture', () => {
    const result = resolveEffectivePolicy({
      context: launchContext, requestedProfile: 'full_delegation', authority,
      reference: CLAUDE_REFERENCE_VECTOR_V1,
    });
    assert.equal(result.kind, 'resolved');
  });

  it('never resolves an unsealed development authority', () => {
    assert.deepEqual(resolveEffectivePolicy({
      context: launchContext, requestedProfile: 'full_delegation',
      authority: { ...authority, source: 'development_unsealed' }, reference: measuredReference(),
    }), { kind: 'unavailable', reasonCodes: ['RELEASE_IDENTITY_UNSEALED'] });
  });

  it('returns unavailable for a measured but tampered reference', () => {
    const reference = clone(measuredReference()) as unknown as Record<string, any>;
    reference.dimensions.tools = { decision: 'deny', scope: 'none' };
    assert.deepEqual(resolveEffectivePolicy({
      context: launchContext, requestedProfile: 'full_delegation', authority, reference,
    }), { kind: 'unavailable', reasonCodes: ['REFERENCE_UNAVAILABLE'] });
  });

  it('resolves only a measured matching sealed policy', () => {
    const result = resolveEffectivePolicy({
      context: launchContext, requestedProfile: 'full_delegation', authority,
      reference: measuredReference(),
    });
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.equal(result.policy.protocolGeneration, 1);
      assert.equal(result.policy.dimensions.mcp.decision, 'deny');
    }
  });

  it('fails closed for invalid context, authority, profile, and contract', () => {
    const reference = measuredReference();
    assert.equal(resolveEffectivePolicy({ context: {}, requestedProfile: 'full_delegation', authority, reference }).kind, 'deny');
    assert.equal(resolveEffectivePolicy({ context: launchContext, requestedProfile: 'other', authority, reference }).kind, 'deny');
    assert.equal(resolveEffectivePolicy({ context: launchContext, requestedProfile: 'full_delegation', authority: {}, reference }).kind, 'deny');
    assert.deepEqual(resolveEffectivePolicy({
      context: launchContext, requestedProfile: 'full_delegation',
      authority: { ...authority, contractVersion: 'permission-parity/v2' }, reference,
    }), { kind: 'deny', reasonCodes: ['CONTRACT_MISMATCH'] });
  });
});
