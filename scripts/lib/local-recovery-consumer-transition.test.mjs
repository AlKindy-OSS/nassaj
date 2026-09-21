import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Fault injection exists only in this disposable source copy, never in the production API.
const fixtureRoot = fs.mkdtempSync(path.join(root, '.artifacts/consumer-source-fixture-'));
let source = fs.readFileSync(path.join(import.meta.dirname, 'local-recovery-consumer-transition.mjs'), 'utf8');
source = source.replace(/from '([^']+)'/g, (_, specifier) => `from '${specifier.startsWith('.') ? pathToFileURL(path.resolve(import.meta.dirname, specifier)).href : specifier}'`)
    .replace('executeOfflineConsumerTransition(options)', 'executeOfflineConsumerTransition(options, injected)')
    .replace('const lock = withPreviewEventMutationLock;', 'const lock = injected.lock;')
    .replace('const inspect = inspectOfflineConsumerInputs,', 'const inspect = injected.inspect,')
    .replace('run: plan.run, observe: () => observeConsumer(plan),', 'run: injected.run, observe: injected.observe,')
    .replaceAll('verifyConsumerConfiguration(plan);', 'injected.configuration?.();')
    .replace('readiness: () => verifyConsumerReadiness(plan), checkpoint: () => {}', 'readiness: injected.readiness, checkpoint: injected.checkpoint')
    .replace("if (current.unit !== 'masked') mask(plan.unit);", "if (current.unit !== 'masked') { mask(plan.unit); operations.checkpoint('mask_written'); }")
    .replace("if (current.config !== 'target') replace(plan.dropIn, plan.proposed, 0o600);", "if (current.config !== 'target') { replace(plan.dropIn, plan.proposed, 0o600); operations.checkpoint('drop_in_written'); }")
    .replace("if (current.unit === 'masked') replace(plan.unit, Buffer.from(record.originalUnit.bytes, 'base64'), record.originalUnit.mode);", "if (current.unit === 'masked') { replace(plan.unit, Buffer.from(record.originalUnit.bytes, 'base64'), record.originalUnit.mode); operations.checkpoint('unit_restored'); }");
const fixtureModule = path.join(fixtureRoot, 'transition.mjs'); fs.writeFileSync(fixtureModule, source);
if (process.env.NODE_V8_COVERAGE) fs.writeFileSync(path.join(process.env.NODE_V8_COVERAGE, `consumer-source-transition-${process.pid}.json`),
    JSON.stringify({ generatedPath: fixtureModule, originalPath: path.join(import.meta.dirname, 'local-recovery-consumer-transition.mjs'), source }));
const { executeOfflineConsumerTransition } = await import(pathToFileURL(fixtureModule));
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(root, '.artifacts/consumer-transition-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const unit = path.join(directory, 'consumer.service'), dropIn = path.join(directory, 'enforcement.conf');
    const originalUnit = '[Service]\nRestart=on-failure\n', originalConfig = '[Service]\nEnvironment=NASSAJ_PREVIEW_OID_DOMAINS=client\n';
    fs.writeFileSync(unit, originalUnit, { mode: 0o600 }); fs.writeFileSync(dropIn, originalConfig, { mode: 0o600 });
    const plan = { root: directory, unit, dropIn, proposed: '[Service]\nEnvironment=NASSAJ_PREVIEW_OID_DOMAINS=client,server\n',
        intent: path.join(directory, 'intent.json'), packetSha256: sha('packet'), unitSha256: sha(originalUnit),
        originalDropInSha256: sha(originalConfig), transactionId: 'tx', jobId: 'job', actionId: 'action', approvalReference: 'synthetic:only' };
    let starts = 0, active = false, readinessReads = 0, locked = false, checkpoint = '', changedIncarnation = false, pendingJob = false, failedCommand = '';
    const calls = [], observed = [];
    const operations = {
        lock: async (_root, operation) => { assert.equal(locked, false); locked = true; try { return await operation(); } finally { locked = false; } },
        inspect: async () => { assert.ok(locked); return plan; },
        observe: async () => {
            assert.ok(locked); const masked = fs.lstatSync(unit).isSymbolicLink();
            const value = { ActiveState: active ? 'active' : 'inactive', SubState: active ? 'running' : 'dead', MainPID: active ? '101' : '0',
                UnitFileState: masked ? 'masked' : starts ? 'enabled' : 'disabled', LoadState: masked ? 'masked' : 'loaded',
                jobs: pendingJob ? ['pending-start'] : [], pids: active ? [101, 102] : [] };
            observed.push(value); return value;
        },
        run: async args => { assert.ok(locked); calls.push(args);
            if (args[0] === 'start') { starts++; active = true; }
            if (args[0] === failedCommand) throw Error('unknown_command_outcome');
        },
        readiness: async () => { assert.ok(locked); readinessReads++;
            return { InvocationID: changedIncarnation && readinessReads > 1 ? 'new' : 'old', NRestarts: '0', MainPID: '101',
                startTicks: '1000', ControlGroup: '/fixture', retainedBuildId: sha('bundle'), childPid: 102, childStartTicks: '1001' };
        },
        checkpoint: stage => { if (stage === checkpoint) throw Error(`crash_${stage}`); },
    };
    return { directory, plan, operations, calls, observed, originalUnit, originalConfig,
        options: { root: directory, execute: true }, get starts() { return starts; },
        crash(stage) { checkpoint = stage; }, changeIncarnation() { changedIncarnation = true; }, pendingJob() { pendingJob = true; }, failCommand(name) { failedCommand = name; } };
}

test('offline transition holds event EX through exact process/bundle readiness and preserves Restart policy', async t => {
    const f = fixture(t), result = await executeOfflineConsumerTransition(f.options, f.operations);
    assert.equal(result.stage, 'started'); assert.equal(f.starts, 1);
    assert.equal(fs.readFileSync(f.plan.unit, 'utf8'), f.originalUnit);
    assert.equal(fs.readFileSync(f.plan.dropIn, 'utf8'), f.plan.proposed);
    assert.equal((await executeOfflineConsumerTransition(f.options, f.operations)).reused, true);
    assert.equal(f.starts, 1);
    assert.ok(f.observed.some(row => row.LoadState === 'masked'));
    assert.ok(f.calls.every(args => !['stop','restart','kill','disable'].includes(args[0])));
});

for (const boundary of ['prepared','mask_written','masked','drop_in_written','configured','unit_restored','unmasked','start_attempt','started']) {
    test(`crash/replay at ${boundary} never duplicates an unknown operator start`, async t => {
        const f = fixture(t); f.crash(boundary);
        await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), new RegExp(`crash_${boundary}`));
        f.crash(''); const before = f.starts, result = await executeOfflineConsumerTransition(f.options, f.operations);
        if (boundary === 'start_attempt') { assert.equal(result.state, 'manual'); assert.equal(f.starts, before); }
        else { assert.equal(result.stage, 'started'); assert.equal(f.starts, 1); }
        assert.ok(f.calls.every(args => !['stop','restart','kill'].includes(args[0])));
    });
}

test('external unit/drop-in changes refuse replay without overwriting another writer', async t => {
    for (const file of ['unit','dropIn']) {
        const f = fixture(t); f.crash('masked'); await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations)); f.crash('');
        if (file === 'unit') fs.unlinkSync(f.plan.unit);
        fs.writeFileSync(f.plan[file], 'external change', { mode: 0o600 });
        const intent = fs.readFileSync(f.plan.intent), before = f.calls.length;
        await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), /changed/);
        assert.equal(fs.readFileSync(f.plan[file], 'utf8'), 'external change');
        assert.deepEqual(fs.readFileSync(f.plan.intent), intent); assert.equal(f.calls.length, before);
    }
});

test('incarnation change during startup stays manual with target config and no operator retry', async t => {
    const f = fixture(t); f.changeIncarnation();
    await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), /incarnation_changed/);
    assert.equal(f.starts, 1); assert.equal(fs.readFileSync(f.plan.dropIn, 'utf8'), f.plan.proposed);
    assert.equal((await executeOfflineConsumerTransition(f.options, f.operations)).state, 'manual');
    assert.equal(f.starts, 1);
});

test('pending start job after masking prevents configuration mutation and never kills it', async t => {
    const f = fixture(t); f.crash('masked'); await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations));
    f.crash(''); f.pendingJob();
    await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), /not_offline/);
    assert.equal(fs.readFileSync(f.plan.dropIn, 'utf8'), f.originalConfig); assert.equal(f.starts, 0);
});

for (const boundary of ['masked','configured','unmasked']) {
    test(`explicit rollback before start at ${boundary} restores configuration and remains inactive`, async t => {
        const f = fixture(t); f.crash(boundary); await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations)); f.crash('');
        const result = await executeOfflineConsumerTransition({ ...f.options, rollback: true }, f.operations);
        assert.equal(result.stage, 'rolled_back'); assert.equal(f.starts, 0);
        assert.equal(fs.readFileSync(f.plan.unit, 'utf8'), f.originalUnit);
        assert.equal(fs.readFileSync(f.plan.dropIn, 'utf8'), f.originalConfig);
    });
}

for (const command of ['enable', 'start']) {
    test(`unknown ${command} outcome preserves target config and never retries operator start`, async t => {
        const f = fixture(t); f.failCommand(command);
        await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), /unknown_command_outcome/);
        const calls = f.calls.length, starts = f.starts;
        const result = await executeOfflineConsumerTransition(f.options, f.operations);
        assert.equal(result.state, 'manual'); assert.match(result.reason, /may_be_enabled_systemd_may_restart/);
        assert.equal(f.calls.length, calls); assert.equal(f.starts, starts);
        assert.equal(fs.readFileSync(f.plan.dropIn, 'utf8'), f.plan.proposed);
    });
}

function bootstrapFixture(t) {
    const f = fixture(t);
    Object.assign(f.plan, { profile: 'bootstrap-offline-v2', jobId: undefined,
        bootstrap: { sequence: 1, transactionNonce: sha('nonce'), targetDigest: sha('target'), servingReceiptSha256: sha('receipt') } });
    return f;
}

test('v2 uses a separately bound intent and never grants database paths', async t => {
    const f = bootstrapFixture(t), result = await executeOfflineConsumerTransition(f.options, f.operations);
    assert.equal(result.schema, 'nassaj-local-consumer-transition/v2');
    assert.equal(result.jobId, undefined);
    assert.deepEqual(result.bootstrap, f.plan.bootstrap);
    assert.doesNotMatch(fs.readFileSync(f.plan.dropIn, 'utf8'), /database|private/);
    assert.equal((await executeOfflineConsumerTransition(f.options, f.operations)).reused, true);
});

for (const boundary of ['mask_written', 'drop_in_written', 'unit_restored', 'start_attempt']) {
    test(`v2 partial transition at ${boundary} resumes only before uncertain start`, async t => {
        const f = bootstrapFixture(t); f.crash(boundary);
        await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), new RegExp(`crash_${boundary}`));
        f.crash('');
        const result = await executeOfflineConsumerTransition(f.options, f.operations);
        assert.equal(result.schema, 'nassaj-local-consumer-transition/v2');
        assert.equal(result.state || result.stage, boundary === 'start_attempt' ? 'manual' : 'started');
        assert.equal(f.starts, boundary === 'start_attempt' ? 0 : 1);
    });
}

test('v2 refuses bootstrap receipt drift and v1 intent reuse before another effect', async t => {
    for (const mutate of [record => { record.bootstrap.targetDigest = sha('other'); }, record => { record.schema = 'nassaj-local-consumer-transition/v1'; }]) {
        const f = bootstrapFixture(t); f.crash('prepared');
        await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations)); f.crash('');
        const record = JSON.parse(fs.readFileSync(f.plan.intent, 'utf8')); mutate(record);
        fs.writeFileSync(f.plan.intent, JSON.stringify(record));
        const before = f.calls.length;
        await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), /intent_changed/);
        assert.equal(f.calls.length, before); assert.equal(f.starts, 0);
    }
});

test('v2 effective configuration failure stops before enable and start', async t => {
    const f = bootstrapFixture(t);
    f.operations.configuration = () => { throw Error('configuration_not_qualified'); };
    await assert.rejects(executeOfflineConsumerTransition(f.options, f.operations), /configuration_not_qualified/);
    assert.equal(f.starts, 0); assert.ok(!f.calls.some(args => ['enable', 'start'].includes(args[0])));
});
