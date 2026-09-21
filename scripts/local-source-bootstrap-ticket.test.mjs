import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { canonicalTripleJson as canonical, computeOidTripleTargetDigest } from './lib/oid-triple-target.mjs';
import { bootstrapExecutableClosure, retainOidTripleExecutor, readOidTripleRetainedExecutor } from './preview-oid-capsule-launcher.mjs';
import { inspectCompletedBootstrap } from './local-source-recovery-operator.mjs';
import { createSyntheticBootstrapQualification, syntheticBootstrapPrevious } from './update-lab/bootstrap-qualification.fixture.mjs';
import { createBootstrapTicket, verifyBootstrapTicket, consumeBootstrapTicket, bootstrapClock,
    validateBootstrapApprovalChain, readBootstrapPinnedFile, bootstrapJournalBinding, verifyBootstrapJournalBinding } from './lib/local-source-bootstrap-ticket.mjs';
const H = 'a'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const clock = { bootId: '12345678-1234-1234-1234-123456789abc', milliseconds: 1000 };
function material(root = '/fixture') {
    return { installation: { root, commonGit: `${root}/.git`, hostname: os.hostname(), serviceUid: process.getuid() },
        event: { sequence: 1, group: 'event-0000000000000001', oid: 'b'.repeat(40), targetDigest: H, manifestSha256: H },
        approval: { ownerId: '1', receiptSha256: H },
        previous: { pid: 42, ppid: 40, startTicks: '123', clientBuildId: H, serverBuildId: H, controlManifestSha256: H,
            clientTreeSha256: H, serverTreeSha256: H, nodeModulesTreeSha256: H },
        supervisor: { pid: 40, startTicks: '122', observerSha256: H, slotSha256: H, environmentSha256: H, dumpSha256: H },
        database: { path: `${root}/database.db`, dev: '1', ino: '2' },
        mode: { original: 'release', proposed: 'local-main', originalEnvSha256: H, proposalEnvSha256: H },
        baseline: { attestationSha256: H, rehearsalSha256: H }, executor: { codeClosureSha256: H, transactionNonce: 'c'.repeat(64) } };
}
test('bootstrap ticket limits authority to five CLOCK_BOOTTIME minutes and the same boot', () => {
    const expected = material(), ticket = createBootstrapTicket(expected, { clock });
    assert.match(verifyBootstrapTicket(ticket, expected, clock), /^[a-f0-9]{64}$/);
    for (const changed of [{ ...clock, milliseconds: ticket.expiresBootMs }, { ...clock, milliseconds: 999 },
        { ...clock, bootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }]) {
        assert.throws(() => verifyBootstrapTicket(ticket, expected, changed), /expired_or_rebooted/);
    }
    assert.throws(() => createBootstrapTicket(expected, { clock, ttlMs: 300001 }), /clock/);
    assert.equal(Number.isSafeInteger(bootstrapClock().milliseconds), true);
});
test('PID, supervisor, target, approval, inode, configuration and closure drift deny before claiming', () => {
    const expected = material(), ticket = createBootstrapTicket(expected, { clock });
    const changes = [m => m.previous.pid++, m => m.previous.startTicks = '124', m => m.supervisor.dumpSha256 = 'f'.repeat(64),
        m => m.event.oid = 'f'.repeat(40), m => m.approval.receiptSha256 = 'f'.repeat(64), m => m.database.ino = '3',
        m => m.mode.originalEnvSha256 = 'f'.repeat(64), m => m.executor.codeClosureSha256 = 'f'.repeat(64),
        m => m.baseline.rehearsalSha256 = 'f'.repeat(64)];
    for (const change of changes) {
        const fresh = structuredClone(expected); change(fresh);
        assert.throws(() => verifyBootstrapTicket(ticket, fresh, clock), /material_changed/);
    }
    assert.throws(() => verifyBootstrapTicket({ ...ticket, bypass: true }, expected, clock), /schema/);
});
test('exclusive durable claim spends a nonce permanently without modifying a candidate', t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-ticket-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, '.git/nassaj-oid-recovery', 'c'.repeat(64));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const expected = material(root), actualClock = bootstrapClock();
    const ticket = createBootstrapTicket(expected, { clock: actualClock });
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const owner = { pid: process.pid, bootId: actualClock.bootId, startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
    const claim = consumeBootstrapTicket(ticket, expected, owner, actualClock);
    assert.equal(fs.statSync(claim.file).mode & 0o777, 0o600);
    assert.equal(claim.claim.state, 'claimed_pre_effect');
    assert.equal(claim.claim.targetDigest, ticket.material.event.targetDigest);
    assert.throws(() => consumeBootstrapTicket(ticket, expected, owner, actualClock), /EEXIST/);
    assert.equal(fs.readdirSync(directory).length, 1);
});

test('baseline material permits only the exact historical dependency mismatch', async () => {
    const {createHash}=await import('node:crypto');
    const {canonicalTripleJson}=await import('./lib/oid-triple-target.mjs');
    const {validateBootstrapQualificationMaterial}=await import('./lib/local-source-bootstrap-ticket.mjs');
    const sha=value=>createHash('sha256').update(canonicalTripleJson(value)).digest('hex');
    const previous={oid:'b'.repeat(40),clientOid:'c'.repeat(40),mode:'release',nodeVersion:process.version,nodeModuleAbi:process.versions.modules};
    for(const key of ['serverBuildId','clientBuildId','controlManifestSha256','serverInputManifestSha256',
        'serverProvenanceSha256','clientProvenanceSha256','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256',
        'dependencyLegacyActualSha256','nodeBinarySha256','pm2PackageTreeSha256','safeRestartSha256','admissionImplementationSha256']) previous[key]=H;
    const installation=material().installation, exceptions=[{kind:'dependency-seal-mismatch',manifestSha256:H,expectedLegacySha256:'d'.repeat(64),actualLegacySha256:H}];
    const q={schema:'nassaj-bootstrap-previous-qualification/v1',installation,previous,exceptions,
        rehearsal:{schema:'nassaj-bootstrap-previous-rehearsal/v1',reportSha256:H,evidenceIndexSha256:H,harnessClosureSha256:H,
            verifierClosureSha256:H,previousMaterialSha256:sha({installation,previous,exceptions}),executorClosureSha256:H},review:{receiptSha256:H}};
    const actual={installation,previous},manifest={runtimeDependenciesSha256:'d'.repeat(64)};
    assert.equal(validateBootstrapQualificationMaterial(q,actual,manifest).exceptions.length,1);
    for(const mutate of [v=>v.exceptions.push({...v.exceptions[0]}),v=>v.exceptions[0].kind='capability-bypass',
        v=>v.previous.serverTreeSha256='e'.repeat(64),v=>v.rehearsal.previousMaterialSha256=H,
        v=>v.review.approved=true,v=>v.previous.mode='local-main']) {
        const changed=structuredClone(q);mutate(changed);
        assert.throws(()=>validateBootstrapQualificationMaterial(changed,actual,manifest),/bootstrap_ticket_/);
    }
});

test('conversation authority binds one named operation and actual mapped eligible owner', () => {
    const expected = material();
    const review = { schema: 'nassaj-bootstrap-owner-review/v1', installation: expected.installation,
        operation: 'bootstrap-release-to-local-main', transactionNonce: expected.executor.transactionNonce,
        event: expected.event, baseline: expected.baseline, executorCodeClosureSha256: H, qaReceiptSha256: H,
        mode: expected.mode, validity: { bootId: clock.bootId, notBeforeBootMs: 1000, notAfterBootMs: 301000, attempts: 1 } };
    const source = { harness: 'test-fixture', conversationId: 'synthetic-only', messageId: null,
        transcriptRef: 'fixture:owner-response', messageText: 'Fixture approval; not a real authorization.',
        timestamp: '2026-09-20T12:00:00Z' };
    source.messageSha256 = hash(source.messageText);
    const receipt = { schema: 'nassaj-bootstrap-owner-conversation-approval/v1', reviewPacketSha256: hash(canonical(review)),
        transactionNonce: review.transactionNonce, ownerId: '1', source,
        scope: { operation: review.operation, installation: review.installation }, decision: 'approve', recordedAt: 1 };
    expected.approval.receiptSha256 = hash(canonical(receipt));
    const ticket = createBootstrapTicket(expected, { clock });
    const principal = { id: '1', mappedOwnerId: '1', role: 'owner', is_active: 1, status: 'active' };
    assert.equal(validateBootstrapApprovalChain(ticket, review, receipt, principal, clock).ownerId, '1');
    for (const patch of [{ mappedOwnerId: '2' }, { role: 'admin' }, { is_active: 0 }, { status: 'disabled' }]) {
        assert.throws(() => validateBootstrapApprovalChain(ticket, review, receipt, { ...principal, ...patch }, clock), /owner_ineligible/);
    }
    for (const mutate of [v => v.event.oid = 'f'.repeat(40), v => v.validity.attempts = 2,
        v => v.executorCodeClosureSha256 = 'f'.repeat(64), v => v.operation = 'pm2-maintenance']) {
        const changed = structuredClone(review); mutate(changed);
        assert.throws(() => validateBootstrapApprovalChain(ticket, changed, receipt, principal, clock), /bootstrap_ticket_/);
    }
    assert.throws(() => validateBootstrapApprovalChain(ticket, review, { ...receipt, decision: 'deny' }, principal, clock), /approval_scope/);
});

test('private authority reader refuses symlinks, hardlinks, metadata and bytes drift', t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-file-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'receipt'), bytes = Buffer.from('private-fixture');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    assert.deepEqual(readBootstrapPinnedFile(file, hash(bytes)), bytes);
    assert.throws(() => readBootstrapPinnedFile(file, H), /file_changed/);
    fs.chmodSync(file, 0o644); assert.throws(() => readBootstrapPinnedFile(file, hash(bytes)), /file_metadata/);
    fs.chmodSync(file, 0o600); fs.symlinkSync(file, path.join(root, 'link'));
    assert.throws(() => readBootstrapPinnedFile(path.join(root, 'link'), hash(bytes)), /file_path/);
    fs.linkSync(file, path.join(root, 'hard'));
    assert.throws(() => readBootstrapPinnedFile(file, hash(bytes)), /file_metadata/);
});

function executableInput(capsule = fs.readFileSync(new URL('./oid-control-capsule.mjs', import.meta.url))) {
    const input = { capsule, launcher: Buffer.from('fixture-launcher'), safeRestart: Buffer.from('fixture-safe'),
        externalRuntimeClosures: ['node','python-peer-reader','pm2-package'].map(kind => ({ kind, sha256: H })) };
    const manifest = { capabilities: { oidTripleAdmissionV2: true } };
    for (const key of ['capsule','launcher','safeRestart']) {
        manifest[`${key}Sha256`] = hash(input[key]); manifest[`${key}Size`] = input[key].length;
    }
    return { ...input, manifestBytes: Buffer.from(JSON.stringify(manifest)) };
}

test('bootstrap executable closure is canonical, complete and excludes transaction state', () => {
    const input = executableInput(), closure = bootstrapExecutableClosure(input);
    assert.equal(closure.sha256, hash(canonical(closure.descriptor)));
    assert.equal(closure.descriptor.schema, 'nassaj-bootstrap-executable-closure/v1');
    assert.deepEqual(closure.descriptor.files.map(file => file.name), ['capsule.mjs','control-manifest.json','launcher.mjs','safe-restart.sh']);
    assert.equal(closure.descriptor.files.every(file => file.mode === 0o600), true);
    assert.equal(JSON.stringify(closure.descriptor).includes(closure.sha256), false);
    assert.deepEqual(bootstrapExecutableClosure({ ...input, externalRuntimeClosures: [...input.externalRuntimeClosures].reverse() }), closure);
    assert.throws(() => bootstrapExecutableClosure({ ...input, helper: Buffer.from('unlisted-code') }), /inputs_invalid/);
    assert.throws(() => bootstrapExecutableClosure({ ...input, externalRuntimeClosures: input.externalRuntimeClosures.slice(1) }), /runtime_incomplete/);
    for (const key of ['capsule','launcher','safeRestart','manifestBytes']) {
        assert.notEqual(bootstrapExecutableClosure({ ...input, [key]: Buffer.from('changed') }).sha256, closure.sha256);
    }
});

test('bootstrap records cannot fall through to ordinary activation or recovery while integration is incomplete', async () => {
    const { runOidPairTransaction } = await import('./oid-control-capsule.source.mjs');
    for (const bootstrap of [null, {}, { ticket: createBootstrapTicket(material(), { clock }) }]) {
        for (const resume of [undefined, { permissionRef: 'fixture' }]) {
            await assert.rejects(runOidPairTransaction({ bootstrap, resume }, Buffer.alloc(0)), /oid_bootstrap_integration_unavailable/);
        }
    }
});

function completeFixture(root, capsule) {
    assert.equal(spawnSync('git', ['init','-q',root]).status, 0);
    const common = path.join(root, '.git');
    fs.chmodSync(common, 0o700);
    const write = (file, value) => { const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes, { mode: 0o600 }); return hash(bytes); };
    const target = { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules','server','client'],
        installRuntime: { nodeBinarySha256: H, nodeVersion: process.version, nodeModuleAbi: process.versions.modules,
            napi: process.versions.napi, platform: process.platform, arch: process.arch, npmVersion: '11.0.0', npmCliSha256: H } };
    for (const key of ['clientBuildId','serverBuildId','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256',
        'dependencyContractSha256','packageJsonSha256','packageLockSha256','installPolicySha256','controlManifestSha256']) target[key] = H;
    const expected = material(root), input = executableInput(capsule), code = bootstrapExecutableClosure(input);
    expected.event.targetDigest = computeOidTripleTargetDigest({ ...expected.event, sourceOid: expected.event.oid, target });
    const manifestPath = path.join(root, 'candidate-manifest.json');
    expected.event.manifestSha256 = write(manifestPath, { releaseCommit: expected.event.oid, serverBuildId: H, clientBuildId: H });
    const env = 'NASSAJ_UPDATE_MODE=local-main\n'; fs.writeFileSync(path.join(root, '.env'), env, { mode: 0o600 });
    expected.mode.proposalEnvSha256 = hash(env); expected.executor.codeClosureSha256 = code.sha256;
    fs.mkdirSync(path.join(root, 'appdata'), { mode: 0o700 });
    expected.database.path = path.join(root, 'appdata/app.db'); fs.writeFileSync(expected.database.path, 'fixture', { mode: 0o600 });
    const databaseStat = fs.statSync(expected.database.path); expected.database.dev = String(databaseStat.dev); expected.database.ino = String(databaseStat.ino);
    const previousControl = Buffer.from(JSON.stringify({ runtimeDependenciesSha256: H }));
    const previousMaterial = syntheticBootstrapPrevious(previousControl);
    expected.previous.controlManifestSha256 = previousMaterial.controlManifestSha256;
    const qualification = createSyntheticBootstrapQualification({ installation: expected.installation, previous: previousMaterial,
        liveManifest: JSON.parse(previousControl), executorCodeClosureSha256: code.sha256,
        verifierClosureSha256: hash(input.capsule), databasePath: expected.database.path });
    expected.baseline = { attestationSha256: qualification.qualificationReference.sha256,
        rehearsalSha256: qualification.qualification.rehearsal.reportSha256 };
    const ticket = createBootstrapTicket(expected), nonce = expected.executor.transactionNonce;
    const ticks = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
    const owner = { pid: process.pid, startTime: ticks, bootId: ticket.bootId };
    const record = { repoRoot: root, actionId: '11111111-1111-1111-1111-111111111111', transactionNonce: nonce,
        pair: { targetDigest: expected.event.targetDigest }, bootstrap: { ticket, previousMaterial,
            previousControlManifestBase64: previousControl.toString('base64'), qualificationReference: qualification.qualificationReference } };
    const reference = retainOidTripleExecutor(root, { ...input, record });
    const consumed = consumeBootstrapTicket(ticket, expected, owner);
    const terminal = { schema: 'nassaj-oid-triple-terminal/v2', generationNames: target.generationNames, outcome: 'activated',
        transactionNonce: nonce, targetDigest: expected.event.targetDigest, clientBuildId: H, serverBuildId: H,
        nodeModulesTreeSha256: H, pid: process.pid, startTime: ticks };
    const terminalSha = write(path.join(common, `nassaj-oid-pair-receipt-${nonce}.json`), terminal);
    const journal = { schema: 'nassaj-oid-control-transaction/v2', generationNames: target.generationNames,
        sequence: 1, group: expected.event.group, oid: expected.event.oid, transactionNonce: nonce, actionId: record.actionId,
        state: 'pair_served', recoveryReference: reference, bootstrap: bootstrapJournalBinding(ticket, consumed), oldStoppedAt: 1, bootNonce: H,
        pair: { target, targetDigest: expected.event.targetDigest, receipt: terminal, receiptSha256: terminalSha,
            databaseState: 'TARGET_VERIFIED', activationNotClaimed: false },
        persistence: { online: { state: 'verified', status: 'online', dumpSha256: H, pid: process.pid, startTime: ticks, bootNonce: H } } };
    const journalPath = path.join(common, `nassaj-oid-control-transaction-1-${nonce}.json`); write(journalPath, journal);
    const receipt = { ...terminal, schema: 'nassaj-oid-triple-serving/v2', outcome: 'served', sequence: 1, actionId: record.actionId, servedAt: 1 };
    const receiptSha256 = write(path.join(common, `nassaj-oid-pair-serving-${nonce}.json`), receipt);
    const packet = { root, serviceUid: process.getuid(), nodeIdentity: os.hostname(), manifestPath,
        bootstrapCompletion: { sequence: 1, transactionNonce: nonce, actionId: record.actionId, targetDigest: expected.event.targetDigest,
            receiptSha256, ...Object.fromEntries(Object.entries(journal.bootstrap).filter(([key]) => key !== 'schema')) } };
    const health = { status: 'ok', updateMode: 'local-main', normalAdmissionReady: true, pid: process.pid,
        serverProcessStartTicks: ticks, serverLoadedOid: expected.event.oid, serverLoadedBuildId: H, clientBuildIdServed: H,
        serverTransactionNonce: nonce, oidPairTransactionNonce: nonce, oidPairTargetDigest: expected.event.targetDigest, oidNodeModulesTreeSha256: H };
    return { packet, health, journal, journalPath, record, consumed, code, write, reference };
}

test('completed bootstrap uses real retained files, claim, terminal validator and loopback health without DB access', async t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-completion-')), oldCwd = process.cwd();
    t.after(() => { process.chdir(oldCwd); fs.rmSync(root, { recursive: true, force: true }); });
    const fixture = completeFixture(root), server = createServer((request, response) => response.end(JSON.stringify(fixture.health)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    fixture.packet.privateHealthUrl = `http://127.0.0.1:${server.address().port}/health`;
    process.chdir(root);
    const actual = await inspectWithoutDatabaseImport(root, fixture.packet);
    assert.equal(actual.runtime.pid, process.pid); assert.equal(actual.health.updateMode, 'local-main');
    const retained = readOidTripleRetainedExecutor(root, { ...fixture.reference, actionId: fixture.record.actionId, targetDigest: fixture.record.pair.targetDigest });
    assert.equal(retained.descriptor.codeClosure.sha256, fixture.code.sha256);
    for (const mutate of [v => delete v.bootstrap, v => v.bootstrap.claimSha256 = H, v => v.pair.databaseState = 'UNKNOWN',
        v => v.state = 'pair_rolled_back', v => v.pair.activationNotClaimed = true]) {
        const changed = structuredClone(fixture.journal); mutate(changed); fixture.write(fixture.journalPath, changed);
        await assert.rejects(inspectCompletedBootstrap(root, fixture.packet));
    }
    fixture.write(fixture.journalPath, fixture.journal);
    fixture.health.updateMode = 'release'; await assert.rejects(inspectCompletedBootstrap(root, fixture.packet), /health_changed/);
    fixture.health.updateMode = 'local-main'; fixture.health.serverProcessStartTicks = '1';
    await assert.rejects(inspectCompletedBootstrap(root, fixture.packet), /health_changed/);
    fixture.health.serverProcessStartTicks = fixture.consumed.claim.owner.startTime;
    await assert.rejects(inspectCompletedBootstrap(root, { ...fixture.packet, bootstrapCompletion: {
        ...fixture.packet.bootstrapCompletion, receiptSha256: H } }), /file_changed/);
    const envPath = path.join(root, '.env'), originalEnv = fs.readFileSync(envPath);
    fs.writeFileSync(envPath, 'NASSAJ_UPDATE_MODE=release\n');
    await assert.rejects(inspectCompletedBootstrap(root, fixture.packet), /file_changed/);
    fs.writeFileSync(envPath, originalEnv);
    const before = fs.readFileSync(fixture.consumed.file);
    assert.throws(() => verifyBootstrapJournalBinding({ ...fixture.journal, oid: 'f'.repeat(40) }, fixture.record, before, fixture.code.sha256), /journal_binding/);
    assert.deepEqual(fs.readFileSync(fixture.consumed.file), before);
});

async function inspectWithoutDatabaseImport(root, packet) {
    const file = path.join(root, 'reader-packet.json'); fs.writeFileSync(file, JSON.stringify(packet), { mode: 0o600 });
    const operator = new URL('./local-source-recovery-operator.mjs', import.meta.url).href;
    const program = `import assert from 'node:assert/strict';import fs from 'node:fs';import Module from 'node:module';
const sqlite=process.getBuiltinModule('node:sqlite');let opens=0, forbiddenImports=0;
sqlite.DatabaseSync=class{constructor(){opens++;throw Error('database_access_forbidden')}};
assert.throws(()=>new sqlite.DatabaseSync(':memory:'),/database_access_forbidden/);assert.equal(opens,1);opens=0;
const originalLoad=Module._load;Module._load=function(name,...args){if(name==='better-sqlite3'){forbiddenImports++;throw Error('database_import_forbidden')}return originalLoad.call(this,name,...args)};
assert.throws(()=>Module._load('better-sqlite3'),/database_import_forbidden/);assert.equal(forbiddenImports,1);forbiddenImports=0;
const {inspectCompletedBootstrap}=await import(${JSON.stringify(operator)});
const result=await inspectCompletedBootstrap(process.cwd(),JSON.parse(fs.readFileSync(${JSON.stringify(file)})));
assert.equal(opens,0);assert.equal(forbiddenImports,0);console.log(JSON.stringify(result));`;
    const stdout = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module','-e',program],
        { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH } },
        (error, output, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(output)));
    return JSON.parse(stdout);
}

test('completed reader rejects another host or service UID even when the retained record is consistently rehashed', async t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-installation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = completeFixture(root);
    const retained = readOidTripleRetainedExecutor(root, { ...fixture.reference, actionId: fixture.record.actionId, targetDigest: fixture.record.pair.targetDigest });
    for (const patch of [{ hostname: 'different-host' }, { serviceUid: process.getuid() + 1 }]) {
        const record = structuredClone(fixture.record); Object.assign(record.bootstrap.ticket.material.installation, patch);
        const recordBytes = Buffer.from(JSON.stringify(record)), descriptor = structuredClone(retained.descriptor);
        const entry = descriptor.files.find(value => value.name === 'record.json'); entry.sha256 = hash(recordBytes); entry.size = recordBytes.length;
        fs.writeFileSync(path.join(retained.executor, 'record.json'), recordBytes);
        const manifestSha256 = fixture.write(path.join(retained.executor, 'executor-manifest.json'), descriptor);
        fixture.write(fixture.journalPath, { ...fixture.journal,
            recoveryReference: { ...fixture.reference, executorManifestSha256: manifestSha256 } });
        await assert.rejects(inspectCompletedBootstrap(root, fixture.packet), /bootstrap_not_completed/);
    }
});

test('changing transaction data preserves qualified code but changes its retained manifest and detects tampering', t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-retained-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = completeFixture(root), second = structuredClone(fixture.record);
    second.transactionNonce = 'd'.repeat(64); second.bootstrap.ticket.material.executor.transactionNonce = second.transactionNonce;
    const reference = retainOidTripleExecutor(root, { ...executableInput(), record: second });
    assert.notEqual(reference.executorManifestSha256, fixture.reference.executorManifestSha256);
    const retained = readOidTripleRetainedExecutor(root, { ...reference, actionId: second.actionId, targetDigest: second.pair.targetDigest });
    assert.equal(retained.descriptor.codeClosure.sha256, fixture.code.sha256);
    assert.throws(() => retainOidTripleExecutor(root, { ...executableInput(), record: { ...second, transactionNonce: 'e'.repeat(64) },
        externalRuntimeClosures: executableInput().externalRuntimeClosures.map(value => ({ ...value, sha256: 'f'.repeat(64) })) }), /ticket_mismatch/);
    fs.appendFileSync(path.join(retained.executor, 'record.json'), ' ');
    assert.throws(() => readOidTripleRetainedExecutor(root, { ...reference, actionId: second.actionId, targetDigest: second.pair.targetDigest }), /metadata_mismatch/);
});

test('completed reader calls the pinned retained verifier and never substitutes a current-source fallback', async t => {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-verifier-pin-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = completeFixture(root, Buffer.from('export function inspectBootstrapQualification(){throw Error("retained_verifier_sentinel")}'));
    await assert.rejects(inspectCompletedBootstrap(root, fixture.packet), /retained_verifier_sentinel/);
});
