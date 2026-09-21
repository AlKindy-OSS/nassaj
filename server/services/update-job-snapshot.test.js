import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveUpdateJobFailure, normalizeManifestDrift, sanitizeUpdateJobMessage } from './update-job-snapshot.js';

const receiptsDb = (rows) => ({ listReceipts: () => rows });
const receipt = (phase, kind, facts) => ({ phase, kind, facts_json: JSON.stringify(facts) });

test('sanitizer collapses absolute filesystem paths to their basename (T-1750)', () => {
    const out = sanitizeUpdateJobMessage('A local change inside /home/operator/Project/nassaj-dev/server/index.js is refused');
    assert.equal(out, 'A local change inside index.js is refused');
    assert.ok(!out.includes('/home/operator'));
});

test('sanitizer strips credentials embedded in a URL (T-1750)', () => {
    const out = sanitizeUpdateJobMessage('git fetch failed for https://octocat:ghp_secretTokenValue@github.com/owner/repo.git');
    assert.ok(!out.includes('ghp_secretTokenValue'));
    assert.ok(!out.includes('octocat:'));
    assert.ok(out.includes('github.com') || out.includes('repo.git'));
});

test('sanitizer redacts token-like assignments and caps at 300 chars (T-1750)', () => {
    assert.equal(sanitizeUpdateJobMessage('boom token=abcdef123456 done'), 'boom token=… done');
    assert.equal(sanitizeUpdateJobMessage('{"api_key": "sk-live-999"}'), '{"api_key": "…');
    const long = 'x'.repeat(400);
    const capped = sanitizeUpdateJobMessage(long);
    assert.equal(capped.length, 300);
    assert.ok(capped.endsWith('…'));
    assert.equal(sanitizeUpdateJobMessage(''), null);
    assert.equal(sanitizeUpdateJobMessage(undefined), null);
});

test('non-failure states derive no failure fields (T-1750)', () => {
    const out = deriveUpdateJobFailure({ id: 'j1', state: 'staging' }, receiptsDb([]));
    assert.deepEqual(out, { failedPhase: null, errorCode: null, message: null, manifestDrift: null });
});

test('failed staging job exposes flat failedPhase/errorCode/message (T-1750)', () => {
    const job = {
        id: 'j2', state: 'failed', error_code: 'dirty_worktree',
        error_message: 'A local change inside /home/operator/Project/nassaj-dev/server/index.js is refused',
    };
    const out = deriveUpdateJobFailure(job, receiptsDb([
        receipt('resolving', 'intent', {}),
        receipt('staging', 'rollback', { code: 'dirty_worktree' }),
    ]));
    assert.equal(out.failedPhase, 'staging');
    assert.equal(out.errorCode, 'dirty_worktree');
    assert.equal(out.message, 'A local change inside index.js is refused');
});

test('activation rollback snapshot is non-null from the receipt when the row has no code (T-1750, critical-2)', () => {
    // transitionActivation writes no error_code; the code lives only in the receipt.
    const job = { id: 'j3', state: 'rolled_back', error_code: null, error_message: null };
    const out = deriveUpdateJobFailure(job, receiptsDb([
        receipt('runtime_verifying', 'rollback', { code: 'runtime_verification_failed', failedPhase: 'runtime_verifying' }),
    ]));
    assert.equal(out.failedPhase, 'runtime_verifying');
    assert.equal(out.errorCode, 'runtime_verification_failed');
});

test('manual_recovery_required takes the code of the last recovery receipt (T-1750)', () => {
    const job = { id: 'j4', state: 'manual_recovery_required', error_code: null, error_message: null };
    const out = deriveUpdateJobFailure(job, receiptsDb([
        receipt('activating', 'rollback', { code: 'candidate_manifest_invalid', failedPhase: 'activating' }),
        receipt('activating', 'recovery', { code: 'artifact_activation_recovery_failed', failedPhase: 'activating' }),
    ]));
    assert.equal(out.failedPhase, 'activating');
    assert.equal(out.errorCode, 'artifact_activation_recovery_failed');
});

test('rollback_pending derives failedPhase even before the terminal transition (T-1750)', () => {
    const job = { id: 'j5', state: 'rollback_pending', error_code: null, error_message: null };
    const out = deriveUpdateJobFailure(job, receiptsDb([
        receipt('activating', 'rollback', { code: 'update_database_state_unknown', failedPhase: 'activating' }),
    ]));
    assert.equal(out.failedPhase, 'activating');
    assert.equal(out.errorCode, 'update_database_state_unknown');
});

test('a raw activation message recorded as code is demoted to a sanitized message (T-1750)', () => {
    const job = { id: 'j1', state: 'rolled_back' };
    const out = deriveUpdateJobFailure(job, receiptsDb([
        receipt('activating', 'rollback', { code: 'ENOENT: no such file /home/operator/app/x.js', failedPhase: 'activating' }),
    ]));
    assert.equal(out.errorCode, 'unknown');
    assert.equal(out.failedPhase, 'activating');
    assert.ok(!out.message.includes('/home/operator'));
});

/**
 * T-1804 — لماذا صار التفصيل بنيوياً.
 *
 * المسارات كانت تُذكر داخل `message`، والمنظّفُ يطوي كل `a/b/c` إلى `c`:
 * `uqud-t7k9/lifetrip/brand/logo.svg` كانت تصل المشغّل باسم `logo.svg` —
 * ملفٌّ بهذا الاسم قد لا يكون في مكانٍ واحد. الاختبار يمرّ على المنظّف نفسه
 * وعلى اللقطة الفعلية، لا على الرسالة الخام.
 */
const DRIFT = {
    unexpected: { total: 2, sample: ['lifetrip/brand/logo.svg', 'lifetrip/index.html'] },
    missing: { total: 0, sample: [] },
    changed: { total: 0, sample: [] },
    recoveryCommandAvailable: true,
};

test('the sanitizer would still have destroyed a path inside the message (T-1804)', () => {
    const folded = sanitizeUpdateJobMessage('client_asset_manifest_changed: e.g. lifetrip/brand/logo.svg');
    assert.ok(!folded.includes('lifetrip/brand/logo.svg'), 'الطيّ قائم، فالقناة النصّية ليست خياراً');
});

test('the drift list reaches the snapshot through the receipt facts, unfolded (T-1804)', () => {
    const rows = [receipt('candidate_sealed', 'rollback', { code: 'client_asset_manifest_changed', manifestDrift: DRIFT })];
    const failure = deriveUpdateJobFailure({ id: 'j1', state: 'failed' }, receiptsDb(rows));
    assert.equal(failure.errorCode, 'client_asset_manifest_changed');
    assert.deepEqual(failure.manifestDrift.unexpected.sample, DRIFT.unexpected.sample);
    assert.equal(typeof failure.manifestDrift.recoveryCommandAvailable, 'boolean');
});

test('a non-failure job carries no drift, and a driftless failure carries null (T-1804)', () => {
    assert.equal(deriveUpdateJobFailure({ id: 'j1', state: 'staging' }, receiptsDb([])).manifestDrift, null);
    const rows = [receipt('candidate_sealed', 'rollback', { code: 'boom' })];
    assert.equal(deriveUpdateJobFailure({ id: 'j1', state: 'failed' }, receiptsDb(rows)).manifestDrift, null);
});

test('the drift validator refuses anything that is not a bounded dist-relative list (T-1804)', () => {
    assert.equal(normalizeManifestDrift(null), null);
    assert.equal(normalizeManifestDrift({ unexpected: { total: 1, sample: [] } }), null, 'مجموعة ناقصة');
    assert.equal(normalizeManifestDrift({ ...DRIFT, unexpected: { total: -1, sample: [] } }), null);
    assert.equal(normalizeManifestDrift({ ...DRIFT, unexpected: { total: 0, sample: [] } }), null, 'لا انجراف = لا حقل');
    // مسارٌ مطلق أو تسلّقٌ أو تسريبُ سرٍّ: يُسقَط من العيّنة ولا يُعرض أبداً.
    const hostile = normalizeManifestDrift({
        ...DRIFT,
        unexpected: { total: 4, sample: ['/etc/passwd', '../../secret', 'a\\b', 'ok/file.js'] },
    });
    assert.deepEqual(hostile.unexpected.sample, ['ok/file.js']);
    assert.equal(hostile.unexpected.total, 4, 'العدد الحقيقي يبقى وإن قُصّت العيّنة');
    // سقف العيّنة يُفرض على القارئ لا على الكاتب وحده.
    const flood = normalizeManifestDrift({
        ...DRIFT, unexpected: { total: 99, sample: Array.from({ length: 50 }, (_, i) => `f${i}.js`) },
    });
    assert.equal(flood.unexpected.sample.length, 20);
    // The flag is decided by THIS host at read time, never trusted from the
    // producer (which is inlined into the OID capsule and cannot locate itself).
    const absent = { publisherInstalled: () => false };
    const present = { publisherInstalled: () => true };
    assert.equal(normalizeManifestDrift(DRIFT, absent).recoveryCommandAvailable, false);
    assert.equal(normalizeManifestDrift({ ...DRIFT, recoveryCommandAvailable: false }, present).recoveryCommandAvailable, true);
});
