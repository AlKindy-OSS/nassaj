import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { parse } from 'acorn';
import { validatePm2TargetDescriptor, verifyPm2PrivateDescriptor, preparePm2TypedStep, verifyPm2LegacySnapshot, validatePm2AxmMetadata, verifyPm2LaunchWindow, verifyPm2UnrelatedEntries } from './lib/pm2-typed-mutation.mjs';
import { forwardValueSha256 as sha } from './lib/release-runtime-forward-child-protocol.mjs';
const nativeRequire = createRequire(import.meta.url);
const pm2Package = path.resolve(import.meta.dirname, '../node_modules/pm2/package.json');
assert.equal(JSON.parse(fs.readFileSync(pm2Package, 'utf8')).version, '7.0.1');
const pm2File = relative => path.join(path.dirname(pm2Package), relative);
const uuid = '12345678-1234-4234-8234-123456789abc';
const descriptor = () => ({ name: 'nassaj-fixture', namespace: 'fixture', pm_exec_path: '/fixture/launcher.mjs', pm_cwd: '/fixture',
    exec_interpreter: '/usr/bin/node', exec_mode: 'fork_mode', uid: 1234, gid: 1234, pm_out_log_path: '/fixture/out.log',
    pm_err_log_path: '/fixture/err.log', pm_pid_path: '/fixture/app.pid', status: 'stopped', autostart: true,
    autorestart: false, watch: false, pmx: false, vizion: false, wait_ready: false, restart_time: 0, unstable_restarts: 0, prev_restart_delay: 0, env: { SERVICE_FLAG: 'private-fixture-value' } });
function installedHandler(file, name) {
    const source = fs.readFileSync(file, 'utf8'); const tree = parse(source, { ecmaVersion: 'latest', allowReturnOutsideFunction: true }); let found;
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression'
            && node.left.object.name === 'God' && node.left.property.name === name) found = source.slice(node.start, node.end);
        for (const item of Object.values(node)) if (Array.isArray(item)) item.forEach(visit); else if (item && typeof item === 'object') visit(item);
    };
    visit(tree); assert.ok(found, `actual handler ${name}`); return found;
}
test('target descriptor rejects every nested control shadow and unknown prepare effect field', () => {
    validatePm2TargetDescriptor(descriptor());
    for (const key of [...Object.keys(descriptor()), 'instances', 'cron_restart', 'pm_id', 'vizion_running', 'constructor']) {
        const value = descriptor(); value.env[key] = 'shadow'; assert.throws(() => validatePm2TargetDescriptor(value));
    }
    for (const [key, value] of [['instances', 1], ['cron_restart', '* * * * *'], ['watch', true], ['autostart', false]]) {
        assert.throws(() => validatePm2TargetDescriptor({ ...descriptor(), [key]: value }));
    }
});
test('actual installed prepare then actual start/executeApp reveal the online material gap without launching a process', async () => {
    const counters = { fork: 0, cron: 0, watch: 0, execute: 0 }; const God = { clusters_db: {},
        getNewId: () => 29, registerCron: value => { if (value.cron_restart) counters.cron++; },
        watch: { enable: () => counters.watch++ }, notify() {}, finalizeProcedure() { throw Error('unexpected_vizion'); },
        forkMode: (value, callback) => { counters.fork++; const child = new EventEmitter(); child.pm2_env = value;
            child.process = { pid: 999 }; callback(null, child); } };
    const sandbox = { God, Utility: { generateUUID: () => uuid, clone: value => JSON.parse(JSON.stringify(value)), extend: Object.assign,
        findPackageVersion: () => '1.2.3' }, cst: { STOPPED_STATUS: 'stopped', ONLINE_STATUS: 'online', LAUNCHING_STATUS: 'launching',
        ERRORED_STATUS: 'errored', ENABLE_GIT_PARSING: false }, console: { log() {}, error() {} }, Date };
    const context = vm.createContext(sandbox);
    for (const name of ['prepare', 'executeApp']) vm.runInContext(installedHandler(pm2File('lib/God.js'), name), context);
    vm.runInContext(installedHandler(pm2File('lib/God/ActionMethods.js'), 'startProcessId'), context);
    const execute = God.executeApp; God.executeApp = (...args) => { counters.execute++; return execute(...args); };
    const approved = descriptor(); const prepared = await new Promise((resolve, reject) => God.prepare(structuredClone(approved),
        (error, result) => error ? reject(error) : resolve(result[0])));
    assert.deepEqual(counters, { fork: 0, cron: 0, watch: 0, execute: 0 });
    assert.equal(prepared.pm2_env.pm_id, 29); assert.equal(prepared.pm2_env.env.unique_id, uuid);
    verifyPm2PrivateDescriptor(prepared.pm2_env, approved, 'stopped');
    const started = await new Promise((resolve, reject) => God.startProcessId(29, (error, result) => error ? reject(error) : resolve(result)));
    assert.deepEqual(counters, { fork: 1, cron: 0, watch: 0, execute: 1 });
    assert.equal(started.pm2_env.status, 'online'); assert.equal(started.pm2_env.SERVICE_FLAG, approved.env.SERVICE_FLAG);
    const added = Object.keys(started.pm2_env).filter(key => !(key in approved) && !['pm_id', 'vizion_running'].includes(key)).sort();
    assert.deepEqual(added, ['SERVICE_FLAG', 'axm_actions', 'axm_dynamic', 'axm_monitor', 'axm_options', 'created_at', 'pm_uptime', 'unique_id', 'version']);
    assert.throws(() => verifyPm2PrivateDescriptor(started.pm2_env, approved, 'online'), /allocated_slot/);
});
test('prepare uses absence digest and cannot accept caller methods or an existing same-namespace target', () => {
    const value = descriptor(); const request = { operationId: 'operation-fixture', attemptId: 'attempt-fixture', step: 'configure-target-stopped',
        expectedSlotDigest: sha({ absent: true, name: value.name, namespace: value.namespace }) };
    const context = { attemptNonce: 'a'.repeat(64), targetDescriptor: value };
    const result = preparePm2TypedStep(request, context, [], { pid: 10 });
    assert.equal(result.method, 'prepare'); assert.equal(result.payload.status, 'stopped'); assert.equal(result.payload.instances, undefined);
    assert.throws(() => preparePm2TypedStep({ ...request, method: 'deleteAll' }, context, [], {}));
    assert.throws(() => preparePm2TypedStep(request, context, [{ pm_id: 1, pm2_env: { ...value, pm_id: 1 } }], {}), /target_exists/);
});

test('actual ForkMode and ProcessContainerFork IPC preserve disabled instrumentation; restart/reset expose required counter defaults', async t => {
    const scratch = fs.mkdtempSync(path.resolve('.artifacts/pm2-lifecycle-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    fs.mkdirSync(path.join(scratch, 'nested')); fs.writeFileSync(path.join(scratch, 'nested/package.json'), '{"version":"9.8.7"}');
    const executable = path.join(scratch, 'nested/app.cjs'); fs.writeFileSync(executable, 'module.exports = {};');
    const counter = { spawn: 0, pmx: 0, app: 0, cron: 0, watch: 0 }; const spawned = [];
    const God = { clusters_db: {}, getNewId: () => 31, registerCron: env => { if (env.cron_restart) counter.cron++; },
        deleteCron() {}, bus: new EventEmitter(), watch: { enable() { counter.watch++; } }, notify() {},
        finalizeProcedure() { throw Error('vizion_effect'); }, logAndGenerateError: error => Error(String(error)),
        killProcess(pid, env, callback) { assert.ok(spawned.some(child => child.pid === pid)); callback(null); },
        getFormatedProcess(id) { const item = God.clusters_db[id]; return { pm2_env: item.pm2_env, pid: item.process.pid }; } };
    const findPackageJson = nativeRequire(pm2File('lib/tools/find-package-json.js'));
    const utilitySource = fs.readFileSync(pm2File('lib/Utility.js'), 'utf8');
    const ast = parse(utilitySource, { ecmaVersion: 'latest' }); let lookup;
    const find = node => { if (!node || typeof node !== 'object') return;
        if (node.type === 'Property' && node.key.name === 'findPackageVersion') lookup = utilitySource.slice(node.value.start, node.value.end);
        for (const item of Object.values(node)) if (Array.isArray(item)) item.forEach(find); else if (item && typeof item === 'object') find(item); };
    find(ast); assert.ok(lookup);
    const Utility = { generateUUID: () => uuid, clone: value => JSON.parse(JSON.stringify(value)), extend: Object.assign,
        extendExtraConfig: (proc, opts) => assert.equal(opts.env, undefined), getDate: () => Date.now(),
        startLogging: (stds, callback) => callback(null), checkPathIsNull: () => true,
        findPackageVersion: vm.runInNewContext(`(${lookup})`, { findPackageJson }) };
    const spawn = (command, args, options) => {
        counter.spawn++; assert.equal(command, '/usr/bin/node'); assert.equal(options.uid, 1234); assert.equal(options.gid, 1234);
        assert.equal(options.env.pmx, false); // Node spawn's environment serialization occurs below, explicitly.
        const child = new EventEmitter(); child.pid = 50000 + counter.spawn;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
        spawned.push(child); child.fixtureEnvironment = Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, String(value)]));
        return child;
    };
    const sandbox = { God, Utility, cst: { STOPPED_STATUS: 'stopped', STOPPING_STATUS: 'stopping', ONLINE_STATUS: 'online',
        LAUNCHING_STATUS: 'launching', ERRORED_STATUS: 'errored', ENABLE_GIT_PARSING: true },
        console: { log() {}, error() {} }, Date, clearTimeout, setTimeout, log() {}, debug() {},
        path, module: { filename: pm2File('lib/God/ForkMode.js') },
        fs: { writeFileSync: (file, bytes) => { assert.equal(file, path.join(scratch, 'app.pid')); fs.writeFileSync(file, bytes); },
            unlinkSync: file => { assert.equal(file, path.join(scratch, 'app.pid')); fs.unlinkSync(file); } },
        process: { execPath: '/usr/bin/node', env: {}, cwd: () => scratch, nextTick: process.nextTick },
        require: name => { assert.equal(name, 'child_process'); return { spawn }; } };
    const context = vm.createContext(sandbox);
    for (const name of ['prepare', 'executeApp']) vm.runInContext(installedHandler(pm2File('lib/God.js'), name), context);
    vm.runInContext(installedHandler(pm2File('lib/God/ForkMode.js'), 'forkMode'), context);
    for (const name of ['startProcessId', 'stopProcessId', 'restartProcessId'])
        vm.runInContext(installedHandler(pm2File('lib/God/ActionMethods.js'), name), context);
    vm.runInContext(installedHandler(pm2File('lib/God/Methods.js'), 'resetState'), context);
    const approved = { ...descriptor(), pm_exec_path: executable, pm_cwd: scratch, pm_pid_path: path.join(scratch, 'app.pid') };
    const call = (name, input) => new Promise((resolve, reject) => God[name](input, (error, result) => error ? reject(error) : resolve(result)));
    await call('prepare', structuredClone(approved)); assert.equal(counter.spawn, 0); assert.equal(counter.cron, 0); assert.equal(counter.watch, 0);
    const started = await call('startProcessId', 31); assert.equal(started.pm2_env.version, '9.8.7');
    const child = spawned[0]; const childProcess = { env: child.fixtureEnvironment, connected: true, versions: { node: process.versions.node },
        send: value => child.emit('message', value) };
    const utilsModule = { exports: {} }; const requireUtils = name => {
        if (name === '../modules/pm2-io-bpm') { counter.pmx++; throw Error('instrumentation_forbidden'); }
        if (name === 'fs') return fs; if (name === 'path') return path; throw Error('unexpected_require');
    };
    vm.runInNewContext(fs.readFileSync(pm2File('lib/ProcessUtils.js'), 'utf8'),
        { module: utilsModule, process: childProcess, require: requireUtils });
    const childRequire = name => {
        if (name === './ProcessUtils') return utilsModule.exports;
        if (name === 'url') return {};
        if (name === 'module') return { _load: file => { assert.equal(file, executable); counter.app++; } };
        throw Error('unexpected_container_require');
    };
    vm.runInNewContext(fs.readFileSync(pm2File('lib/ProcessContainerFork.js'), 'utf8'), { process: childProcess, require: childRequire });
    assert.equal(child.fixtureEnvironment.pmx, 'false'); assert.equal(counter.pmx, 0); assert.equal(counter.app, 1);
    assert.equal(God.clusters_db[31].pm2_env.node_version, process.versions.node);
    assert.deepEqual(JSON.parse(JSON.stringify(God.clusters_db[31].pm2_env.axm_actions)), []);
    for (const key of ['axm_monitor', 'axm_options', 'axm_dynamic']) assert.deepEqual(JSON.parse(JSON.stringify(God.clusters_db[31].pm2_env[key])), {});
    assert.equal(God.clusters_db[31].pm2_env.restart_time, 0);
    await call('restartProcessId', { id: 31 });
    assert.equal(God.clusters_db[31].pm2_env.restart_time, 1);
    assert.equal(God.clusters_db[31].pm2_env.unstable_restarts, 0); assert.equal(God.clusters_db[31].pm2_env.prev_restart_delay, 0);
    await call('stopProcessId', 31); assert.equal(God.clusters_db[31].process.pid, 0);
});

function onlineMaterial() {
    const approved = descriptor(); return { ...approved, status: 'online', pm_id: 31, vizion_running: false,
        env: { ...approved.env, unique_id: uuid }, ...approved.env, unique_id: uuid,
        created_at: 1001, pm_uptime: 1002, axm_actions: [], axm_monitor: {}, axm_options: {}, axm_dynamic: {}, version: '9.8.7' };
}
const window = { wallBefore: 1000, wallAfter: 1010, monotonicBefore: '2000000000', monotonicAfter: '2010000000', bootBefore: 'same-boot', bootAfter: 'same-boot' };
test('reviewed online target checks exact environment, UUID, package lookup, interpreter IPC, timestamps and AXM', () => {
    const actual = onlineMaterial(); const policy = { uuid, version: '9.8.7', nodeVersion: process.versions.node, pmId: 31, pid: 700, window };
    verifyPm2PrivateDescriptor(actual, descriptor(), 'online', policy);
    verifyPm2PrivateDescriptor({ ...actual, node_version: process.versions.node }, descriptor(), 'online', policy);
    const mutations = [value => value.env.unique_id = '11111111-1111-4111-8111-111111111111', value => value.pm_uptime = 999,
        value => value.version = 'wrong-package', value => value.node_version = 'wrong-node', value => value.SERVICE_FLAG = 'shadow',
        value => value.axm_options = { pid: 700 }, value => value.extraControl = true, value => value.unique_id = 'bad'];
    for (const mutate of mutations) { const value = structuredClone(actual); mutate(value);
        assert.throws(() => verifyPm2PrivateDescriptor(value, descriptor(), 'online', policy)); }
    assert.throws(() => verifyPm2LaunchWindow({ ...window, bootAfter: 'other-boot' }, [1005]));
    assert.throws(() => verifyPm2LaunchWindow({ ...window, wallAfter: 1110 }, [1005]), /clock_skew/);
});
test('legacy baseline preserves controls and counters while bounded AXM telemetry remains in full fresh hash', () => {
    const baseline = onlineMaterial(); baseline.autostart = false; baseline.pmx = true;
    const fresh = structuredClone(baseline); fresh.axm_monitor = { telemetry: { value: 4 } }; fresh.axm_options = { pid: 700 };
    const digest = verifyPm2LegacySnapshot(fresh, baseline, { pid: 700, status: 'online', step: 'inspect' });
    assert.equal(digest, sha(fresh)); assert.notEqual(digest, sha(baseline));
    assert.throws(() => verifyPm2LegacySnapshot({ ...fresh, created_at: 1003 }, baseline, { pid: 700, status: 'online', step: 'inspect' }), /legacy_control_drift/);
    assert.throws(() => verifyPm2LegacySnapshot({ ...fresh, pm_cwd: '/wrong' }, baseline, { pid: 700, status: 'online', step: 'inspect' }));
    assert.throws(() => validatePm2AxmMetadata({ ...fresh, axm_options: { pid: 701 } }, 700, true), /axm_pid/);
    for (const value of [Infinity, 'x'.repeat(4097), { pm_exec_path: '/shadow' }, JSON.parse('{"__proto__":1}')])
        assert.throws(() => validatePm2AxmMetadata({ ...fresh, axm_monitor: { telemetry: value } }, 700, true));
    let deep = {}; for (let i = 0; i < 10; i++) deep = { child: deep };
    assert.throws(() => validatePm2AxmMetadata({ ...fresh, axm_monitor: deep }, 700, true), /axm_depth/);
});
test('legacy stop and restart accept only actual reset and counter transitions', () => {
    const baseline = onlineMaterial(); const stopped = { ...baseline, status: 'stopped' };
    verifyPm2LegacySnapshot(stopped, baseline, { pid: 0, priorPid: 700, status: 'stopped', step: 'stop-old' });
    const restarted = { ...baseline, created_at: 1005, pm_uptime: 1006, restart_time: 1, unstable_restarts: 0, prev_restart_delay: 0 };
    const options = { pid: 701, priorPid: 700, status: 'online', step: 'restart-same', window, version: '9.8.7', nodeVersion: process.versions.node };
    verifyPm2LegacySnapshot(restarted, baseline, options);
    for (const changes of [{ restart_time: 0 }, { unstable_restarts: 1 }, { prev_restart_delay: 5 }, { created_at: 2000 },
        { env: { ...baseline.env, unique_id: 'changed' } }, { pm_id: 32 }])
        assert.throws(() => verifyPm2LegacySnapshot({ ...restarted, ...changes }, baseline, options));
});

test('lowercase PM2 launch and generated environment fields are denied before the actual ForkMode can spawn', () => {
    for (const key of ['node_args', 'args', 'kill_timeout', 'created_at', 'axm_options', 'node_version', 'NODE_OPTIONS', 'LD_PRELOAD', 'PM2_NODE_OPTIONS']) {
        const value = descriptor(); value.env[key] = '--require=/untrusted/code';
        assert.throws(() => validatePm2TargetDescriptor(value), /environment_shadow/);
    }
});
test('online admission requires exact allocated PM2 id and legacy requests bind the independent baseline hash', () => {
    const actual = onlineMaterial(); const policy = { uuid, version: '9.8.7', nodeVersion: process.versions.node, pmId: 31, pid: 700, window };
    assert.throws(() => verifyPm2PrivateDescriptor({ ...actual, pm_id: 32 }, descriptor(), 'online', policy), /allocated_slot/);
    const request = { operationId: 'legacy-operation', attemptId: 'legacy-attempt', step: 'stop-old', expectedSlotDigest: sha(actual) };
    const context = { attemptNonce: 'b'.repeat(64), slot: { pmId: 31, baseline: actual, entrySha256: sha(actual), process: { pid: 700 } } };
    preparePm2TypedStep(request, context, [{ pm_id: 31, pid: 700, pm2_env: actual }], {});
    assert.throws(() => preparePm2TypedStep(request, context, [{ pm_id: 32, pid: 700, pm2_env: actual }], {}), /entry_id_mismatch/);
    assert.throws(() => preparePm2TypedStep(request, { ...context, slot: { ...context.slot, entrySha256: 'c'.repeat(64) } },
        [{ pm_id: 31, pid: 700, pm2_env: actual }], {}), /legacy_baseline_binding/);
});

test('unrelated telemetry may change with distinct full hashes, while any sibling identity or control drift rejects', () => {
    const env = onlineMaterial(); env.name = 'neighbor';
    const before = [{ pm_id: 31, pid: 700, pm2_env: env }]; const after = structuredClone(before);
    after[0].pm2_env.axm_monitor = { metric: { value: 1 } };
    const proof = verifyPm2UnrelatedEntries(before, after, descriptor());
    assert.notEqual(proof.beforeSha256, proof.afterSha256);
    for (const change of [entry => entry.pid++, entry => entry.pm_id++, entry => entry.pm2_env.pm_cwd = '/changed',
        entry => entry.pm2_env.env.SERVICE_FLAG = 'changed', entry => entry.pm2_env.created_at++]) {
        const current = structuredClone(after); change(current[0]); assert.throws(() => verifyPm2UnrelatedEntries(before, current, descriptor()));
    }
});
