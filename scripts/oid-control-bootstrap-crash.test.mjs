import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createBootstrapTicket, consumeBootstrapTicket, bootstrapClock } from './lib/local-source-bootstrap-ticket.mjs';
import { canonicalTripleJson } from './lib/oid-triple-target.mjs';
import { hashDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';
import { applyBootstrapModeCAS, restoreBootstrapModeCAS, buildOidTripleStartEnvironment, hashOidPairTree } from './oid-control-capsule.source.mjs';

const capsuleUrl = new URL('./oid-control-capsule.source.mjs', import.meta.url).href;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// These are inputs to the MODE seam, not tickets, qualification or approval receipts.
function modeFixture(t) {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-crash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('/usr/bin/git', ['init', '-q', root]).status, 0);
    fs.chmodSync(path.join(root, '.git'), 0o700);
    const nonce = 'c'.repeat(64), recovery = path.join(root, '.git/nassaj-oid-recovery', nonce);
    fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const original = Buffer.from('# retain exact comments\nPORT=3004\nNASSAJ_UPDATE_MODE=release\nKEEP="yes"\n');
    const proposal = Buffer.from(original.toString().replace('NASSAJ_UPDATE_MODE=release', 'NASSAJ_UPDATE_MODE=local-main'));
    fs.writeFileSync(path.join(root, '.env'), original, { mode: 0o600 });
    const record = { bootstrap: { proposalEnvBase64: proposal.toString('base64'), ticket: { material: {
        mode: { originalEnvSha256: sha(original), proposalEnvSha256: sha(proposal) },
    } } } };
    const file = path.join(root, '.git', `nassaj-oid-control-transaction-1-${nonce}.json`);
    const transaction = { state: 'triple_old_stopped', oldStoppedAt: 1, transactionNonce: nonce,
        bootstrap: {}, pair: { databaseState: 'PRE_CANDIDATE' } };
    fs.writeFileSync(file, JSON.stringify(transaction), { mode: 0o600 });
    const input = path.join(root, 'mode-input.json');
    fs.writeFileSync(input, JSON.stringify({ root, file, record, transaction, recovery }), { mode: 0o600 });
    return { root, file, record, transaction, recovery, original, proposal, input };
}

// Kill the child only after the production fsync completed. No transaction logic
// is copied or replaced, and the process cannot execute a host service operation.
function crashMode(fixture, checkpoint) {
    const program = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const input=JSON.parse(fs.readFileSync(process.argv[1])); const checkpoint=process.argv[2];
const realSync=fs.fsyncSync; fs.fsyncSync=function(fd){realSync(fd);
 const target=fs.readlinkSync('/proc/self/fd/'+fd);const journal=JSON.parse(fs.readFileSync(input.file));
 const backup=input.recovery+'/bootstrap-mode-original.env';const env=fs.readFileSync(input.root+'/.env','utf8');
 const matches=checkpoint==='intent' ? target===input.root+'/.git' && journal.state==='bootstrap_mode_intent' && !fs.existsSync(backup)
 : checkpoint==='backup' ? target===input.recovery && fs.existsSync(backup) && !env.includes('MODE=local-main')
 : checkpoint==='staged' ? target===input.recovery+'/bootstrap-mode-proposal-'+journal.transactionNonce+'.env' && env.includes('MODE=release')
 : checkpoint==='applied' ? target===input.root && env.includes('MODE=local-main') && journal.state==='bootstrap_mode_intent'
 : target===input.root+'/.git' && journal.state==='bootstrap_mode_verified';
 if(matches)process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();
const {applyBootstrapModeCAS}=await import(${JSON.stringify(capsuleUrl)});
applyBootstrapModeCAS(input.root,input.file,input.transaction,input.record);
throw Error('checkpoint_not_reached');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, fixture.input, checkpoint],
        { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    return JSON.parse(fs.readFileSync(fixture.file));
}

for (const checkpoint of ['intent', 'backup', 'staged', 'applied', 'verified']) {
    test(`MODE crash after durable ${checkpoint} restores exact original bytes before candidate start`, t => {
        const f = modeFixture(t), journal = crashMode(f, checkpoint);
        assert.equal(journal.pair.databaseState, 'PRE_CANDIDATE');
        assert.equal(journal.bootDirection, undefined);
        assert.equal(journal.pm2Operations, undefined);
        const before = fs.readFileSync(path.join(f.root, '.env'));
        assert.deepEqual(before, ['applied', 'verified'].includes(checkpoint) ? f.proposal : f.original);
        const restored = restoreBootstrapModeCAS(f.root, f.file, journal, f.record);
        assert.equal(restored.bootstrapMode.state, 'restored');
        assert.deepEqual(fs.readFileSync(path.join(f.root, '.env')), f.original);
        assert.equal(fs.statSync(path.join(f.root, '.env')).mode & 0o777, 0o600);
        assert.equal(fs.existsSync(path.join(f.recovery, `bootstrap-mode-proposal-${journal.transactionNonce}.env`)), false);
    });
}

for (const change of [
    { pair: { databaseState: 'UNKNOWN' } },
    { bootDirection: 'target' },
    { pm2Operations: { 'start-stopped': { state: 'intent' } } },
]) test(`MODE recovery refuses possible startup evidence ${JSON.stringify(change)}`, t => {
    const f = modeFixture(t), journal = applyBootstrapModeCAS(f.root, f.file, f.transaction, f.record);
    const before = fs.readFileSync(f.file);
    assert.throws(() => restoreBootstrapModeCAS(f.root, f.file, { ...journal, ...change }, f.record), /restore_forbidden/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.env')), f.proposal);
    assert.deepEqual(fs.readFileSync(f.file), before);
});

for (const combination of ['original/original', 'proposal/proposal', 'proposal/missing', 'proposal/tampered']) {
    test(`MODE recovery denies unproved ${combination} exchange state`, t => {
        const f = modeFixture(t), journal = applyBootstrapModeCAS(f.root, f.file, f.transaction, f.record);
        const envFile = path.join(f.root, '.env');
        const stage = path.join(f.recovery, `bootstrap-mode-proposal-${journal.transactionNonce}.env`);
        if (combination === 'original/original') fs.writeFileSync(envFile, f.original);
        if (combination === 'proposal/proposal') fs.writeFileSync(stage, f.proposal);
        if (combination === 'proposal/missing') fs.unlinkSync(stage);
        if (combination === 'proposal/tampered') fs.writeFileSync(stage, 'tampered');
        assert.throws(() => restoreBootstrapModeCAS(f.root, f.file, journal, f.record), /cas_unknown/);
    });
}

test('ordinary triple update preserves MODE and all unrelated environment values', t => {
    const f = modeFixture(t), saved = { NASSAJ_UPDATE_MODE: 'local-main', KEEP: 'unchanged', ZERO: '0' };
    const before = fs.readFileSync(path.join(f.root, '.env'));
    const transaction = { transactionNonce: 'a'.repeat(64), bootNonce: 'b'.repeat(64) };
    for (const rollback of [false, true]) {
        const next = buildOidTripleStartEnvironment(saved, transaction, rollback);
        assert.deepEqual(next, { ...saved, NASSAJ_PREVIEW_TRANSACTION_NONCE: transaction.transactionNonce,
            NASSAJ_PREVIEW_BOOT_NONCE: transaction.bootNonce });
        assert.equal(Object.hasOwn(buildOidTripleStartEnvironment({ KEEP: 'unchanged' }, transaction, rollback), 'NASSAJ_UPDATE_MODE'), false);
    }
    assert.throws(() => applyBootstrapModeCAS(f.root, f.file, { ...f.transaction, bootstrap: undefined }, f.record), /boundary_invalid/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.env')), before);
});

// Expose private orchestration seams in a test-only copy, without changing their
// bodies. The only substitutable operation is the external supervisor read.
function exposeOrchestration(f) {
    const source = fs.readFileSync(new URL('./oid-control-capsule.source.mjs', import.meta.url), 'utf8')
        .replace(/from '(\.\/[^']+)'/g, (_, name) => `from '${new URL(name, capsuleUrl).href}'`);
    const file = path.join(f.root, 'capsule-test-seams.mjs');
    fs.writeFileSync(file, source + '\nexport {startAndAttestOidTriple, recoverOidTripleOwnedFailure, abortBootstrapClaimWithoutJournal};\n'
        + 'export function setHostReadForTest(read) { triplePm2Read = read; }\n', { mode: 0o600 });
    return file;
}

test('candidate start crash durably records UNKNOWN before service launch and recovery never replays or rolls back', async t => {
    const f = modeFixture(t), moduleFile = exposeOrchestration(f);
    const transaction = { ...f.transaction, schema: 'nassaj-oid-control-transaction/v2', sequence: 1,
        actionId: 'synthetic-action', targetDigest: 'd'.repeat(64), state: 'triple_exchanged',
        supervisor: { root: f.root, name: 'synthetic-service', pmId: 0 },
        pair: { databaseState: 'PRE_CANDIDATE', targetDigest: 'd'.repeat(64) } };
    fs.writeFileSync(f.file, JSON.stringify(transaction));
    const slot = { name: 'synthetic-service', pm_id: 0, pid: 0, pm2_env: {
        pm_exec_path: path.join(f.root, 'dist-server/server/index.js'), pm_cwd: f.root,
        status: 'stopped', treekill: false, kill_timeout: 86400000, env: { NASSAJ_UPDATE_MODE: 'release' },
    } };
    const marker = path.join(f.root, 'forbidden-service-start');
    const safeBytes = Buffer.from(`#!/bin/sh\nprintf invoked > '${marker}'\nexit 1\n`);
    fs.writeFileSync(f.input, JSON.stringify({ root: f.root, file: f.file, transaction, slot, safe: safeBytes.toString('base64') }));
    const program = `import fs from 'node:fs'; const input=JSON.parse(fs.readFileSync(process.argv[1]));
const capsule=await import(process.argv[2]);capsule.setHostReadForTest(async()=>[input.slot]);
await capsule.startAndAttestOidTriple(input.root,{repoRoot:input.root},Buffer.from(input.safe,'base64'),
 {transition(value){fs.writeFileSync(input.root+'/transition.json',JSON.stringify(value));}},input.file,input.transaction);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.input, moduleFile], {
        timeout: 5000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test',
            NASSAJ_OID_CAPSULE_CRASH_AT: 'triple_before_candidate_start' },
    });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    const journal = JSON.parse(fs.readFileSync(f.file));
    assert.equal(journal.state, 'triple_candidate_start_intent');
    assert.equal(journal.bootDirection, 'target');
    assert.equal(journal.pair.databaseState, 'UNKNOWN');
    assert.match(journal.bootNonce, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'transition.json'))).databaseState, 'UNKNOWN');
    assert.equal(fs.existsSync(marker), false);
    const module = await import(moduleFile), transitions = [];
    module.setHostReadForTest(() => assert.fail('UNKNOWN recovery must not request supervisor operations'));
    const receipt = await module.recoverOidTripleOwnedFailure(f.root, {}, safeBytes,
        { transition: value => transitions.push(value) }, f.file, journal, new Error('synthetic crash'));
    assert.equal(receipt.restored, false);
    const recovered = JSON.parse(fs.readFileSync(f.file));
    assert.equal(recovered.state, 'manual_recovery_required');
    assert.equal(recovered.pair.databaseState, 'UNKNOWN');
    assert.equal(recovered.bootNonce, journal.bootNonce);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].state, 'MANUAL');
    assert.equal(transitions[0].gateClosed, true);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.env')), f.original);
});

function processIdentity() {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    return { pid: process.pid, bootId: bootstrapClock().bootId,
        startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
}

function claimedFixture(t) {
    const f = modeFixture(t), h = 'a'.repeat(64), owner = processIdentity();
    const git = args => {
        const result = spawnSync('/usr/bin/git', args, { cwd: f.root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'synthetic']);
    const oid = git(['rev-parse', 'HEAD']); git(['update-ref', 'refs/heads/main', oid]);
    for (const name of ['dist', 'dist-server', 'node_modules']) fs.mkdirSync(path.join(f.root, name));
    for (const name of ['dist', 'dist-server']) fs.writeFileSync(path.join(f.root, name, 'BUILD_PROVENANCE.json'), JSON.stringify({ buildId: h, commit: oid }));
    fs.writeFileSync(path.join(f.root, 'node_modules', 'fixture'), 'original dependencies');
    const db = path.join(f.root, 'synthetic.db'); fs.writeFileSync(db, 'synthetic fixture bytes', { mode: 0o600 });
    const stat = fs.statSync(db), previous = { oid, clientOid: oid, clientBuildId: h, serverBuildId: h,
        clientTreeSha256: hashOidPairTree(path.join(f.root, 'dist')), serverTreeSha256: hashOidPairTree(path.join(f.root, 'dist-server')),
        nodeModulesTreeSha256: hashDependencyTreeV2(path.join(f.root, 'node_modules')).sha256, controlManifestSha256: h };
    const material = { installation: { root: f.root, commonGit: path.join(f.root, '.git'), hostname: os.hostname(), serviceUid: process.getuid() },
        event: { sequence: 1, group: 'event-0000000000000001', oid, targetDigest: h, manifestSha256: h },
        approval: { ownerId: '1', receiptSha256: h },
        previous: { pid: owner.pid, ppid: process.ppid, startTicks: owner.startTime,
            clientBuildId: h, serverBuildId: h, controlManifestSha256: h,
            clientTreeSha256: previous.clientTreeSha256, serverTreeSha256: previous.serverTreeSha256,
            nodeModulesTreeSha256: previous.nodeModulesTreeSha256 },
        supervisor: { pid: process.ppid, startTicks: '1', observerSha256: h, slotSha256: h, environmentSha256: h, dumpSha256: h },
        database: { path: db, dev: String(stat.dev), ino: String(stat.ino) },
        mode: { original: 'release', proposed: 'local-main', originalEnvSha256: sha(f.original), proposalEnvSha256: sha(f.proposal) },
        baseline: { attestationSha256: h, rehearsalSha256: h }, executor: { codeClosureSha256: h, transactionNonce: f.transaction.transactionNonce } };
    const ticket = createBootstrapTicket(material);
    const record = { transactionNonce: f.transaction.transactionNonce, bootstrap: { ticket, previousMaterial: previous } };
    const paths = { gitRoot: path.join(f.root, '.git'), journal: path.join(f.root, '.git/maintenance.json') };
    const maintenance = { schema: 'nassaj-source-update-maintenance/v1', sequence: 1, state: 'OPEN', gateClosed: false };
    fs.writeFileSync(paths.journal, JSON.stringify({ ...maintenance, checksum: sha(canonicalTripleJson(maintenance)) }), { mode: 0o600 });
    fs.unlinkSync(f.file);
    fs.writeFileSync(f.input, JSON.stringify(ticket));
    const ticketUrl = new URL('./lib/local-source-bootstrap-ticket.mjs', import.meta.url).href;
    const program = `import fs from 'node:fs';import {consumeBootstrapTicket,bootstrapClock} from ${JSON.stringify(ticketUrl)};
const ticket=JSON.parse(fs.readFileSync(process.argv[1]));const clock=bootstrapClock();const stat=fs.readFileSync('/proc/self/stat','utf8');
consumeBootstrapTicket(ticket,ticket.material,{pid:process.pid,bootId:clock.bootId,startTime:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]},clock);
process.kill(process.pid,'SIGKILL');`;
    const crash = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.input], { encoding: 'utf8', timeout: 5000 });
    assert.equal(crash.signal, 'SIGKILL', crash.stderr);
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({
        pid: owner.pid, serverProcessStartTicks: owner.startTime, serverLoadedOid: oid,
        serverLoadedBuildId: h, clientBuildIdServed: h,
    }) }));
    const claimFile = path.join(f.recovery, `bootstrap-claim-${ticket.nonce}.json`);
    return { ...f, paths, record, ticket, material, owner, claimFile };
}

test('claim-only crash records aborted_pre_effect and leaves the consumed nonce unusable', async t => {
    const f = claimedFixture(t), module = await import(exposeOrchestration(f));
    const before = fs.readFileSync(f.claimFile);
    const result = await module.abortBootstrapClaimWithoutJournal(f.root, f.record, f.paths);
    assert.equal(result.state, 'aborted_pre_effect');
    assert.equal(fs.existsSync(f.file), false);
    assert.deepEqual(fs.readFileSync(f.claimFile), before);
    assert.throws(() => consumeBootstrapTicket(f.ticket, f.material, f.owner), /EEXIST/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.env')), f.original);
    const abortFile = path.join(f.recovery, 'bootstrap-aborted-pre-effect.json'), receiptBytes = fs.readFileSync(abortFile);
    assert.equal(JSON.parse(receiptBytes).claimSha256, sha(before));
    assert.deepEqual(await module.abortBootstrapClaimWithoutJournal(f.root, f.record, f.paths), result);
    assert.deepEqual(fs.readFileSync(abortFile), receiptBytes);
});

for (const mutation of ['corrupt', 'mismatch', 'symlink', 'mode', 'hardlink']) {
    test(`claim-only recovery refuses ${mutation} abort receipt`, async t => {
        const f = claimedFixture(t), module = await import(exposeOrchestration(f));
        await module.abortBootstrapClaimWithoutJournal(f.root, f.record, f.paths);
        const abortFile = path.join(f.recovery, 'bootstrap-aborted-pre-effect.json');
        if (mutation === 'corrupt') fs.writeFileSync(abortFile, '{');
        if (mutation === 'mismatch') {
            const receipt = JSON.parse(fs.readFileSync(abortFile)); receipt.reason = 'different';
            fs.writeFileSync(abortFile, `${JSON.stringify(receipt, null, 2)}\n`);
        }
        if (mutation === 'symlink') {
            const target = `${abortFile}.target`; fs.renameSync(abortFile, target); fs.symlinkSync(target, abortFile);
        }
        if (mutation === 'mode') fs.chmodSync(abortFile, 0o644);
        if (mutation === 'hardlink') fs.linkSync(abortFile, `${abortFile}.second-link`);
        await assert.rejects(module.abortBootstrapClaimWithoutJournal(f.root, f.record, f.paths));
    });
}

for (const change of ['environment', 'database-inode', 'main', 'runtime', 'dependencies', 'closed-maintenance', 'owner-alive']) {
    test(`claim-only recovery refuses changed ${change}`, async t => {
        const f = claimedFixture(t), module = await import(exposeOrchestration(f));
        if (change === 'owner-alive') {
            const claim = JSON.parse(fs.readFileSync(f.claimFile));
            claim.owner = f.owner;
            fs.writeFileSync(f.claimFile, `${canonicalTripleJson(claim)}\n`);
        }
        if (change === 'closed-maintenance') {
            const { checksum: _checksum, ...maintenance } = JSON.parse(fs.readFileSync(f.paths.journal));
            maintenance.state = 'MANUAL'; maintenance.gateClosed = true;
            fs.writeFileSync(f.paths.journal, JSON.stringify({ ...maintenance, checksum: sha(canonicalTripleJson(maintenance)) }));
        }
        if (change === 'environment') fs.appendFileSync(path.join(f.root, '.env'), 'EXTRA=changed\n');
        if (change === 'database-inode') {
            fs.renameSync(f.material.database.path, f.material.database.path + '.old');
            fs.writeFileSync(f.material.database.path, 'different synthetic database', { mode: 0o600 });
        }
        if (change === 'main') {
            const git = spawnSync('/usr/bin/git', ['update-ref', '-d', 'refs/heads/main'], { cwd: f.root });
            assert.equal(git.status, 0);
        }
        if (change === 'runtime') t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
        if (change === 'dependencies') fs.writeFileSync(path.join(f.root, 'node_modules/fixture'), 'changed dependencies');
        await assert.rejects(module.abortBootstrapClaimWithoutJournal(f.root, f.record, f.paths));
        assert.equal(fs.existsSync(path.join(f.recovery, 'bootstrap-aborted-pre-effect.json')), false);
    });
}
