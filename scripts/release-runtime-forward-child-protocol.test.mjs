import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { assertForwardServiceIdentity, dropForwardChildPrivileges, inspectForwardChildIdentity,
    readForwardPermitFrame } from './lib/release-runtime-forward-child-protocol.mjs';

const service = { uid: 1000, gid: 1000, supplementaryGids: [1000, 1001] };
const observed = () => ({ pid: 42, uids: [1000, 1000, 1000, 1000], gids: [1000, 1000, 1000, 1000],
    supplementaryGids: [1000, 1001], capabilities: ['00000000', '00000000', '00000000'] });
test('permit requires EOF and does not resolve on the first newline alone', async () => {
    const stream = new PassThrough(); let completed = false;
    const pending = readForwardPermitFrame(stream).then(value => { completed = true; return value; });
    stream.write('{"decision":"authorized"}\n'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false); stream.end(); assert.equal((await pending).decision, 'authorized');
});
test('duplicate, trailing, oversized and incomplete permit frames deny', async t => {
    for (const frame of ['{}\n{}\n', '{}\ntrailing', '{}', `${'x'.repeat(16_384)}\n`]) await t.test(String(frame.length), async () => {
        const stream = new PassThrough(); stream.end(frame);
        await assert.rejects(readForwardPermitFrame(stream));
    });
});
test('parent silence times out before an import could be authorized', async () => {
    await assert.rejects(readForwardPermitFrame(new PassThrough(), 10), /handshake_timeout/);
});
test('privilege-drop ordering is groups, gid, uid, then real kernel observation seam', () => {
    const calls = []; const identity = dropForwardChildPrivileges(service, { process: { pid: 42,
        setgroups: groups => calls.push(['groups', groups]), setgid: gid => calls.push(['gid', gid]), setuid: uid => calls.push(['uid', uid]) },
        inspect: pid => { calls.push(['inspect', pid]); return observed(); } });
    assert.deepEqual(calls, [['groups', [1000, 1001]], ['gid', 1000], ['uid', 1000], ['inspect', 42]]);
    assert.equal(identity.pid, 42);
});
test('saved UID, extra supplementary group and ambient capability reject after drop', async t => {
    for (const kind of ['saved', 'group', 'capability']) await t.test(kind, () => {
        const identity = observed();
        if (kind === 'saved') identity.uids[2] = 0;
        if (kind === 'group') identity.supplementaryGids.push(1002);
        if (kind === 'capability') identity.capabilities[2] = '00000001';
        assert.throws(() => assertForwardServiceIdentity(identity, service), /identity_mismatch/);
    });
});
test('actual kernel observation returns this process identity without a caller supplied identity', () => {
    const identity = inspectForwardChildIdentity(process.pid);
    assert.equal(identity.pid, process.pid); assert.equal(identity.parentPid, process.ppid);
    assert.equal(identity.uids[0], process.getuid()); assert.equal(identity.gids[0], process.getgid());
    assert.match(identity.startTicks, /^\d+$/); assert.equal(identity.capabilities.length, 3);
});
test('invalid policy denies before the first credential syscall', () => {
    let calls = 0;
    for (const expected of [{ ...service, uid: 0 }, { ...service, gid: -1 }, { ...service, supplementaryGids: [2, 1] }]) {
        assert.throws(() => dropForwardChildPrivileges(expected, { process: { setgroups() { calls++; } } }), /policy_invalid/);
    }
    assert.equal(calls, 0);
});
test('invalid timeouts deny before starting a protocol reader', async () => {
    for (const timeout of [0, -1, 10_001, 1.1, NaN]) await assert.rejects(readForwardPermitFrame(new PassThrough(), timeout), /timeout_invalid/);
});
