import {withVerifiedCutoverStateMutex} from './lib/release-runtime-state-mutex.mjs';
import {installFixedStateMutexAuthority} from './fixtures/fixed-state-mutex-authority.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { initializeFirstForwardOperation, completeFirstForwardRetirement } from './lib/release-runtime-forward-initialization.mjs';
import { invalidateCutoverStartupAdmission } from './lib/release-runtime-cutover.mjs';
import { execFile } from 'node:child_process';
import { canonicalForwardValue, forwardValueSha256 as digest } from './lib/release-runtime-forward-child-protocol.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Fixture seams: root ownership, executable pin reads, systemd/ingress, PM2 and process observations.
// Signature verification, state locks/fsync, saved-file writes and retirement validation use actual code.
function fixture(t) {
    const root = fs.mkdtempSync(path.resolve('.artifacts/forward-initialization-')); fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const save = (name, value) => { const p = path.join(root, name); fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 }); return p; };
    const load = name => JSON.parse(fs.readFileSync(path.join(root, name)));
    const lstat = fs.lstatSync; const fstat = fs.fstatSync; const mockedInodes = new Set();
    t.mock.method(fs, 'lstatSync', (p, ...args) => { const info = lstat(p, ...args); if (['approval', 'key', 'inventory'].includes(path.basename(String(p))) && String(p).startsWith(root)) { info.uid = 0; mockedInodes.add(info.ino); } return info; });
    t.mock.method(fs, 'fstatSync', (...args) => { const info = fstat(...args); if (mockedInodes.has(info.ino)) info.uid = 0; return info; });
    const processInfo = { pid: process.pid, startTicks: '12', bootId: 'boot-fixture', uids: [0, 0, 0, 0] };
    let oldGone = false;
    const inspect = pid => { if (pid === 123456789 && !oldGone) return { pid, startTicks: '2', bootId: 'boot-fixture', uids: [1000, 1000, 1000, 1000], state: 'S' }; if (pid !== process.pid) throw Object.assign(Error('gone'), { code: 'ENOENT' }); return processInfo; };
    save('first-cutover.lock', { schema: 'nassaj-cutover-lock/v1', pid: process.pid, startTime: '12' });
    const db = save('database', {}); const stat = fs.statSync(db, { bigint: true });
    const contract = { schema: 'nassaj-database-release-contract/v2', migrationClosureSha256: 'b'.repeat(64) };
    const unit = { Id: 'worker.service', LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled', ControlGroup: '/worker',
        FragmentPath: '/fixture/worker.service', DropInPaths: '', ExecStart: '/fixture/worker', ExecStartPre: '' };
    const pin = { path: '/fixture/pinned', sha256: 'a'.repeat(64) };
    const sibling = { name: 'neighbor', namespace: 'default', secretFixture: 'preserve-whole-entry', env: { nested: [1, 2] } };
    const dump = save('dump', [sibling, { name: 'nassaj-dev', namespace: 'default' }]);
    const inventory = save('inventory', { source: 'fixture' });
    const supervisorPlan = { slot: { pm2Id: 4, name: 'nassaj-dev', namespace: 'default' }, pm2: { observer: { daemon: { pid: 54321 } } }, sources: [
        { sourceId: 'dump', path: dump, format: 'pm2-dump-json', beforeSha256: sha(fs.readFileSync(dump)), writerSourceIds: ['worker'] } ] };
    const mutatorPlan = { systemctl: { path: inventory, sha256: sha(fs.readFileSync(inventory)) },
        sources: [{ sourceId: 'worker', scope: 'system', unit: 'worker.service', cgroupPath: '/worker', configurationSha256: digest(unit) }],
        inventory: [{ kind: 'file', path: inventory, sha256: sha(fs.readFileSync(inventory)) }] };
    const identity = { releaseIdentitySha256: 'c'.repeat(64), databaseContractSha256: digest(contract), databaseDev: String(stat.dev), databaseIno: String(stat.ino) };
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = path.join(root, 'key'); fs.writeFileSync(key, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const expected = { supervisorPlanSha256: digest(supervisorPlan), mutatorPlanSha256: digest(mutatorPlan),
        forwardExecutableClosureSha256: pin.sha256, ownerApprovalKeySha256: sha(publicKey.export({ type: 'spki', format: 'der' })) };
    const payload = { schema: 'nassaj-owner-cutover-approval/v1', action: 'release-runtime-first-cutover', expectedSha256: digest(expected),
        startupAdmission: identity, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 120000 };
    const approval = save('approval', { ...payload, signature: sign(null, Buffer.from(canonicalForwardValue(payload)), privateKey).toString('base64url') });
    const request = { schema: 'nassaj-compatible-forward-request/v1', transactionId: 'initialization-fixture-operation', expectedPhase: 'migration',
        releaseIdentitySha256: identity.releaseIdentitySha256, databaseContractSha256: digest(contract), database: { realpath: db, device: String(stat.dev), inode: String(stat.ino) } };
    const config = { controlRoot: root, databaseFile: db, expected, oldProcess: { pid: 123456789, startTicks: '2', bootId: 'boot-fixture' },
        bootstrapClaim: { identity, approvalFile: approval, ownerApprovalPublicKeyFile: key },
        forwardMigration: { serviceIdentity: { uid: 1000 }, node: pin, parent: pin, wrapper: pin, entry: pin, closure: pin, request: { path: 'request' }, contract: { path: 'contract' } },
        forwardActivation: { supervisorPlan, mutatorPlan, safeRestart: pin, dispatcher: pin } };
    const authority = installFixedStateMutexAuthority(t,root,config);
    const calls = []; const runtime = { entries: [{ pmId: 4, name: 'nassaj-dev', namespace: 'default', pid: 123456789, status: 'online' }], observationSha256: 'd'.repeat(64) };
    const exec = (_p, args) => {
        calls.push(args[0]);
        if (args[0] === 'mask') { unit.LoadState = 'masked'; unit.UnitFileState = 'masked'; return ''; }
        if (args[0] === 'stop') { unit.ActiveState = 'inactive'; return ''; }
        const fields = args.find(x => x.startsWith('--property='))?.slice(11).split(',') || Object.keys(unit);
        return fields.map(k => `${k}=${unit[k]}`).join('\n');
    };
    const deps = { uid: () => 0, inspectProcess: inspect, cgroups: () => '0::/independent', domainMembers: () => [], readRoot: p => JSON.parse(fs.readFileSync(p)),
        pin: () => Buffer.from(JSON.stringify({ schema: 'nassaj-forward-child-closure/v1', files: [pin] })),
        pinnedRecord: p => p.path === 'request' ? request : contract, exec,
        inhibitors: { execFile: exec }, observe: async () => runtime,
        retirement: { effectiveUid: () => 0, execFile: exec, inspectProcess: inspect, verifyNoHolders: () => {}, observeRuntime: async () => runtime },
        execGate: (_node, args, _options, callback) => ({ stdin: { end: raw => {
            calls.push(args[1]); const value = JSON.parse(raw);
            callback(null, JSON.stringify({ schema: 'nassaj-first-forward-ingress-receipt/v1', operationId: value.operationId,
                generationEpoch: value.generationEpoch, phase: 'closed', closedAt: Date.now(), hostProofSha256: 'e'.repeat(64) }));
        } } }) };
    const stopSupervisor = prepared => { runtime.entries = []; oldGone = true; save('first-cutover.json', { ...prepared, phase: 'supervisor_stopped', revision: prepared.revision + 1 }); };
    const resign = () => { expected.supervisorPlanSha256 = digest(supervisorPlan); expected.mutatorPlanSha256 = digest(mutatorPlan); payload.expectedSha256 = digest(expected); save('approval', { ...payload, signature: sign(null, Buffer.from(canonicalForwardValue(payload)), privateKey).toString('base64url') }); };
    return { root, config, deps, calls, save, load, unit, sibling, dump, runtime, stopSupervisor, resign, authority };
}
test('signed initial operation produces actual saved-file retirement and preserves siblings', async t => {
    const f = fixture(t); const prepared = await initializeFirstForwardOperation(f.config, f.deps);
    assert.equal(prepared.phase, 'retirement_prepared'); assert.equal(f.load('startup-admission.json').state, 'switching');
    assert.equal(Object.hasOwn(f.load('startup-admission.json'), 'potentiallyRunningClaim'), false);
    assert.deepEqual(f.calls.filter(x => x !== 'show'), ['closeFirstForwardGate', 'mask', 'stop']);
    assert.deepEqual(prepared.forwardEffects.map(x => x.phase), ['intent', 'observed', 'intent', 'observed']);
    // Supervisor is a separate integration boundary; this fixture does not assert actual PM2 stop/delete.
    f.stopSupervisor(prepared);
    const completed = await completeFirstForwardRetirement(f.config, f.deps);
    assert.equal(completed.phase, 'retirement_verified'); assert.deepEqual(JSON.parse(fs.readFileSync(f.dump)), [f.sibling]);
    assert.equal(completed.forwardRetirement.sources[0].durable, true);
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps));
});
for (const kind of ['signature', 'plan', 'inventory', 'operator', 'unknown-source']) test(`${kind} fails before gate or stop`, async t => {
    const f = fixture(t);
    if (kind === 'signature') { const a = f.load('approval'); a.signature = 'invalid'; f.save('approval', a); }
    if (kind === 'plan') f.config.expected.supervisorPlanSha256 = '0'.repeat(64);
    if (kind === 'inventory') fs.writeFileSync(path.join(f.root, 'inventory'), 'changed');
    if (kind === 'operator') f.deps.cgroups = () => '0::/worker/child';
    if (kind === 'unknown-source') f.config.forwardActivation.supervisorPlan.sources[0].format = 'opaque-shell';
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps));
    assert.equal(f.calls.includes('closeFirstForwardGate'), false); assert.equal(f.calls.includes('stop'), false);
});
test('lost inhibitor result retains its intent and never retries the operation', async t => {
    const f = fixture(t); const exec = f.deps.exec;
    f.deps.exec = (p, args, opts) => { if (args[0] === 'stop') throw Error('unknown effect'); return exec(p, args, opts); };
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /unknown effect/);
    const journal = f.load('first-cutover.json'); assert.equal(journal.forwardEffects.at(-1).phase, 'intent');
    assert.equal(journal.phase, 'forward_prepare_intent'); assert.equal(f.load('startup-admission.json').state, 'switching');
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps));
});
for (const kind of ['revocation', 'resurrection', 'holder']) test(`${kind} blocks retirement acceptance`, async t => {
    const f = fixture(t); const prepared = await initializeFirstForwardOperation(f.config, f.deps);
    f.stopSupervisor(prepared);
    if (kind === 'revocation') f.save('startup-admission.json', { ...f.load('startup-admission.json'), revocation: true });
    if (kind === 'resurrection') f.runtime.entries.push({ name: 'nassaj-dev', namespace: 'default' });
    if (kind === 'holder') f.deps.retirement.verifyNoHolders = () => { throw Error('holder unknown'); };
    await assert.rejects(completeFirstForwardRetirement(f.config, f.deps));
    assert.notEqual(f.load('first-cutover.json').phase, 'retirement_verified');
    assert.equal(f.load('first-cutover.json').forwardMigrationIntent, undefined);
});
test('saved source regenerated after retirement write fails real verifier before migration', async t => {
    const f = fixture(t); const prepared = await initializeFirstForwardOperation(f.config, f.deps);
    f.stopSupervisor(prepared);
    let observations = 0; f.deps.observe = async () => { if (++observations === 2) fs.writeFileSync(f.dump, JSON.stringify([f.sibling, { name: 'nassaj-dev' }])); return f.runtime; };
    await assert.rejects(completeFirstForwardRetirement(f.config, f.deps), /old_target_present/);
    assert.equal(f.load('first-cutover.json').forwardRetirement, undefined);
});
test('inhibitor becoming active during final observations blocks receipt', async t => {
    const f = fixture(t); const prepared = await initializeFirstForwardOperation(f.config, f.deps);
    f.stopSupervisor(prepared);
    f.deps.observe = async () => { f.unit.ActiveState = 'active'; return f.runtime; };
    await assert.rejects(completeFirstForwardRetirement(f.config, f.deps), /inhibitor_not_effective/);
    assert.equal(f.load('first-cutover.json').forwardMigrationIntent, undefined);
});
test('actual admission invalidator during gate wait stops all later unit effects', async t => {
    const f = fixture(t); const gate = f.deps.execGate;
    f.deps.execGate = (...args) => {
        const callback = args.pop();
        return gate(...args, (error, result) => setImmediate(() => {
            invalidateCutoverStartupAdmission(f.root, 'owner-revoked-during-gate'); callback(error, result);
        }));
    };
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /admission_changed/);
    assert.equal(f.load('startup-admission.json').generationEpoch, 2);
    assert.equal(f.calls.includes('mask'), false); assert.equal(f.calls.includes('stop'), false);
});
for (const field of ['generationEpoch', 'revision']) test(`admission ${field} drift alone rejects the next CAS`, async t => {
    const f = fixture(t); const gate = f.deps.execGate;
    f.deps.execGate = (...args) => {
        const callback = args.pop();
        return gate(...args, (error, result) => {
            const state = f.load('startup-admission.json'); state[field]++; f.save('startup-admission.json', state); callback(error, result);
        });
    };
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /admission_changed/);
    assert.equal(f.calls.includes('mask'), false);
});
for (const at of [1, 2, 3, 4]) test(`unknown PM2 observation ${at} prevents the next host effect`, async t => {
    const f = fixture(t); let count = 0;
    f.deps.observe = async () => { if (++count === at) throw Error('pm2_observation_unknown:peer'); return f.runtime; };
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /pm2_observation_unknown/);
    assert.equal(f.calls.includes('stop'), false);
    if (at <= 3) assert.equal(f.calls.includes('mask'), false);
    if (at <= 2) assert.equal(f.calls.includes('closeFirstForwardGate'), false);
    if (at === 1) assert.equal(fs.existsSync(path.join(f.root, 'first-cutover.json')), false);
});
for (const mutation of ['pmId', 'namespace', 'pid', 'status']) test(`old slot ${mutation} mismatch denies first effect`, async t => {
    const f = fixture(t); f.runtime.entries[0][mutation] = mutation === 'status' ? 'stopped' : mutation === 'namespace' ? 'wrong' : 9876;
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /old_slot_changed/);
    assert.equal(f.calls.includes('closeFirstForwardGate'), false);
});
test('unknown PM2 before saved writes leaves actual dump bytes unchanged', async t => {
    const f = fixture(t); const prepared = await initializeFirstForwardOperation(f.config, f.deps); f.stopSupervisor(prepared);
    const before = fs.readFileSync(f.dump); f.deps.observe = async () => { throw Error('pm2_observation_unknown:dead'); };
    await assert.rejects(completeFirstForwardRetirement(f.config, f.deps), /pm2_observation_unknown/);
    assert.deepEqual(fs.readFileSync(f.dump), before);
    assert.equal(f.load('first-cutover.json').forwardEffects.some(effect => effect.kind === 'saved-definition'), false);
});
function asyncUnitFixture(f, behavior) {
    const script = path.join(f.root, 'unit-child.mjs'); const marker = path.join(f.root, 'unit-child-started');
    fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, process.argv[2]);\nsetTimeout(() => process.exit(${behavior === 'lost' ? 1 : 0}), 80);`);
    const actualChildren = [];
    f.deps.execUnit = (_binary, args, options, callback) => {
        const child = execFile(process.execPath, [script, args[0]], options, (error, stdout) => {
            if (!error && args[0] === 'mask') { f.unit.LoadState = 'masked'; f.unit.UnitFileState = 'masked'; }
            if (!error && args[0] === 'stop') f.unit.ActiveState = 'inactive';
            callback(error, stdout);
        });
        actualChildren.push(child);
        if (behavior === 'invalidate') child.once('spawn', () => invalidateCutoverStartupAdmission(f.root, 'actual-child-running'));
        return child;
    };
    return { marker, actualChildren };
}
test('actual async unit child executes without holding the state lock while waiting', async t => {
    const f = fixture(t); const child = asyncUnitFixture(f, 'success');
    const prepared = await initializeFirstForwardOperation(f.config, f.deps);
    assert.equal(prepared.phase, 'retirement_prepared'); assert.equal(child.actualChildren.length, 2);
    assert.equal(fs.readFileSync(child.marker, 'utf8'), 'stop');
    assert.ok(child.actualChildren.every(item => item.exitCode === 0));
});
test('actual invalidator during actual async unit child blocks observed receipt and next child', async t => {
    const f = fixture(t); const children = asyncUnitFixture(f, 'invalidate');
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /admission_changed/);
    assert.equal(children.actualChildren.length, 1); assert.equal(children.actualChildren[0].exitCode, 0);
    assert.equal(fs.readFileSync(children.marker, 'utf8'), 'mask');
    assert.equal(f.load('first-cutover.json').forwardEffects.at(-1).phase, 'intent');
    assert.equal(f.load('startup-admission.json').transitionReason, 'actual-child-running');
});
test('actual async unit child lost result retains uncertainty and does not launch a second child', async t => {
    const f = fixture(t); const children = asyncUnitFixture(f, 'lost');
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps));
    assert.equal(children.actualChildren.length, 1); assert.equal(children.actualChildren[0].exitCode, 1);
    assert.equal(f.load('first-cutover.json').forwardEffects.at(-1).phase, 'intent');
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps));
    assert.equal(children.actualChildren.length, 1);
});
test('reviewed inactive unit with empty ControlGroup succeeds only with empty domain observation', async t => {
    const f = fixture(t); f.unit.ActiveState = 'inactive'; f.unit.ControlGroup = '';
    f.config.forwardActivation.mutatorPlan.sources[0].configurationSha256 = digest(f.unit); f.resign();
    const prepared = await initializeFirstForwardOperation(f.config, f.deps); assert.equal(prepared.phase, 'retirement_prepared');
});
test('inactive unit with remaining or unreadable domain members fails before gate', async t => {
    const f = fixture(t); f.unit.ActiveState = 'inactive'; f.unit.ControlGroup = '';
    f.config.forwardActivation.mutatorPlan.sources[0].configurationSha256 = digest(f.unit); f.resign();
    f.deps.domainMembers = () => [{ pid: 123 }];
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /inactive_domain_unknown/);
    f.deps.domainMembers = () => { throw Error('EACCES domain unknown'); };
    await assert.rejects(initializeFirstForwardOperation(f.config, f.deps), /EACCES/);
    assert.equal(f.calls.includes('closeFirstForwardGate'), false);
});
test('approved optional absent unit is recorded without mask/create and creator remains inhibited', async t => {
    const f = fixture(t); const absent = { Id: 'optional.service', LoadState: 'not-found', ActiveState: 'inactive', UnitFileState: '',
        ControlGroup: '', FragmentPath: '', DropInPaths: '', ExecStart: '', ExecStartPre: '' };
    f.config.forwardActivation.mutatorPlan.sources.push({ sourceId: 'zoptional', unit: 'optional.service', scope: 'system', optional: true,
        cgroupPath: '/optional', creationSourceIds: ['worker'], configurationSha256: digest(absent) }); f.resign();
    const commands = []; const exec = f.deps.exec;
    const optionalExec = (binary, args, options) => {
        if (!args.includes('optional.service')) return exec(binary, args, options);
        commands.push(args[0]); assert.equal(args[0], 'show');
        return args.find(arg => arg.startsWith('--property=')).slice(11).split(',').map(key => `${key}=${absent[key]}`).join('\n');
    };
    f.deps.exec = optionalExec; f.deps.inhibitors.execFile = optionalExec; f.deps.retirement.execFile = optionalExec;
    const prepared = await initializeFirstForwardOperation(f.config, f.deps);
    assert.equal(prepared.forwardInhibitors.find(item => item.sourceId === 'zoptional').absent, true);
    assert.equal(prepared.forwardEffects.filter(item => item.effectId.includes('zoptional')).length, 1);
    f.stopSupervisor(prepared); const completed = await completeFirstForwardRetirement(f.config, f.deps);
    assert.equal(completed.phase, 'retirement_verified'); assert.ok(commands.every(command => command === 'show'));
});

test('optional absent-first is proved only after optional present-last is actually inhibited', async t => {
    const f = fixture(t); const units = {
        'absent.service': { Id: 'absent.service', LoadState: 'not-found', ActiveState: 'inactive', UnitFileState: '',
            ControlGroup: '', FragmentPath: '', DropInPaths: '', ExecStart: '', ExecStartPre: '' },
        'present.service': { Id: 'present.service', LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled',
            ControlGroup: '/present', FragmentPath: '/fixture/present', DropInPaths: '', ExecStart: '/fixture/run', ExecStartPre: '' },
    };
    for (const [id, unit] of [['zabsent', 'absent.service'], ['zzpresent', 'present.service']])
        f.config.forwardActivation.mutatorPlan.sources.push({ sourceId: id, unit, scope: 'system', optional: true,
            cgroupPath: id === 'zabsent' ? '/absent' : '/present', creationSourceIds: ['worker'], configurationSha256: digest(units[unit]) });
    f.resign(); const actual = f.deps.exec; const effects = [];
    const exec = (binary, args, options) => {
        const name = args.find(value => units[value]); if (!name) return actual(binary, args, options);
        const unit = units[name];
        if (args[0] === 'mask') { effects.push(name + ':mask'); unit.LoadState = 'masked'; unit.UnitFileState = 'masked'; return ''; }
        if (args[0] === 'stop') { effects.push(name + ':stop'); unit.ActiveState = 'inactive'; return ''; }
        return args.find(value => value.startsWith('--property=')).slice(11).split(',').map(key => `${key}=${unit[key]}`).join('\n');
    };
    f.deps.exec = exec; f.deps.inhibitors.execFile = exec; f.deps.retirement.execFile = exec;
    const prepared = await initializeFirstForwardOperation(f.config, f.deps);
    assert.deepEqual(effects, ['present.service:mask', 'present.service:stop']);
    assert.equal(prepared.phase, 'retirement_prepared');
    const absent = prepared.forwardEffects.findIndex(entry => entry.effectId.includes('zabsent'));
    const stopped = prepared.forwardEffects.findLastIndex(entry => entry.effectId.includes('zzpresent'));
    assert.ok(absent > stopped);
});

// B-944: the metadata seam must not bypass the fixed authority or executable pin.
for(const invalid of ['missing','bad-pin']) test(`fixed mutex fixture still rejects ${invalid} authority`,t=>{
    const f=fixture(t);
    const file=path.join(f.root,'mutex-host.json');
    if(invalid==='missing')fs.unlinkSync(file);
    else {const config=JSON.parse(fs.readFileSync(file));config.stateLock.flock.sha256='0'.repeat(64);f.authority.write(config);}
    assert.throws(()=>withVerifiedCutoverStateMutex(f.root,()=>assert.fail('untrusted authority entered callback')),
        invalid==='missing'?/ENOENT/:/cutover_state_executable_mismatch/);
});
