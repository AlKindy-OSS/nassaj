import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    advancePm2SingletonAttempt, createPm2SingletonAttempt, decidePm2SingletonGuard,
} from './lib/pm2-singleton-guard.mjs';

const BOOT = '00000000-0000-0000-0000-000000000001';
const ATTEMPT = '00000000-0000-0000-0000-000000000002';
const HOME = '/var/tmp/pm2-singleton-test/home/.pm2';
const id = (pid = 120) => ({ pid, startTicks: String(pid * 100), uid: process.getuid(), exe: '/usr/bin/node', bootId: BOOT });
const request = mode => ({ schema: 'nassaj-pm2-singleton-guard-request/v1', mode, homePath: HOME,
    ownerUid: process.getuid(), ownerGid: process.getgid(), bootId: BOOT, expectedExecutable: '/usr/bin/node' });
const home = () => ({ path: HOME, canonicalPath: HOME, uid: process.getuid(), gid: process.getgid(),
    mode: 0o700, dev: 10, ino: 20 });
const absent = () => ({ state: 'absent' });
function socket(peer = id(), ino = 40) {
    return { state: 'present', dev: 10, ino, uid: process.getuid(), mode: 0o600, peer, netns: 'net:[123]' };
}
function existing() {
    return { schema: 'nassaj-pm2-singleton-observation/v1', home: home(), bootId: BOOT, scanComplete: true,
        candidates: [{ readable: true, homePath: HOME, identity: id() }],
        pidfile: { state: 'present', dev: 10, ino: 30, uid: process.getuid(), mode: 0o600,
            pid: 120, fdDev: 10, fdIno: 30 }, rpc: socket(), pub: socket(id(), 41) };
}
function empty() {
    return { schema: 'nassaj-pm2-singleton-observation/v1', home: home(), bootId: BOOT, scanComplete: true,
        candidates: [], pidfile: absent(), rpc: absent(), pub: absent() };
}
function lease() {
    return { schema: 'nassaj-pm2-singleton-lease/v1', held: true, exclusive: true, verified: true,
        homeDev: 10, homeIno: 20, owner: id(900) };
}
const copy = value => structuredClone(value);
const rejects = (mode, observation, mutate, code) => {
    const changed = copy(observation); mutate(changed);
    assert.throws(() => decidePm2SingletonGuard(request(mode), changed, copy(changed), lease()),
        new RegExp(`pm2_singleton_guard_${code}`));
};
const attemptEvent = (to, evidence, attemptId = ATTEMPT) => ({
    schema: 'nassaj-pm2-singleton-attempt-event/v1', attemptId, to, evidence,
});

test('require-existing returns an immutable one-attempt envelope for one fully pinned manager', () => {
    const value = decidePm2SingletonGuard(request('require-existing'), existing(), existing(), lease());
    assert.deepEqual(value.effect, { maximumAttempts: 1, retryOnUnknown: false, requiresLeaseHeldThroughEffect: true });
    assert.equal(value.action, 'use-existing'); assert.equal(value.supervisor.pid, 120);
    assert.throws(() => { value.action = 'create-once'; }, TypeError);
});

test('allow-create admits only a clean empty home and never promises a retry', () => {
    const value = decidePm2SingletonGuard(request('allow-create'), empty(), empty(), lease());
    assert.equal(value.action, 'create-once'); assert.equal(value.supervisor, null);
    assert.equal(value.effect.maximumAttempts, 1); assert.equal(value.effect.retryOnUnknown, false);
});

test('exact schemas reject extra, missing, accessor, proxy and unsupported mode inputs', () => {
    const extra = request('allow-create'); extra.command = 'pm2';
    assert.throws(() => decidePm2SingletonGuard(extra, empty(), empty(), lease()), /keys_invalid/);
    const missing = request('allow-create'); delete missing.bootId;
    assert.throws(() => decidePm2SingletonGuard(missing, empty(), empty(), lease()), /keys_invalid/);
    const accessor = request('allow-create'); let invoked = false;
    Object.defineProperty(accessor, 'mode', { get() { invoked = true; return 'allow-create'; }, enumerable: true });
    assert.throws(() => decidePm2SingletonGuard(accessor, empty(), empty(), lease()), /keys_invalid/);
    assert.equal(invoked, false);
    assert.throws(() => decidePm2SingletonGuard(new Proxy(request('allow-create'), {}), empty(), empty(), lease()), /object_invalid/);
    const bad = request('other'); assert.throws(() => decidePm2SingletonGuard(bad, empty(), empty(), lease()), /mode_invalid/);
});

test('prototype and nested serialization traps never execute', t => {
    let calls = 0;
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { calls++; return {}; } });
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value() { calls++; return []; } });
    t.after(() => { delete Object.prototype.toJSON; delete Array.prototype.toJSON; });
    assert.equal(decidePm2SingletonGuard(request('require-existing'), existing(), existing(), lease()).action, 'use-existing');
    const own = existing();
    Object.defineProperty(own.home, 'toJSON', { enumerable: true, value() { calls++; return {}; } });
    assert.throws(() => decidePm2SingletonGuard(request('require-existing'), own, existing(), lease()), /keys_invalid/);
    const accessor = existing();
    Object.defineProperty(accessor.candidates[0].identity, 'pid', { enumerable: true, get() { calls++; return 120; } });
    assert.throws(() => decidePm2SingletonGuard(request('require-existing'), accessor, existing(), lease()), /keys_invalid/);
    const proxied = existing(); proxied.rpc.peer = new Proxy(id(), { get() { calls++; return 120; } });
    assert.throws(() => decidePm2SingletonGuard(request('require-existing'), proxied, existing(), lease()), /object_invalid/);
    assert.equal(calls, 0);
});

test('candidate arrays and nested artifacts use exact data-only schemas', () => {
    const sparse = existing(); sparse.candidates.length = 2;
    assert.throws(() => decidePm2SingletonGuard(request('require-existing'), sparse, existing(), lease()), /candidates_invalid/);
    const extra = existing(); extra.rpc.extra = true;
    assert.throws(() => decidePm2SingletonGuard(request('require-existing'), extra, existing(), lease()), /keys_invalid/);
    const nested = existing(); delete nested.pidfile.fdIno;
    assert.throws(() => decidePm2SingletonGuard(request('require-existing'), nested, existing(), lease()), /keys_invalid/);
});

test('home must be canonical, owned, mode 0700 and bound to the lease inode', () => {
    rejects('allow-create', empty(), value => { value.home.canonicalPath += '/other'; }, 'home_not_canonical');
    rejects('allow-create', empty(), value => { value.home.uid++; }, 'home_changed');
    rejects('allow-create', empty(), value => { value.home.mode = 0o755; }, 'home_mode_invalid');
    const changedLease = lease(); changedLease.homeIno++;
    assert.throws(() => decidePm2SingletonGuard(request('allow-create'), empty(), empty(), changedLease), /lease_home_changed/);
});

test('lease contention, expiry-like loss and unverifiable ownership fail closed', () => {
    for (const key of ['held', 'exclusive', 'verified']) {
        const changed = lease(); changed[key] = false;
        assert.throws(() => decidePm2SingletonGuard(request('allow-create'), empty(), empty(), changed), /lease_unverified/);
    }
    const changed = lease(); changed.owner.startTicks = '0';
    assert.throws(() => decidePm2SingletonGuard(request('allow-create'), empty(), empty(), changed), /start_ticks_invalid/);
});

test('incomplete scans, hidden second managers and unreadable candidates refuse', () => {
    rejects('require-existing', existing(), value => { value.scanComplete = false; }, 'process_scan_incomplete');
    rejects('require-existing', existing(), value => { value.candidates.push({ readable: true, homePath: HOME, identity: id(121) }); },
        'multiple_managers');
    rejects('require-existing', existing(), value => { value.candidates[0].readable = false; }, 'candidate_unreadable');
});

test('manager identity pins boot, pid/start, uid, executable and PM2 home', () => {
    rejects('require-existing', existing(), value => { value.candidates[0].identity.bootId = BOOT.replace(/1$/, '2'); },
        'manager_identity_invalid');
    rejects('require-existing', existing(), value => { value.candidates[0].identity.uid++; }, 'manager_identity_invalid');
    rejects('require-existing', existing(), value => { value.candidates[0].identity.exe = '/usr/bin/other'; },
        'manager_executable_changed');
    rejects('require-existing', existing(), value => { value.candidates[0].homePath += '-other'; }, 'manager_home_changed');
});

test('pidfile FD identity and both socket peer identities are mandatory', () => {
    rejects('require-existing', existing(), value => { value.pidfile.fdIno++; }, 'pidfile_identity_mismatch');
    rejects('require-existing', existing(), value => { value.pidfile.pid++; }, 'pidfile_identity_mismatch');
    rejects('require-existing', existing(), value => { value.rpc.peer.startTicks = '99'; }, 'socket_peer_mismatch');
    rejects('require-existing', existing(), value => { value.pub.peer.pid++; }, 'socket_peer_mismatch');
    rejects('require-existing', existing(), value => { value.pub.netns = 'net:[124]'; }, 'socket_netns_mismatch');
    rejects('require-existing', existing(), value => { value.pub.ino = value.rpc.ino; }, 'socket_identity_collision');
});

test('artifact mode is permission bits 0..07777 without integer coercion', () => {
    rejects('require-existing', existing(), value => { value.rpc.mode = 0o10000; }, 'artifact_mode_invalid');
    rejects('require-existing', existing(), value => { value.rpc.mode = 0o600 + 0.5; }, 'artifact_mode_invalid');
    rejects('require-existing', existing(), value => { value.rpc.mode = 0o620; }, 'artifact_permissions_invalid');
    rejects('require-existing', existing(), value => { value.rpc.mode = 0o602; }, 'artifact_permissions_invalid');
});

test('allow-create refuses stale artifacts and any already-visible manager', () => {
    rejects('allow-create', empty(), value => { value.pidfile = existing().pidfile; }, 'stale_artifact');
    rejects('allow-create', empty(), value => { value.rpc = socket(); }, 'stale_artifact');
    rejects('allow-create', empty(), value => { value.candidates = existing().candidates; }, 'manager_already_exists');
});

test('every observation boundary refuses drift, including a manager appearing during create', () => {
    const after = empty(); after.candidates = existing().candidates;
    assert.throws(() => decidePm2SingletonGuard(request('allow-create'), empty(), after, lease()), /observation_drift/);
    const existingAfter = existing(); existingAfter.pidfile.ino++;
    assert.throws(() => decidePm2SingletonGuard(request('require-existing'), existing(), existingAfter, lease()), /observation_drift/);
});

test('attempt validator permits one intent and one send through a stable lease', () => {
    const decision = decidePm2SingletonGuard(request('allow-create'), empty(), empty(), lease());
    let record = createPm2SingletonAttempt(decision, ATTEMPT, lease());
    assert.equal(record.state, 'PRECHECKED');
    record = advancePm2SingletonAttempt(record, attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision);
    assert.equal(record.state, 'EFFECT_INTENT');
    assert.throws(() => advancePm2SingletonAttempt(record,
        attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision), /attempt_transition_invalid/);
    record = advancePm2SingletonAttempt(record, attemptEvent('EFFECT_SENT', { dispatch: 'sent' }), lease(), decision);
    record = advancePm2SingletonAttempt(record, attemptEvent('POSTCHECKED', { result: 'verified' }), lease(), decision);
    assert.equal(record.state, 'POSTCHECKED'); assert.equal(record.events.length, 3);
});

test('attempt identity and lease remain fixed at precheck, intent and postcheck boundaries', () => {
    const decision = decidePm2SingletonGuard(request('require-existing'), existing(), existing(), lease());
    const wrongInitial = lease(); wrongInitial.owner.startTicks = '999';
    assert.throws(() => createPm2SingletonAttempt(decision, ATTEMPT, wrongInitial), /lease_identity_changed/);
    let record = createPm2SingletonAttempt(decision, ATTEMPT, lease());
    assert.throws(() => advancePm2SingletonAttempt(record,
        attemptEvent('EFFECT_INTENT', { action: 'use-existing' }, BOOT), lease(), decision), /attempt_changed/);
    const wrongIntent = lease(); wrongIntent.owner.pid++;
    assert.throws(() => advancePm2SingletonAttempt(record,
        attemptEvent('EFFECT_INTENT', { action: 'use-existing' }), wrongIntent, decision), /lease_identity_changed/);
    record = advancePm2SingletonAttempt(record, attemptEvent('EFFECT_INTENT', { action: 'use-existing' }), lease(), decision);
    record = advancePm2SingletonAttempt(record, attemptEvent('EFFECT_SENT', { dispatch: 'sent' }), lease(), decision);
    const wrongPost = lease(); wrongPost.homeIno++;
    assert.throws(() => advancePm2SingletonAttempt(record,
        attemptEvent('POSTCHECKED', { result: 'verified' }), wrongPost, decision), /lease_identity_changed/);
});

test('UNKNOWN is terminal and cannot retry or invoke an effect inside the library', () => {
    const decision = decidePm2SingletonGuard(request('allow-create'), empty(), empty(), lease());
    let record = createPm2SingletonAttempt(decision, ATTEMPT, lease());
    record = advancePm2SingletonAttempt(record, attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision);
    record = advancePm2SingletonAttempt(record,
        attemptEvent('UNKNOWN', { reason: 'effect_outcome_unknown' }), lease(), decision);
    assert.equal(record.state, 'UNKNOWN');
    assert.throws(() => advancePm2SingletonAttempt(record,
        attemptEvent('EFFECT_SENT', { dispatch: 'sent' }), lease(), decision), /attempt_capability_unavailable/);
});

test('attempt schemas reject nested toJSON, accessors, proxies and projection tampering without callbacks', () => {
    const decision = decidePm2SingletonGuard(request('allow-create'), empty(), empty(), lease());
    const record = createPm2SingletonAttempt(decision, ATTEMPT, lease()); let calls = 0;
    const own = copy(record); own.leaseIdentity.owner.toJSON = () => { calls++; return {}; };
    assert.throws(() => advancePm2SingletonAttempt(own,
        attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision), /attempt_capability_unavailable/);
    const accessor = copy(record);
    Object.defineProperty(accessor.home, 'ino', { enumerable: true, get() { calls++; return 20; } });
    assert.throws(() => advancePm2SingletonAttempt(accessor,
        attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision), /attempt_capability_unavailable/);
    const proxied = copy(record); proxied.leaseIdentity.owner = new Proxy(id(900), { get() { calls++; return 1; } });
    assert.throws(() => advancePm2SingletonAttempt(proxied,
        attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision), /attempt_capability_unavailable/);
    const projection = copy(record); projection.state = 'EFFECT_SENT';
    assert.throws(() => advancePm2SingletonAttempt(projection,
        attemptEvent('POSTCHECKED', { result: 'verified' }), lease(), decision), /attempt_capability_unavailable/);
    assert.equal(calls, 0);
});

test('cloned or co-forged decision and attempt cannot cross the in-process capability boundary', () => {
    const issued = decidePm2SingletonGuard(request('allow-create'), empty(), empty(), lease());
    const record = createPm2SingletonAttempt(issued, ATTEMPT, lease());
    const clonedDecision = copy(issued);
    assert.throws(() => createPm2SingletonAttempt(clonedDecision, ATTEMPT, lease()), /decision_provenance_invalid/);
    assert.throws(() => advancePm2SingletonAttempt(record,
        attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), clonedDecision), /decision_provenance_invalid/);
    const forgedRecord = copy(record); const forgedDecision = copy(issued);
    forgedRecord.mode = 'require-existing'; forgedRecord.action = 'use-existing';
    forgedDecision.mode = 'require-existing'; forgedDecision.action = 'use-existing';
    assert.throws(() => advancePm2SingletonAttempt(forgedRecord,
        attemptEvent('EFFECT_INTENT', { action: 'use-existing' }), lease(), forgedDecision),
    /decision_provenance_invalid|attempt_capability_unavailable/);
});

test('decision and every nonterminal attempt stage are one-shot capabilities', () => {
    const decision = decidePm2SingletonGuard(request('allow-create'), empty(), empty(), lease());
    assert.throws(() => createPm2SingletonAttempt(decision, 'bad-id', lease()), /attempt_id_invalid/);
    const prechecked = createPm2SingletonAttempt(decision, ATTEMPT, lease());
    assert.throws(() => createPm2SingletonAttempt(decision, ATTEMPT, lease()), /decision_capability_spent/);

    const intent = advancePm2SingletonAttempt(prechecked,
        attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision);
    assert.throws(() => advancePm2SingletonAttempt(prechecked,
        attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), decision), /attempt_capability_unavailable/);

    const sent = advancePm2SingletonAttempt(intent,
        attemptEvent('EFFECT_SENT', { dispatch: 'sent' }), lease(), decision);
    assert.throws(() => advancePm2SingletonAttempt(intent,
        attemptEvent('EFFECT_SENT', { dispatch: 'sent' }), lease(), decision), /attempt_capability_unavailable/);

    const done = advancePm2SingletonAttempt(sent,
        attemptEvent('POSTCHECKED', { result: 'verified' }), lease(), decision);
    assert.equal(done.state, 'POSTCHECKED');
    assert.throws(() => advancePm2SingletonAttempt(sent,
        attemptEvent('POSTCHECKED', { result: 'verified' }), lease(), decision), /attempt_capability_unavailable/);
    assert.throws(() => advancePm2SingletonAttempt(done,
        attemptEvent('UNKNOWN', { reason: 'postcheck_failed' }), lease(), decision), /attempt_capability_unavailable/);
});

test('trusted decision independently rejects record mode, action and home reconstruction', () => {
    const trusted = decidePm2SingletonGuard(request('allow-create'), empty(), empty(), lease());
    assert.equal(trusted.mode, 'allow-create'); assert.equal(trusted.action, 'create-once');
    assert.deepEqual(trusted.home, { path: HOME, canonicalPath: HOME, uid: process.getuid(), gid: process.getgid(),
        mode: 0o700, dev: 10, ino: 20 });
    const base = createPm2SingletonAttempt(trusted, ATTEMPT, lease());
    const attacks = [
        record => { record.mode = 'require-existing'; },
        record => { record.action = 'use-existing'; },
        record => { record.home.path = '/var/tmp/attacker/.pm2'; record.home.canonicalPath = '/var/tmp/attacker/.pm2'; },
        record => { record.home.uid += 1; },
        record => { record.home.gid += 1; },
        record => { record.home.mode = 0o750; },
        record => { record.home.dev += 1; },
        record => { record.home.ino += 1; },
    ];
    for (const attack of attacks) {
        const changed = copy(base); attack(changed);
        assert.throws(() => advancePm2SingletonAttempt(changed,
            attemptEvent('EFFECT_INTENT', { action: 'create-once' }), lease(), trusted),
        /pm2_singleton_guard_/);
    }
});

test('private /var/tmp fixture and host sentinel remain untouched', t => {
    const host = path.join(os.homedir(), '.pm2');
    const names = ['pm2.pid', 'rpc.sock', 'pub.sock', 'dump.pm2'];
    const sentinel = names.map(name => {
        try { const stat = fs.lstatSync(path.join(host, name)); return [name, stat.dev, stat.ino, stat.mtimeNs]; }
        catch (error) { assert.equal(error.code, 'ENOENT'); return [name, 'absent']; }
    });
    const root = fs.mkdtempSync('/var/tmp/pm2-singleton-'); fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const privateHome = path.join(root, 'home/.pm2'); fs.mkdirSync(privateHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, 'home'), 0o700); fs.chmodSync(privateHome, 0o700);
    const stat = fs.statSync(privateHome);
    const observed = empty(); observed.home = { path: privateHome, canonicalPath: fs.realpathSync(privateHome),
        uid: stat.uid, gid: stat.gid, mode: stat.mode % 0o10000, dev: stat.dev, ino: stat.ino };
    const req = { ...request('allow-create'), homePath: privateHome, ownerUid: stat.uid, ownerGid: stat.gid };
    const held = { ...lease(), homeDev: stat.dev, homeIno: stat.ino };
    assert.equal(decidePm2SingletonGuard(req, observed, copy(observed), held).action, 'create-once');
    assert.deepEqual(fs.readdirSync(privateHome), []);
    assert.deepEqual(names.map(name => {
        try { const current = fs.lstatSync(path.join(host, name)); return [name, current.dev, current.ino, current.mtimeNs]; }
        catch (error) { assert.equal(error.code, 'ENOENT'); return [name, 'absent']; }
    }), sentinel);
});
