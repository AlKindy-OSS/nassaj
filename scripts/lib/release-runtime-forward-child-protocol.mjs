/** Core-only direct-child protocol. No database/native/application imports are allowed here. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** Resolve the fixed system Bash name, accepting only the two standard canonical layouts. */
export function resolveForwardBashPath() {
    const canonical = fs.realpathSync('/bin/bash');
    if (!['/usr/bin/bash', '/bin/bash'].includes(canonical)) throw Error('forward_bash_system_path_invalid');
    return canonical;
}

export const canonicalForwardValue = value => Array.isArray(value) ? `[${value.map(canonicalForwardValue).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalForwardValue(value[key])}`).join(',')}}` : JSON.stringify(value);
export const forwardValueSha256 = value => createHash('sha256').update(canonicalForwardValue(value)).digest('hex');
/** Reject unknown protocol authority fields rather than ignoring them. */
export function assertForwardFrameKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) throw Error('forward_child_frame_invalid');
}
/** A permit must be exactly one bounded JSON line followed by EOF before any database import. */
export async function readForwardPermitFrame(stream, timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw Error('forward_child_timeout_invalid');
    let timer; let size = 0; const chunks = [];
    const read = async () => {
        for await (const chunk of stream) {
            const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > 16_384) throw Error('forward_child_frame_large'); chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks).toString('utf8');
        if (!bytes.endsWith('\n') || bytes.indexOf('\n') !== bytes.length - 1) throw Error('forward_child_frame_trailing');
        return JSON.parse(bytes.slice(0, -1));
    };
    try { return await Promise.race([read(), new Promise((_, reject) => {
        timer = setTimeout(() => { stream.destroy(); reject(Error('forward_child_handshake_timeout')); }, timeoutMs);
    })]); } finally { clearTimeout(timer); }
}
/** Observe real/effective/saved/fs credentials and capabilities directly from the kernel. */
export function inspectForwardChildIdentity(pid, read = file => fs.readFileSync(file, 'utf8')) {
    const bootId = read('/proc/sys/kernel/random/boot_id').trim();
    const before = read(`/proc/${pid}/stat`); const status = read(`/proc/${pid}/status`);
    const fields = before.slice(before.lastIndexOf(')') + 2).trim().split(' ');
    const after = read(`/proc/${pid}/stat`); const second = after.slice(after.lastIndexOf(')') + 2).trim().split(' ');
    if (fields[19] !== second[19] || fields[1] !== second[1] || bootId !== read('/proc/sys/kernel/random/boot_id').trim()
        || ['Z', 'X'].includes(second[0])) throw Error('forward_child_process_changed');
    const numeric = name => {
        const match = new RegExp(`^${name}:[ \t]*(.*)$`, 'm').exec(status);
        if (!match) throw Error('forward_child_credentials_missing'); return match[1].trim() ? match[1].trim().split(/\s+/).map(Number) : [];
    };
    const caps = ['CapEff', 'CapPrm', 'CapAmb'].map(name => {
        const value = new RegExp(`^${name}:\\s+([a-f0-9]+)$`, 'mi').exec(status)?.[1];
        if (!value) throw Error('forward_child_capabilities_missing'); return value;
    });
    return { pid, parentPid: Number(fields[1]), startTicks: fields[19], bootId, uids: numeric('Uid'), gids: numeric('Gid'),
        supplementaryGids: numeric('Groups').sort((a, b) => a - b), capabilities: caps };
}
/** Validate the reviewed identity policy before any credential-changing syscall. */
export function assertForwardServicePolicy(expected) {
    const groups = expected?.supplementaryGids;
    if (!Number.isSafeInteger(expected?.uid) || expected.uid <= 0 || !Number.isSafeInteger(expected?.gid) || expected.gid <= 0
        || !Array.isArray(groups) || groups.some((gid, i) => !Number.isSafeInteger(gid) || gid < 0 || (i > 0 && groups[i - 1] >= gid))) throw Error('forward_child_service_policy_invalid');
}
/** Validate the exact approved service identity; a boolean privilege assertion is never accepted. */
export function assertForwardServiceIdentity(identity, expected) {
    assertForwardServicePolicy(expected); const groups = expected.supplementaryGids;
    if (identity.uids.length !== 4 || identity.gids.length !== 4
        || !identity.uids.every(uid => uid === expected.uid) || !identity.gids.every(gid => gid === expected.gid)
        || canonicalForwardValue(identity.supplementaryGids) !== canonicalForwardValue(groups)
        || identity.capabilities.length !== 3 || identity.capabilities.some(value => !/^0+$/.test(value))) throw Error('forward_child_service_identity_mismatch');
}
/** Drop groups first, then all group/user identities, and verify the kernel result before returning. */
export function dropForwardChildPrivileges(expected, deps = {}) {
    assertForwardServicePolicy(expected);
    const processApi = deps.process || process;
    processApi.setgroups(expected.supplementaryGids); processApi.setgid(expected.gid); processApi.setuid(expected.uid);
    const observed = (deps.inspect || inspectForwardChildIdentity)(processApi.pid);
    assertForwardServiceIdentity(observed, expected); return observed;
}
