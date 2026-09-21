/** Strict, built-ins-only ADR-160 target and consent serialization. */
import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const SCHEMA = 'nassaj-oid-triple-target/v2';
const HASH_FIELDS = ['clientBuildId', 'serverBuildId', 'clientTreeSha256', 'serverTreeSha256',
    'nodeModulesTreeSha256', 'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256',
    'installPolicySha256', 'controlManifestSha256'];
const RUNTIME_FIELDS = ['nodeBinarySha256', 'nodeVersion', 'nodeModuleAbi', 'napi', 'platform', 'arch', 'npmVersion', 'npmCliSha256'];
const fail = () => { throw Object.assign(new Error('local_update_invalid_triple_target'), { code: 'local_update_invalid_triple_target' }); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Serialize identities with recursively sorted keys and unchanged array order. */
export function canonicalTripleJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalTripleJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalTripleJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

/** Reject incomplete, extended or ambiguous v2 descriptors rather than falling back to a pair. */
export function validateOidTripleTargetDescriptor(target) {
    if (!exactKeys(target, ['schema', 'generationNames', ...HASH_FIELDS, 'installRuntime'])
        || target.schema !== SCHEMA
        || JSON.stringify(target.generationNames) !== '["nodeModules","server","client"]'
        || HASH_FIELDS.some(key => !HASH.test(target[key] || ''))
        || !exactKeys(target.installRuntime, RUNTIME_FIELDS)) fail();
    const runtime = target.installRuntime;
    if (!HASH.test(runtime.nodeBinarySha256 || '') || !HASH.test(runtime.npmCliSha256 || '')
        || !/^v\d+\.\d+\.\d+$/.test(runtime.nodeVersion || '')
        || !/^\d+\.\d+\.\d+$/.test(runtime.npmVersion || '')
        || !/^\d+$/.test(runtime.nodeModuleAbi || '') || typeof runtime.nodeModuleAbi !== 'string'
        || !/^\d+$/.test(runtime.napi || '') || typeof runtime.napi !== 'string'
        || !/^[a-z0-9_]{1,32}$/.test(runtime.platform || '')
        || !/^[a-z0-9_]{1,32}$/.test(runtime.arch || '')) fail();
    return target;
}

/** Bind owner consent to the full three-generation target and immutable local event. */
export function computeOidTripleTargetDigest({ sequence, group, sourceOid, target }) {
    validateOidTripleTargetDescriptor(target);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !OID.test(sourceOid || '')
        || group !== `event-${String(sequence).padStart(16, '0')}`) fail();
    return createHash('sha256').update(canonicalTripleJson({ schema: 'nassaj-oid-triple-consent/v2',
        sequence, group, sourceOid, target })).digest('hex');
}
