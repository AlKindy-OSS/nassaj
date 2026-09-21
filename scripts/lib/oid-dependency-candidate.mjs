/** Dependency generation evidence in the existing canonical local preview store. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashDependencyTreeV2 } from './dependency-tree-identity-v2.mjs';
import { canonicalTripleJson } from './oid-triple-target.mjs';

const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Bind the package bytes, install policy, interpreter and installed generation without mutable paths. */
export function computeDependencyContractV2(fields) {
    return digest(canonicalTripleJson({ schema: 'nassaj-dependency-contract/v2',
        packageJsonSha256: fields.packageJsonSha256, packageLockSha256: fields.packageLockSha256,
        installRuntime: fields.installRuntime, installPolicySha256: fields.installPolicySha256,
        nodeModulesTreeSha256: fields.nodeModulesTreeSha256 }));
}

/** Verify canonical, read-only generation contents and its durable preparation evidence. */
export function verifyOidDependencyCandidate(root, target) {
    if (!HASH.test(target.nodeModulesTreeSha256 || '') || !HASH.test(target.dependencyContractSha256 || '')) fail('local_update_invalid_dependency_identity');
    const parent = path.join(root, '.nassaj-local-preview', 'dependency-candidates');
    const evidenceParent = path.join(root, '.nassaj-local-preview', 'dependency-evidence');
    for (const directory of [root, path.dirname(parent), parent, evidenceParent]) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)
            || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) fail('local_update_unsafe_dependency_store');
    }
    const tree = hashDependencyTreeV2(path.join(parent, target.nodeModulesTreeSha256), { requireSealed: true });
    const fd = fs.openSync(path.join(evidenceParent, `${target.dependencyContractSha256}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let evidence;
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) fail('local_update_unsafe_dependency_evidence');
        evidence = JSON.parse(fs.readFileSync(fd));
    } finally { fs.closeSync(fd); }
    if (evidence.schema !== 'nassaj-oid-dependency-candidate/v2' || tree.sha256 !== target.nodeModulesTreeSha256
        || canonicalTripleJson(evidence.tree) !== canonicalTripleJson(tree)
        || digest(canonicalTripleJson(evidence.installPolicy)) !== target.installPolicySha256
        || computeDependencyContractV2(evidence) !== target.dependencyContractSha256) fail('local_update_dependency_candidate_changed');
    const proof = evidence.nativeProbe;
    if (proof?.schema !== 'nassaj-oid-native-probe/v2' || proof.processExited !== true
        || proof.nodeModulesTreeSha256 !== tree.sha256 || proof.nodeVersion !== target.installRuntime.nodeVersion
        || proof.nodeModuleAbi !== target.installRuntime.nodeModuleAbi) fail('local_update_native_probe_unverified');
    for (const key of ['nodeModulesTreeSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'dependencyContractSha256', 'installRuntime']) {
        if (canonicalTripleJson(target[key]) !== canonicalTripleJson(evidence[key])) fail('local_update_dependency_candidate_changed');
    }
    return evidence;
}
