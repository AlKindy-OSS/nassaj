/**
 * T-2004: the open-world contract of `activation-action.json`. Readers ignore
 * unknown keys and accept a newer minor, refuse a newer major by name, and the
 * current writer's output still passes the frozen 2.3.1.3 reader
 * (source-update-action-schema.v2.3.1.3.fixture.mjs, a verbatim
 * `git show v2.3.1.3:scripts/lib/source-update-action-schema.mjs`; 2.3.1.2 is
 * byte-identical).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertSourceUpdateAction, buildSourceUpdateAction, checkSourceUpdateAction, isSourceUpdateActionShape,
    parseSourceUpdateActionSchema, SOURCE_UPDATE_ACTION_REQUIRED_KEYS, SOURCE_UPDATE_ACTION_SCHEMA,
} from './source-update-action-schema.mjs';
import * as frozen2313 from './source-update-action-schema.v2.3.1.3.fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ARGS = Object.freeze({
    transactionId: 'update-contract-1', originalHead: 'a'.repeat(40), targetCommit: 'c'.repeat(40), version: '2.3.1.4',
    manifestPath: '/srv/app/.git/nassaj-source-update/candidates/update-contract-1/candidate-manifest.json',
    manifestSha256: 'd'.repeat(64), expectedServerBuildId: 'b'.repeat(64),
});

test('an unknown extra key is accepted and reported, not a rejection cause', () => {
    const action = { ...buildSourceUpdateAction(ARGS), futureField: { nested: true }, another: 1 };
    const result = checkSourceUpdateAction(action);
    assert.equal(result.ok, true);
    assert.deepEqual(result.unknownKeys, ['futureField', 'another']);
    assert.equal(isSourceUpdateActionShape(action), true);
});

test('every missing required key is rejected', () => {
    for (const key of SOURCE_UPDATE_ACTION_REQUIRED_KEYS) {
        const { [key]: _dropped, ...rest } = buildSourceUpdateAction(ARGS);
        assert.deepEqual(checkSourceUpdateAction(rest), { ok: false, code: 'source_update_action_invalid' }, key);
    }
});

test('a malformed required or known optional key is rejected', () => {
    const base = buildSourceUpdateAction(ARGS);
    for (const patch of [{ originalHead: 'A'.repeat(40) }, { manifestSha256: 7 }, { transactionId: '../x' },
        { version: 2 }, { previousRuntimeOid: 'not-a-commit' }, { previousRuntimeOid: null }]) {
        assert.equal(isSourceUpdateActionShape({ ...base, ...patch }), false, JSON.stringify(patch));
    }
    for (const value of [null, [], 'x', 1]) assert.equal(isSourceUpdateActionShape(value), false);
});

test('a future minor of the supported major is accepted', () => {
    for (const schema of ['nassaj-source-update-activation/v1.0', 'nassaj-source-update-activation/v1.7']) {
        const result = checkSourceUpdateAction({ ...buildSourceUpdateAction(ARGS), schema, addedInMinor: 'x' });
        assert.equal(result.ok, true, schema);
        assert.equal(result.version.major, 1);
    }
});

test('a future major is refused with the clear unsupported code', () => {
    const action = { ...buildSourceUpdateAction(ARGS), schema: 'nassaj-source-update-activation/v2' };
    assert.deepEqual(checkSourceUpdateAction(action), { ok: false, code: 'source_update_action_schema_unsupported' });
    // Even when the reader's own refusal code differs, a newer major keeps its name.
    assert.throws(() => assertSourceUpdateAction(action, 'update_recovery_action_mismatch'),
        /^Error: source_update_action_schema_unsupported$/);
    assert.throws(() => assertSourceUpdateAction({ ...action, schema: 'nassaj-source-update-activation/v3.1' }),
        /source_update_action_schema_unsupported/);
});

test('an older major, a foreign family or a malformed id is invalid, not unsupported', () => {
    for (const schema of ['nassaj-source-update-activation/v0', 'other-family/v1', 'nassaj-source-update-activation/v01',
        'nassaj-source-update-activation/v1.', 'nassaj-source-update-activation/1', undefined, 1]) {
        const action = { ...buildSourceUpdateAction(ARGS), schema };
        assert.deepEqual(checkSourceUpdateAction(action), { ok: false, code: 'source_update_action_invalid' }, String(schema));
        assert.throws(() => assertSourceUpdateAction(action, 'reader_specific_invalid'), /reader_specific_invalid/);
    }
});

test('schema ids parse to major and minor', () => {
    assert.deepEqual(parseSourceUpdateActionSchema('nassaj-source-update-activation/v1'), { major: 1, minor: 0 });
    assert.deepEqual(parseSourceUpdateActionSchema('nassaj-source-update-activation/v2.3'), { major: 2, minor: 3 });
    assert.equal(parseSourceUpdateActionSchema('nassaj-source-update-activation/v1-beta'), null);
});

test('cross-version: the current writer output passes the frozen 2.3.1.3 reader', () => {
    // 2.3.1.3 compares the id by equality and rejects unknown keys, so the
    // writer stays at the bare v1 id and the nine keys it already accepts.
    assert.equal(SOURCE_UPDATE_ACTION_SCHEMA, frozen2313.SOURCE_UPDATE_ACTION_SCHEMA);
    for (const previousRuntimeOid of [null, 'e'.repeat(40)]) {
        const written = JSON.parse(`${JSON.stringify(buildSourceUpdateAction({ ...ARGS, previousRuntimeOid }))}\n`);
        assert.equal(frozen2313.isSourceUpdateActionShape(written), true, String(previousRuntimeOid));
        // 2.3.1.3's bootstrap and stale-rollback readers check the id literally.
        assert.equal(written.schema, 'nassaj-source-update-activation/v1');
    }
});

test('cross-version: what 2.3.1.3 writes passes the current reader', () => {
    for (const previousRuntimeOid of [null, 'e'.repeat(40)]) {
        assert.equal(isSourceUpdateActionShape(frozen2313.buildSourceUpdateAction({ ...ARGS, previousRuntimeOid })), true);
    }
});

test('the frozen 2.3.1.3 reader is a verbatim copy of the tagged file', (t) => {
    const shown = spawnSync('git', ['show', 'v2.3.1.3:scripts/lib/source-update-action-schema.mjs'],
        { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (shown.status !== 0) { t.skip('tag v2.3.1.3 is not available in this clone'); return; }
    assert.equal(readFileSync(path.join(here, 'source-update-action-schema.v2.3.1.3.fixture.mjs'), 'utf8'), shown.stdout);
});
