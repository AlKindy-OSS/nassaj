import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { applyLocalRecoveryMode as productionApply } from './local-source-recovery-mode.mjs';
// Fault injection lives only in this in-memory test copy. Production exports have
// no dependency arguments: callers cannot substitute authority or tree verification.
let fixtureSource = fs.readFileSync(new URL('./local-source-recovery-mode.mjs', import.meta.url), 'utf8');
fixtureSource = fixtureSource
    .replace("'./source-update-tree-identity.mjs'", JSON.stringify(new URL('./source-update-tree-identity.mjs', import.meta.url).href))
    .replaceAll('root, artifactRoot)', 'root, artifactRoot, dependencies)')
    .replace('authority(binding, actionSha));', 'dependencies.authority(binding, actionSha));')
    .replace('    verifyTrees(root, manifest);', '    dependencies.verifyTrees(root, manifest);')
    .replace('    context = inspectLocalRecoveryMode(root, artifactRoot, dependencies);',
        "    dependencies.checkpoint?.('prepared');\n    context = inspectLocalRecoveryMode(root, artifactRoot, dependencies);")
    .replace("    durable(context.intentFile, JSON.stringify({ identity: context.identity, state: 'config_applied' }));",
        "    dependencies.checkpoint?.('config_renamed');\n    durable(context.intentFile, JSON.stringify({ identity: context.identity, state: 'config_applied' }));")
    .replace('if (process.argv[1] && fileURLToPath(import.meta.url)', 'if (false && fileURLToPath(import.meta.url)');
const { inspectLocalRecoveryMode, applyLocalRecoveryMode } = await import(`data:text/javascript;base64,${Buffer.from(fixtureSource).toString('base64')}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical)}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
function fixture(t) {
    const base = new URL('../../.artifacts/', import.meta.url); fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base.pathname, 'mode-fixture-')); t.after(() => fs.rmSync(root, { recursive: true }));
    const control = path.join(root, '.git/nassaj-source-update'), candidate = path.join(control, 'candidates/tx1');
    fs.mkdirSync(candidate, { recursive: true }); fs.mkdirSync(path.join(root, 'dist-server'));
    const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    const original = 'DATABASE_PATH=/fixture/private.db\n', proposal = original + 'NASSAJ_UPDATE_MODE=local-main\n';
    write(path.join(root, '.env'), original); write(path.join(candidate, 'local-recovery-proposal.env'), proposal);
    const config = { schema: 'nassaj-local-recovery-config/v1', id: 'config1', root, transactionId: 'tx1', actionId: 'action1',
        originalEnvSha256: sha(original), proposalEnvSha256: sha(proposal), approvalReference: 'approval1', reservationReference: 'reservation1' };
    write(path.join(candidate, 'local-recovery-config.json'), config);
    const binding = { schema: 'nassaj-local-source-recovery-operation/v1', root, nodeIdentity: os.hostname(), jobId: 'job1', actionId: 'action1',
        transactionId: 'tx1', ownerId: 1, previousSourceOid: 'c'.repeat(40), approvalReference: 'approval1', reservationReference: 'reservation1',
        previousRuntime: { pid: 42, startTicks: '100' }, modeTransition: { from: 'release', to: 'local-main', configReceiptId: 'config1',
            configBindingSha256: sha(JSON.stringify(config)), originalEnvSha256: sha(original), proposalEnvSha256: sha(proposal) } };
    const manifest = { txId: 'tx1', version: '2.2.0.1', releaseCommit: 'a'.repeat(40), serverBuildId: 'b'.repeat(64), operationBinding: binding };
    write(path.join(candidate, 'candidate-manifest.json'), manifest);
    const manifestSha = sha(JSON.stringify(manifest)), action = { transactionId: 'tx1', targetCommit: manifest.releaseCommit,
        manifestSha256: manifestSha, manifestPath: path.join(candidate, 'candidate-manifest.json') };
    write(path.join(candidate, 'activation-action.json'), action);
    const actionSha = sha(JSON.stringify(action));
    const token = 'token-bytes'; write(path.join(control, 'token'), token+'\n');
    const handoff = { schema: 'nassaj-source-update-bootstrap/v1', transactionId: 'tx1', epoch: 'epoch1', tokenFilePath: path.join(control, 'token') };
    write(path.join(control, 'bootstrap-handoff.json'), handoff);
    const journal = { schema: 'nassaj-source-update-maintenance/v1', state: 'UPDATING', gateClosed: true, phase: 'RESTARTING_HANDOFF', databaseState: 'UNKNOWN',
        transactionId: 'tx1', identity: { manifestSha256: manifestSha, targetCommit: manifest.releaseCommit, originalHead: binding.previousSourceOid, expectedVersion: manifest.version },
        owner: { bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: 42, startTime: '100', epoch: 'epoch1', tokenDigest: sha(token) } };
    const saveJournal = () => { const { checksum, ...payload } = journal; journal.checksum = sha(canonical(payload)); write(path.join(control, 'journal.json'), journal); };
    saveJournal();
    const evidence = { owner: { id: 1 }, job: { id: 'job1', owner_id: 1, state: 'runtime_verifying', strategy: 'git-checkout-v2', transaction_id: 'tx1',
        release_commit: manifest.releaseCommit, expected_server_build_id: manifest.serverBuildId, activation_identity_sha256: actionSha },
        action: { id: 'action1', status: 'pending', action_type: 'safe-restart', source_update_job_id: 'job1', source_update_transaction_id: 'tx1',
            activation_identity_sha256: actionSha, expected_server_build_id: manifest.serverBuildId, release_commit: manifest.releaseCommit } };
    const dependencies = { authority: () => evidence, verifyTrees() {} };
    const inspect = () => inspectLocalRecoveryMode(root, path.join(root, 'dist-server'), dependencies);
    const apply = () => applyLocalRecoveryMode(root, path.join(root, 'dist-server'), dependencies);
    return { root, control, candidate, write, original, proposal, config, binding, manifest, journal, saveJournal, evidence, dependencies, inspect, apply };
}
test('inspection of a bound handoff is read-only; apply makes the one MODE change', t => {
    const f = fixture(t); assert.ok(f.inspect()); assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.original);
    assert.equal(f.apply().state, 'restart_intent'); assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.proposal);
    assert.equal(fs.readFileSync(path.join(f.candidate, 'local-recovery-original.env'), 'utf8'), f.original);
    assert.throws(f.apply, /manual_recovery_required/);
});
for (const checkpoint of ['prepared', 'config_renamed']) test(`interruption after ${checkpoint} resumes only the same handoff`, t => {
    const f = fixture(t); f.dependencies.checkpoint = phase => { if (phase === checkpoint) throw new Error('interrupted'); };
    assert.throws(f.apply, /interrupted/); delete f.dependencies.checkpoint;
    assert.equal(f.apply().state, 'restart_intent');
});
for (const [label, mutate] of [
    ['failed generic action', f => { f.evidence.action.status = 'failed'; f.evidence.action.error = 'execution_unresolved'; }],
    ['wrong job', f => { f.evidence.action.source_update_job_id = 'other'; }],
    ['wrong target', f => { f.evidence.job.release_commit = 'd'.repeat(40); }],
    ['inactive owner', f => { f.evidence.owner = null; }],
    ['wrong build', f => { f.evidence.action.expected_server_build_id = 'c'.repeat(64); }],
    ['wrong transaction', f => { f.evidence.job.transaction_id = 'other'; }],
    ['unprepared job', f => { f.evidence.job.state = 'restart_queued'; }],
]) test(`rejects ${label} without touching config`, t => {
    const f = fixture(t); mutate(f); assert.throws(f.apply, /authority_changed/);
    assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.original);
});
for (const phase of ['ACTIVATION_QUEUED', 'BOOTSTRAP_CLAIMED']) test(`rejects ${phase} and never changes MODE before handoff`, t => {
    const f = fixture(t); f.journal.phase = phase; f.saveJournal(); assert.throws(f.apply, /handoff_changed/);
    assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.original);
});
test('UNKNOWN alone does not grant authority, and ambiguity after intent never restores config', t => {
    const f = fixture(t); f.apply(); f.journal.owner.pid = 43; f.saveJournal();
    assert.throws(f.inspect, /handoff_changed/); assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.proposal);
});
test('second inspection catches main changing at final boundary', t => {
    const f = fixture(t); let reads = 0; f.dependencies.verifyTrees = () => { if (++reads === 2) throw new Error('target_changed'); };
    assert.throws(f.apply, /target_changed/); assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.original);
});
test('config CAS refuses unrelated edits', t => {
    const f = fixture(t); f.write(path.join(f.root, '.env'), f.original + 'OTHER=changed\n');
    assert.throws(f.apply, /config_cas_changed/);
});
test('forged handoff checksum and unsafe config permissions fail closed', t => {
    const f = fixture(t); f.journal.checksum = '0'.repeat(64); f.write(path.join(f.control, 'journal.json'), f.journal);
    assert.throws(f.inspect, /handoff_changed/); f.saveJournal();
    fs.chmodSync(path.join(f.candidate, 'local-recovery-config.json'), 0o644); assert.throws(f.inspect, /unsafe_file/);
});
test('no handoff has no side effects and cannot apply MODE', t => {
    const f = fixture(t); fs.unlinkSync(path.join(f.control, 'bootstrap-handoff.json'));
    assert.equal(f.inspect(), null); assert.throws(f.apply, /handoff_required/);
});

test('kernel lock excludes a second apply and releases after interruption', t => {
    const f = fixture(t); let nested = false;
    f.dependencies.checkpoint = phase => {
        if (phase !== 'prepared') return;
        nested = true;
        assert.throws(f.apply, /concurrent_transition/);
        throw new Error('interrupted');
    };
    assert.throws(f.apply, /interrupted/); assert.equal(nested, true);
    delete f.dependencies.checkpoint; assert.equal(f.apply().state, 'restart_intent');
});
test('proposal and original symlink substitution fail closed', t => {
    const f = fixture(t), proposalPath = path.join(f.candidate, 'local-recovery-proposal.env');
    fs.renameSync(proposalPath, proposalPath + '.saved'); fs.symlinkSync(proposalPath + '.saved', proposalPath);
    assert.throws(f.apply); assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.original);
});

test('production apply ignores attempted verifier injection and leaves config untouched', t => {
    const f = fixture(t); let substituted = false;
    assert.throws(() => productionApply(f.root, path.join(f.root, 'dist-server'), {
        authority() { substituted = true; return f.evidence; }, verifyTrees() {},
    }));
    assert.equal(substituted, false);
    assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), f.original);
});
