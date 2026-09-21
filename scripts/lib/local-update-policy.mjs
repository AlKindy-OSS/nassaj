/** Installation-bound development policy in the existing local-update control store. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { commonGitDir, gitControlPath } from '../git-control-root.mjs';
import { readPublicationControlJson, clientPublicationPolicyEnabled } from './client-publication-policy.mjs';
import { canonicalTripleJson } from './oid-triple-target.mjs';

export const LOCAL_UPDATE_POLICY_FILE = 'nassaj-local-update-policy-v1.json';
export const DEV_FULL_CAPABILITY = 'nassaj-dev-full-policy/v1';
const HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(canonicalTripleJson(value)).digest('hex');

/** Bind policy to the canonical installation and service user, never request-supplied paths. */
export function localUpdatePolicyInstallation(root) {
    const scope = { canonicalProjectRoot: fs.realpathSync(root), canonicalGitCommonDir: commonGitDir(root),
        serviceUid: process.getuid(), serviceIdentity: 'nassaj-local-main' };
    return { ...scope, installationId: digest(scope) };
}

function receiptName(key) { return `nassaj-local-update-policy-receipt-${key}.json`; }

function readControl(root, name) {
    try { return readPublicationControlJson(gitControlPath(root, name)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkScope(root, record) {
    const expected = localUpdatePolicyInstallation(root);
    for (const [key, value] of Object.entries(expected)) {
        if (record?.[key] !== value) fail('local_update_policy_installation_mismatch');
    }
}

/** Missing policy is disabled. An orphan receipt grants no authority. */
export function readLocalUpdatePolicy(root) {
    const policy = readControl(root, LOCAL_UPDATE_POLICY_FILE);
    if (!policy) return { schema: 'nassaj-local-update-policy/v1', mode: 'disabled', revision: 0,
        ...localUpdatePolicyInstallation(root) };
    if (policy.schema !== 'nassaj-local-update-policy/v1' || !['disabled', 'dev-full-auto'].includes(policy.mode)
        || !Number.isSafeInteger(policy.revision) || policy.revision < 1
        || !Number.isSafeInteger(policy.ownerId) || policy.ownerId < 1
        || !HASH.test(policy.receiptKey || '') || !HASH.test(policy.receiptDigest || '')) fail('local_update_policy_invalid');
    checkScope(root, policy);
    const receipt = readControl(root, receiptName(policy.receiptKey));
    const { receiptKey: _key, receiptDigest: _digest, ...policyBody } = policy;
    if (!receipt || receipt.schema !== 'nassaj-local-update-policy-receipt/v1'
        || digest(receipt) !== policy.receiptDigest || canonicalTripleJson(receipt.policy) !== canonicalTripleJson(policyBody)) {
        fail('local_update_policy_receipt_invalid');
    }
    return policy;
}

/** A public projection never exposes paths, private receipts or filesystem authority. */
export function publicLocalUpdatePolicy(policy) {
    return { mode: policy.mode, revision: policy.revision };
}

/** Require loaded server and retained executor capability evidence. */
export function assertLocalUpdatePolicyCapability(input) {
    const proof = input.capability;
    if (proof?.protocol !== DEV_FULL_CAPABILITY || !HASH.test(proof.serverLoadedBuildId || '')
        || !HASH.test(proof.retainedExecutorSha256 || '')) fail('local_update_policy_capability_required');
    return { protocol: proof.protocol, serverLoadedBuildId: proof.serverLoadedBuildId,
        retainedExecutorSha256: proof.retainedExecutorSha256 };
}

/** Tie a loaded health capability to the installed sealed executor, not merely source code. */
export function verifyLocalUpdatePolicyCapability(root, health) {
    if (health?.status !== 'ok' || health.updateMode !== 'local-main' || health.degraded === true
        || health.normalAdmissionReady !== true) fail('local_update_policy_runtime_unavailable');
    const capability = assertLocalUpdatePolicyCapability({ capability: health.localUpdatePolicyCapability });
    const manifestPath = path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json');
    const capsulePath = path.join(root, 'dist-server/OID_CONTROL_CAPSULE.mjs');
    for (const file of [manifestPath, capsulePath]) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail('local_update_policy_capability_required');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const capsuleSha = createHash('sha256').update(fs.readFileSync(capsulePath)).digest('hex');
    if (manifest.capabilities?.oidDevFullPolicyV1 !== DEV_FULL_CAPABILITY
        || manifest.serverBuildId !== capability.serverLoadedBuildId || manifest.capsuleSha256 !== capsuleSha
        || capsuleSha !== capability.retainedExecutorSha256
        || health.serverBuildIdLoadedAtStartup !== capability.serverLoadedBuildId) fail('local_update_policy_capability_required');
    return capability;
}

/** Validate standing policy at a boundary; callers hold the event fence when starting effects. */
export function assertLocalUpdatePolicy(root, expected = {}) {
    const policy = readLocalUpdatePolicy(root);
    if (policy.mode !== 'dev-full-auto') fail('local_update_policy_disabled');
    if (clientPublicationPolicyEnabled(root)) fail('local_update_policy_client_conflict');
    for (const [key, value] of Object.entries(expected)) {
        if (policy[key] !== value) fail('local_update_policy_changed');
    }
    return policy;
}

/** Construct a provisional target grant; the server still validates the active owner before enqueue. */
export function createLocalUpdatePolicyGrant(root, state, capability, now = Date.now()) {
    assertLocalUpdatePolicyCapability({ capability });
    const policy = assertLocalUpdatePolicy(root);
    if (state.consent || state.prepare?.origin?.kind !== 'policy'
        || state.prepare.origin.policyRevision !== policy.revision
        || state.prepare.origin.receiptDigest !== policy.receiptDigest
        || state.prepare.ownerId !== String(policy.ownerId)
        || !HASH.test(state.targetDigest || '')) fail('local_update_policy_target_mismatch');
    const grant = { schema: 'nassaj-local-update-policy-authorization/v1', grantId: randomUUID(),
        installationId: policy.installationId, policyRevision: policy.revision, policyDigest: digest(policy),
        receiptDigest: policy.receiptDigest, ownerId: String(policy.ownerId), sequence: state.sequence,
        targetDigest: state.targetDigest, issuedAt: now, expiresAt: now + 86_400_000 };
    return { ...grant, grantDigest: digest(grant) };
}

/** Validate an explicit policy grant without synthesizing manual consent. */
export function inspectLocalUpdatePolicyGrant(root, state, now = Date.now()) {
    const grant = state?.policyAuthorization;
    if (state?.consent || grant?.schema !== 'nassaj-local-update-policy-authorization/v1') fail('local_update_policy_grant_invalid');
    const { grantDigest, ...body } = grant;
    if (!HASH.test(grantDigest || '') || digest(body) !== grantDigest || grant.sequence !== state.sequence
        || grant.targetDigest !== state.targetDigest || !Number.isSafeInteger(grant.issuedAt)
        || !Number.isSafeInteger(grant.expiresAt) || grant.issuedAt > now || grant.expiresAt <= now
        || grant.expiresAt - grant.issuedAt !== 86_400_000) fail('local_update_policy_grant_invalid');
    const policy = assertLocalUpdatePolicy(root, { revision: grant.policyRevision,
        receiptDigest: grant.receiptDigest, ownerId: Number(grant.ownerId), installationId: grant.installationId });
    if (digest(policy) !== grant.policyDigest || state.prepare?.origin?.kind !== 'policy'
        || state.prepare.origin.policyRevision !== policy.revision
        || state.prepare.origin.receiptDigest !== policy.receiptDigest
        || state.prepare.ownerId !== grant.ownerId) fail('local_update_policy_grant_invalid');
    return { kind: 'policy', ownerId: grant.ownerId, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
        targetDigest: grant.targetDigest, grantId: grant.grantId, grantDigest, policyRevision: grant.policyRevision,
        receiptDigest: grant.receiptDigest, policyDigest: grant.policyDigest };
}
