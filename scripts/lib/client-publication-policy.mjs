/** Installation-bound publication authority; configuration in candidates cannot enable it. */
import fs from 'node:fs';
import path from 'node:path';
import { commonGitDir, gitControlPath } from '../git-control-root.mjs';

export const CLIENT_PUBLICATION_POLICY = 'nassaj-client-publication-policy-v1.json';
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Read through pinned directories, refusing redirects, writable authority and special files. */
export function readPublicationControlJson(file, uid = process.getuid()) {
    if (!path.isAbsolute(file) || path.resolve(file) !== file) fail('client_publication_control_path');
    fs.lstatSync(file); // Absence grants no authority and must default off even on unqualified installations.
    const descriptors = [];
    let directory = '/';
    let privateAncestor = false;
    try {
        const parts = file.slice(1).split('/');
        for (const [index, part] of parts.entries()) {
            const last = index === parts.length - 1;
            const fd = fs.openSync(path.join(directory, part), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
                | fs.constants.O_NONBLOCK | (last ? 0 : fs.constants.O_DIRECTORY));
            descriptors.push(fd);
            const stat = fs.fstatSync(fd);
            if ((!privateAncestor && (stat.mode & 0o022) !== 0) || ![0, uid].includes(stat.uid)) fail('client_publication_control_permissions');
            if (!last && stat.uid === uid && (stat.mode & 0o077) === 0) privateAncestor = true;
            if (last) {
                if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) fail('client_publication_control_file');
                return JSON.parse(fs.readFileSync(fd, 'utf8'));
            }
            directory = `/proc/self/fd/${fd}`;
        }
    } finally { for (const fd of descriptors.reverse()) fs.closeSync(fd); }
}

/** Missing policy defaults off; malformed or foreign policy fails closed. Binding must be loaded authority. */
export function readClientPublicationPolicy(root, binding = null) {
    let policy;
    try { policy = readPublicationControlJson(gitControlPath(root, CLIENT_PUBLICATION_POLICY)); }
    catch (error) { if (error.code === 'ENOENT') return { mode: 'button-only', revision: 0 }; throw error; }
    if (policy?.schema !== 'nassaj-client-publication-policy/v1'
        || !['button-only', 'dev-client-auto'].includes(policy.mode)
        || !Number.isSafeInteger(policy.revision) || policy.revision < 1
        || !Number.isSafeInteger(policy.serviceUid) || policy.serviceUid < 0
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(policy.installationId || '')
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(policy.serviceIdentity || '')
        || policy.canonicalProjectRoot !== fs.realpathSync(root)
        || policy.canonicalGitCommonDir !== commonGitDir(root)
        || policy.serviceUid !== process.getuid()) fail('client_publication_policy_invalid');
    if (policy.mode === 'button-only') return policy;
    for (const key of ['installationId', 'canonicalProjectRoot', 'canonicalGitCommonDir', 'serviceIdentity', 'serviceUid']) {
        if (binding?.[key] !== policy[key]) fail('client_publication_installation_mismatch');
    }
    for (const capability of ['executor', 'state', 'static', 'rollback']) {
        if (binding.capabilities?.[capability] !== 'nassaj-dev-client-publication/v1') fail('client_publication_capability_unqualified');
    }
    if (!/^[a-f0-9]{64}$/.test(binding.baseReceiptDigest || '')
        || !/^[a-f0-9]{40}$/.test(binding.serverIdentity?.sourceOid || '')
        || !/^[a-f0-9]{64}$/.test(binding.serverIdentity?.buildId || '')
        || !Number.isSafeInteger(binding.serverIdentity?.pid) || binding.serverIdentity.pid < 1
        || !/^\d+$/.test(binding.serverIdentity?.startTime || '')) fail('client_publication_loaded_baseline_unproven');
    return policy;
}

/** Recheck policy identity and revision immediately before reserving or starting an effect. */
export function assertClientPublicationPolicy(root, binding, revision) {
    const policy = readClientPublicationPolicy(root, binding);
    if (policy.mode !== 'dev-client-auto') fail('client_publication_policy_disabled');
    if (revision !== undefined && policy.revision !== revision) fail('client_publication_policy_changed');
    return policy;
}

/** Read only the installed policy disposition; enabling still requires the full bound authority check. */
export function clientPublicationPolicyEnabled(root) {
    let value;
    try { value = readPublicationControlJson(gitControlPath(root, CLIENT_PUBLICATION_POLICY)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (value.schema !== 'nassaj-client-publication-policy/v1' || !['button-only', 'dev-client-auto'].includes(value.mode)) fail('client_publication_policy_invalid');
    return value.mode === 'dev-client-auto';
}
