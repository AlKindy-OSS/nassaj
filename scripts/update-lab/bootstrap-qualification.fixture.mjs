/** Synthetic verifier inputs only. Never use these receipts as owner approval or actual-old qualification. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalTripleJson as canonical } from '../lib/oid-triple-target.mjs';

const ARTIFACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.artifacts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const H = 'a'.repeat(64);

/** Default synthetic material for unit fixtures; callers may replace digest fields with their fixture bytes. */
export function syntheticBootstrapPrevious(controlManifestBytes) {
    const previous = { oid: 'b'.repeat(40), clientOid: 'c'.repeat(40), mode: 'release', nodeVersion: process.version, nodeModuleAbi: process.versions.modules };
    for (const key of ['serverBuildId','clientBuildId','controlManifestSha256','serverInputManifestSha256','serverProvenanceSha256',
        'clientProvenanceSha256','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256','dependencyLegacyActualSha256',
        'nodeBinarySha256','pm2PackageTreeSha256','safeRestartSha256','admissionImplementationSha256']) previous[key] = H;
    previous.controlManifestSha256 = hash(controlManifestBytes);
    return previous;
}

function previousReturn(initial, final, database) {
    return { gateClosed: true, newWriterStatus: 503, databaseBefore: database, databaseAfter: database,
        usersBeforeSha256: H, usersAfterSha256: H, targetStartRequests: 0, databaseRestores: 0,
        childReceipt: { schema: 'nassaj-oid-triple-bootstrap/v2', rollback: true, pid: final.pid,
            startTime: final.startTicks, serverBuildId: final.serverBuildId, clientBuildId: final.clientBuildId,
            nodeModulesTreeSha256: final.nodeModulesTreeSha256 } };
}

function observedCases(previous, bindings, database) {
    const initial = { pid: 11, startTicks: '111', ...Object.fromEntries(['oid','serverBuildId','clientBuildId','nodeBinarySha256',
        'clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256','mode'].map(key => [key, previous[key]])) };
    const final = { ...initial, pid: 12, startTicks: '222' }, effects = { stopRequests: 0, exchangeRequests: 0, startRequests: 0, databaseRestores: 0 };
    const observations = {
        loaded_identity: { loadedArtifactLinkageSha256: previous.serverInputManifestSha256, healthServerBuildId: previous.serverBuildId,
            healthClientBuildId: previous.clientBuildId, processExecutableSha256: previous.nodeBinarySha256 },
        admission_exclusion: { existingWriterCount: 1, outcome: 'deferred', newWriterStatus: 503, gateClosed: true, effects },
        old_stop: { method: 'stopProcessId', sameFdPeerPid: 10, expectedDaemonPid: 10, oldProcessDead: true,
            remainingWriterPids: [], firstExchangeAfterDeath: true },
        old_restart_under_gate: previousReturn(initial, final, database),
        candidate_start_unknown: { journalState: 'manual_recovery_required', databaseState: 'UNKNOWN', gateClosed: true,
            replayedRequests: 0, rollbackRequests: 0, databaseRestores: 0 },
        pid_and_peer_races: { refusals: ['stale-pid','wrong-peer'].map(reason => ({ reason, observedMismatch: 'synthetic mismatch', effects })) },
        evidence_negative: { refusals: ['mutated-tree','wrong-report','wrong-approval','wrong-closure','unlisted-exception','missing-evidence','false-loaded-identity']
            .map(reason => ({ reason, observedMismatch: 'synthetic mismatch', effects })) },
    };
    for (const [name, journalState] of Object.entries({ crash_after_stop: 'triple_old_stopped', crash_after_mode: 'bootstrap_mode_verified', crash_after_exchange: 'triple_exchanged' })) {
        observations[name] = { crashBoundary: name, journalState, recovery: previousReturn(initial, final, database) };
    }
    return Object.entries(observations).map(([name, observed]) => ({ schema: 'nassaj-bootstrap-observed-case/v1', name,
        ...bindings, initial, final: name === 'candidate_start_unknown' ? null : final, observations: observed }));
}

function writeSyntheticCases(cases, previous, { write, mutateCase, mutateJournal, mutateExecution }) {
    const files = [], caseRefs = [];
    for (const value of cases) {
        if (mutateCase) mutateCase(value);
        const states = { old_stop: 'triple_old_stopped', old_restart_under_gate: 'pair_rolled_back',
            crash_after_stop: 'triple_old_stopped', crash_after_mode: 'bootstrap_mode_verified',
            crash_after_exchange: 'triple_exchanged', candidate_start_unknown: 'manual_recovery_required' };
        const attempt = { transactionNonce: hash(value.name), actionId: '11111111-1111-1111-1111-111111111111' };
        const journal = states[value.name] ? { schema: 'nassaj-oid-control-transaction/v2', state: states[value.name], ...attempt,
            pair: { databaseState: value.name === 'candidate_start_unknown' ? 'UNKNOWN' : 'PRE_CANDIDATE',
                previous: { ...previous, runtime: { pid: value.initial.pid, startTime: value.initial.startTicks, oid: value.initial.oid,
                    serverBuildId: value.initial.serverBuildId, clientBuildId: value.initial.clientBuildId } } } }
            : { schema: 'nassaj-bootstrap-file-observation/v1', operation: 'lstat', errorCode: 'ENOENT' };
        if (mutateJournal) mutateJournal(journal, value.name);
        const journalFile = write(`${value.name}-journal.json`, journal), receiptFile = write(`${value.name}-receipt.json`, value.observations);
        const execution = { schema: 'nassaj-bootstrap-execution-observation/v1', case: value.name,
            command: [process.execPath, 'synthetic-harness.mjs', '--case', value.name],
            exitCode: value.name.startsWith('crash_after_') ? null : 0, signal: value.name.startsWith('crash_after_') ? 'SIGKILL' : null,
            injectedPhase: value.name };
        if (mutateExecution) mutateExecution(execution, value.name);
        const executionFile = write(`${value.name}-execution.json`, execution);
        files.push(journalFile, receiptFile, executionFile); value.injectedPhase = value.name; value.attempt = states[value.name] ? attempt : null;
        value.journalEvidence = { path: journalFile.path, sha256: journalFile.sha256 };
        value.receiptEvidence = { path: receiptFile.path, sha256: receiptFile.sha256 };
        value.executionEvidence = { path: executionFile.path, sha256: executionFile.sha256 };
        const name = `${value.name}.json`; files.push(write(name, value)); caseRefs.push({ name: value.name, evidencePath: name });
    }
    return { files, caseRefs };
}

/** Assemble test evidence under project artifacts; caller supplies the exact material its inspector will recompute. */
export function createSyntheticBootstrapQualification({ installation, previous, liveManifest, executorCodeClosureSha256,
    verifierClosureSha256, databasePath, mutateCase = null, mutateJournal = null, mutateExecution = null }) {
    if (!installation.root.startsWith(`${ARTIFACTS}/`) || fs.realpathSync(installation.root) !== installation.root) {
        throw new Error('synthetic_bootstrap_fixture_requires_project_artifact_root');
    }
    const directory = fs.mkdtempSync(path.join(installation.root, 'synthetic-qualification-'));
    const write = (name, value) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value));
        fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
        return { path: name, size: bytes.length, sha256: hash(bytes) };
    };
    const exceptions = liveManifest.runtimeDependenciesSha256 === previous.dependencyLegacyActualSha256 ? []
        : [{ kind: 'dependency-seal-mismatch', manifestSha256: previous.controlManifestSha256,
            expectedLegacySha256: liveManifest.runtimeDependenciesSha256, actualLegacySha256: previous.dependencyLegacyActualSha256 }];
    const previousMaterialSha256 = hash(canonical({ installation, previous, exceptions }));
    const bindings = { previousMaterialSha256, executorClosureSha256: executorCodeClosureSha256 };
    const data = fs.lstatSync(databasePath), database = { path: databasePath, dev: String(data.dev), ino: String(data.ino) };
    const { files, caseRefs } = writeSyntheticCases(observedCases(previous, bindings, database), previous,
        { write, mutateCase, mutateJournal, mutateExecution });
    const dataDirectory = path.dirname(databasePath), metadata = fs.lstatSync(dataDirectory);
    files.push(write('app-data-boundary.json', { schema: 'nassaj-bootstrap-appdata-boundary/v1', directory: dataDirectory,
        dev: String(metadata.dev), ino: String(metadata.ino), databasePath, purpose: 'exclusive-application-data' }));
    const harness = write('synthetic-harness.mjs', Buffer.from('// Synthetic fixture; this file performs no rehearsal.\n'));
    files.push(harness);
    const closure = write('harness-closure.json', { schema: 'nassaj-bootstrap-rehearsal-harness/v1', entrypoint: harness.path,
        files: [{ ...harness, mode: 0o600 }] }); files.push(closure);
    const index = write('evidence-index.json', { schema: 'nassaj-bootstrap-evidence-index/v1', files });
    const report = { schema: 'nassaj-bootstrap-rehearsal-report/v1', checkSet: 'actual-old-bootstrap-checks/v1', ...bindings,
        harnessClosureSha256: closure.sha256, verifierClosureSha256, evidenceIndexSha256: index.sha256, cases: caseRefs,
        appDataGuard: { evidencePath: 'app-data-boundary.json' } };
    const reportFile = write('report.json', report);
    const rehearsal = { schema: 'nassaj-bootstrap-previous-rehearsal/v1', ...bindings, reportSha256: reportFile.sha256,
        evidenceIndexSha256: index.sha256, harnessClosureSha256: closure.sha256, verifierClosureSha256 };
    const review = write('qa-review.json', { ...Object.fromEntries(Object.entries(rehearsal).filter(([key]) => key !== 'schema')),
        schema: 'nassaj-bootstrap-independent-review/v1', decision: 'accept', checkSet: report.checkSet,
        reviewer: { identity: 'synthetic-test-only', role: 'independent-qa' }, source: { harness: 'synthetic-test-only',
            conversationId: 'not-a-real-conversation', transcriptRef: 'fixture:synthetic-only', messageSha256: H } });
    const qualification = { schema: 'nassaj-bootstrap-previous-qualification/v1', installation, previous, exceptions,
        rehearsal, review: { receiptSha256: review.sha256 } };
    const qualificationFile = write('qualification.json', qualification);
    return { qualificationReference: { directory, sha256: qualificationFile.sha256 }, qualification, report, database };
}
