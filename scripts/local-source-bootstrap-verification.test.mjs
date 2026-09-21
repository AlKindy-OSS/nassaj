import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalTripleJson as canonical } from './lib/oid-triple-target.mjs';
import { inspectBootstrapQualification } from './lib/local-source-bootstrap-ticket.mjs';
import { createSyntheticBootstrapQualification } from './update-lab/bootstrap-qualification.fixture.mjs';
const H = 'a'.repeat(64), hash = value => createHash('sha256').update(value).digest('hex');

function material(t) {
    const root = fs.mkdtempSync(path.resolve('.artifacts/bootstrap-verification-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const data = path.join(root, 'appdata'); fs.mkdirSync(data, { mode: 0o700 });
    const databasePath = path.join(data, 'app.db'); fs.writeFileSync(databasePath, 'synthetic data only', { mode: 0o600 });
    const previous = { oid: 'b'.repeat(40), clientOid: 'c'.repeat(40), mode: 'release', nodeVersion: process.version, nodeModuleAbi: process.versions.modules };
    for (const key of ['serverBuildId','clientBuildId','controlManifestSha256','serverInputManifestSha256','serverProvenanceSha256',
        'clientProvenanceSha256','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256','dependencyLegacyActualSha256',
        'nodeBinarySha256','pm2PackageTreeSha256','safeRestartSha256','admissionImplementationSha256']) previous[key] = H;
    return { installation: { root, commonGit: path.join(root, '.git'), hostname: os.hostname(), serviceUid: process.getuid() },
        previous, actualPrevious: previous, liveManifest: { runtimeDependenciesSha256: 'd'.repeat(64) },
        executorCodeClosureSha256: H, verifierClosureSha256: H, databasePath };
}

test('closed qualification verifies all observed cases, indexed evidence, code and review chain with dedicated appdata', t => {
    const input = material(t), fixture = createSyntheticBootstrapQualification(input);
    const verified = inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference });
    assert.equal(verified.qualificationSha256, fixture.qualificationReference.sha256);
    assert.equal(verified.exceptions.length, 1);
    assert.deepEqual(verified.appDataGuard, { directory: path.dirname(input.databasePath),
        dev: String(fs.statSync(path.dirname(input.databasePath)).dev), ino: String(fs.statSync(path.dirname(input.databasePath)).ino),
        dedicated: true, attestationSha256: fixture.qualificationReference.sha256 });
});

test('self-consistent rehashed reports cannot turn unsafe observed facts into a pass', t => {
    const input = material(t);
    const mutations = {
        loaded_identity: value => value.observations.healthServerBuildId = 'f'.repeat(64),
        admission_exclusion: value => value.observations.effects.stopRequests = 1,
        old_stop: value => value.observations.remainingWriterPids = [1],
        old_restart_under_gate: value => value.observations.databaseAfter = { ...value.observations.databaseAfter, ino: '1' },
        pid_and_peer_races: value => value.observations.refusals.pop(),
        crash_after_stop: value => value.observations.recovery.targetStartRequests = 1,
        crash_after_mode: value => value.observations.recovery.databaseRestores = 1,
        crash_after_exchange: value => value.final.mode = 'local-main',
        candidate_start_unknown: value => value.observations.rollbackRequests = 1,
        evidence_negative: value => value.observations.refusals[0].effects.exchangeRequests = 1,
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        const fixture = createSyntheticBootstrapQualification({ ...input, mutateCase(value) { if (value.name === name) mutate(value); } });
        assert.throws(() => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference }), /bootstrap_ticket_rehearsal_/);
    }
});

test('missing, unlisted or modified evidence and changed code closure refuse', t => {
    const input = material(t), fixture = createSyntheticBootstrapQualification(input), directory = fixture.qualificationReference.directory;
    const inspect = changed => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference, ...changed });
    assert.throws(() => inspect({ executorCodeClosureSha256: 'f'.repeat(64) }), /qualification_closure/);
    assert.throws(() => inspect({ verifierClosureSha256: 'f'.repeat(64) }), /qualification_closure/);
    const file = path.join(directory, 'loaded_identity.json'), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, '\n'); assert.throws(() => inspect(), /file_changed/); fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(directory, 'unlisted.json'), '{}', { mode: 0o600 });
    assert.throws(() => inspect(), /evidence_unlisted/); fs.unlinkSync(path.join(directory, 'unlisted.json'));
    fs.unlinkSync(file); assert.throws(() => inspect(), /ENOENT/);
});

test('review scope and directory identity stay mandatory after rehashing the document envelope', t => {
    const input = material(t), fixture = createSyntheticBootstrapQualification(input), directory = fixture.qualificationReference.directory;
    const reviewFile = path.join(directory, 'qa-review.json'), review = JSON.parse(fs.readFileSync(reviewFile));
    review.reviewer.role = 'author'; const bytes = Buffer.from(canonical(review)); fs.writeFileSync(reviewFile, bytes);
    fixture.qualification.review.receiptSha256 = hash(bytes);
    const qualificationBytes = Buffer.from(canonical(fixture.qualification));
    fs.writeFileSync(path.join(directory, 'qualification.json'), qualificationBytes); fixture.qualificationReference.sha256 = hash(qualificationBytes);
    assert.throws(() => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference }), /qualification_reviewer/);
    fs.chmodSync(path.dirname(input.databasePath), 0o755);
    assert.throws(() => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference }), /appdata_identity/);
});

test('rehashed return cases cannot substitute the same unrelated database on both sides', t => {
    const input = material(t);
    for (const name of ['old_restart_under_gate','crash_after_stop','crash_after_mode','crash_after_exchange']) {
        const fixture = createSyntheticBootstrapQualification({ ...input, mutateCase(value) {
            if (value.name !== name) return;
            const observation = value.observations.recovery || value.observations;
            const changed = { ...observation.databaseBefore, ino: '987654321', path: path.join(path.dirname(input.databasePath), 'other.db') };
            observation.databaseBefore = changed; observation.databaseAfter = changed;
        } });
        assert.throws(() => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference }), /rehearsal_previous_return/);
    }
    const fixture = createSyntheticBootstrapQualification({ ...input, mutateCase(value) {
        if (value.name === 'old_restart_under_gate') value.observations.childReceipt.nodeModulesTreeSha256 = 'f'.repeat(64);
    } });
    assert.throws(() => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference }), /rehearsal_previous_receipt/);
});

test('rehashed journal from a different attempt, previous tree or process cannot satisfy a case', t => {
    const input = material(t);
    for (const mutate of [journal => journal.transactionNonce = 'f'.repeat(64),
        journal => journal.actionId = '22222222-2222-2222-2222-222222222222',
        journal => journal.pair.previous.serverTreeSha256 = 'f'.repeat(64), journal => journal.pair.previous.runtime.pid++,
        journal => journal.pair.previous.runtime.startTime = '999', journal => journal.pair.previous.runtime.oid = 'f'.repeat(40)]) {
        const fixture = createSyntheticBootstrapQualification({ ...input, mutateJournal(journal, name) { if (name === 'old_stop') mutate(journal); } });
        assert.throws(() => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference }), /rehearsal_(attempt|journal_previous|journal_runtime)/);
    }
});

test('indexed commands and exit or signal evidence must match the recorded injection', t => {
    const input = material(t);
    for (const [caseName, mutate] of [
        ['loaded_identity', execution => execution.exitCode = 1],
        ['old_stop', execution => execution.command = []],
        ['crash_after_mode', execution => execution.signal = 'SIGTERM'],
        ['crash_after_stop', execution => execution.injectedPhase = 'crash_after_exchange'],
    ]) {
        const fixture = createSyntheticBootstrapQualification({ ...input, mutateExecution(value, name) { if (name === caseName) mutate(value); } });
        assert.throws(() => inspectBootstrapQualification({ ...input, qualificationReference: fixture.qualificationReference }), /rehearsal_(command|crash_exit)/);
    }
});
