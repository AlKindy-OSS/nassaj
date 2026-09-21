import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { PERMISSION_EXECUTION_SCHEMA_SQL, migratePermissionExecution } from '../server/modules/database/permission-execution.migration.ts';
import { discoverScopedFences, findOrphanCandidates, liftFence, listFences, parseArguments } from './permission-fence.mjs';

function setup(t) {
    const directory = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP || os.tmpdir(), 'fence-'));
    const file = path.join(directory, 'auth.db');
    const database = new Database(file);
    database.exec(PERMISSION_EXECUTION_SCHEMA_SQL);
    t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    seed(database, 'd1');
    database.prepare('INSERT INTO permission_generation_blocks VALUES (?, ?, ?, ?, ?)')
        .run(1, 'RECONCILED_EFFECT_UNKNOWN', 'd1', 'effect:d1', 100);
    return { database, file, auditFile: `${file}.fence-lifts.jsonl` };
}

function seed(database, id, purpose = 'spawn', generation = 1) {
    database.prepare(`INSERT INTO permission_launch_decisions
      (decision_id,user_id,principal_id,authentication_kind,authorization_generation,launch_id,
       project_id,workspace_digest,provider,body,engine,entrypoint,purpose,requested_profile,
       contract_version,profile_digest,capability_digest,release_build,protocol_generation,
       verdict,state,terminal_outcome,created_at_ms,updated_at_ms)
      VALUES (?,1,'user:1','session',1,?,'project','1234567890123456','codex','codex','sdk',
       'ws.chat',?,'full','v1','profile','capability','build',?,'authorized','terminal','reconciled_unknown',1,1)`)
        .run(id, id, purpose, generation);
    database.prepare(`INSERT INTO permission_admission_leases
      (lease_id,decision_id,purpose,protocol_generation,owner_id,owner_pid,owner_boot_id,
       owner_start_ticks,effect_identity,status,expires_at_ms,claimed_at_ms,terminal_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?, 'owner',123,'old-boot','42',?,'terminal',20,10,30,1,30)`)
        .run(`lease:${id}`, id, purpose, generation, `effect:${id}`);
}
const options = { generation: 1, reason: 'Operator accepts unresolved external outcome', forceExternal: true, actor: 'operator' };
const records = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const fenced = database => assert.equal(listFences(database).length, 1);

test('argument parsing requires positive generation and nonblank printable reason', () => {
    assert.deepEqual(parseArguments(['list']), { command: 'list' });
    assert.equal(parseArguments(['lift', '--generation', '1', '--reason', 'accepted', '--force-external']).forceExternal, true);
    for (const argv of [['lift'], ['drop'], ['lift', '--generation', '0', '--reason', 'x'],
        ['lift', '--generation', '1', '--reason', ' '], ['lift', '--generation', '1', '--reason', 'bad\tvalue']]) {
        assert.throws(() => parseArguments(argv));
    }
});

test('generation-wide unknown decisions are preserved and every identity audited before deletion', t => {
    const { database, auditFile } = setup(t);
    seed(database, 'd2', 'external_agent_dispatch');
    const before = database.prepare('SELECT * FROM permission_launch_decisions ORDER BY decision_id').all();
    assert.throws(() => liftFence(database, { ...options, forceExternal: false }), /another system/);
    fenced(database);
    const result = liftFence(database, options);
    assert.equal(result.databaseCommitted, true);
    assert.equal(result.completionAuditRecorded, true);
    const [intent, completion] = records(auditFile);
    assert.equal(intent.event, 'lift_intent');
    assert.deepEqual(intent.snapshot.decisions.map(d => d.decision_id), ['d1', 'd2']);
    assert.deepEqual(intent.snapshot.leases.map(l => l.effect_identity), ['effect:d1', 'effect:d2']);
    assert.equal(intent.actor, options.actor);
    assert.equal(intent.reason, options.reason);
    assert.equal(intent.acknowledgementIsProof, false);
    assert.equal(completion.event, 'lift_committed');
    assert.equal(completion.operationId, intent.operationId);
    assert.deepEqual(database.prepare('SELECT * FROM permission_launch_decisions ORDER BY decision_id').all(), before);
    assert.equal(listFences(database).length, 0);
});

for (const purpose of ['spawn', 'sdk_turn', 'catalog', 'external_agent_dispatch', 'future-unknown']) {
    test(`every purpose requires explicit external acknowledgement: ${purpose}`, t => {
        const { database } = setup(t);
        database.pragma('ignore_check_constraints = ON');
        database.prepare('UPDATE permission_launch_decisions SET purpose = ?').run(purpose);
        assert.throws(() => liftFence(database, { ...options, forceExternal: false }), /force-external/);
        fenced(database);
    });
}

test('orphaned, mismatched and missing linkage remains in snapshot as uncertainty', t => {
    const { database, auditFile } = setup(t);
    seed(database, 'd2', 'catalog', 2);
    database.prepare("UPDATE permission_admission_leases SET protocol_generation = 1 WHERE decision_id = 'd2'").run();
    database.pragma('foreign_keys = OFF'); // Deliberately damaged fixture, isolated test data only.
    database.prepare("DELETE FROM permission_launch_decisions WHERE decision_id = 'd1'").run();
    assert.throws(() => liftFence(database, { ...options, forceExternal: false }), /force-external/);
    liftFence(database, options);
    const snapshot = records(auditFile)[0].snapshot;
    assert.deepEqual(snapshot.decisions.map(d => d.decision_id), ['d2']);
    assert.equal(snapshot.leases.length, 2);
    assert.ok(snapshot.uncertainty.includes('block_decision_missing'));
    assert.ok(snapshot.uncertainty.includes('lease_decision_missing:lease:d1'));
    assert.ok(snapshot.uncertainty.includes('decision_generation_mismatch:d2'));
});

for (const claimOnly of [false, true]) {
    test(`open evidence requires force independently (claim only ${claimOnly})`, t => {
        const { database } = setup(t);
        seed(database, 'd2');
        if (claimOnly) database.exec("UPDATE permission_launch_decisions SET state='effect_claimed', terminal_outcome=NULL WHERE decision_id='d2'");
        else database.exec("UPDATE permission_admission_leases SET status='active', terminal_at_ms=NULL WHERE decision_id='d2'");
        assert.throws(() => liftFence(database, options), /open leases or claims/);
        assert.throws(() => liftFence(database, { ...options, force: true, forceExternal: false }), /force-external/);
        fenced(database);
        assert.equal(liftFence(database, { ...options, force: true }).databaseCommitted, true);
    });
}

test('direct API rejects empty reason and nested transaction', t => {
    const { database } = setup(t);
    assert.throws(() => liftFence(database, { ...options, reason: ' ' }), /invalid lift/);
    assert.throws(() => database.transaction(() => liftFence(database, options)).immediate(), /own immediate/);
    fenced(database);
});

for (const method of ['openSync', 'writeSync', 'fsyncSync']) {
    test(`audit ${method} failure leaves fence untouched`, t => {
        const { database } = setup(t);
        t.mock.method(fs, method, () => { throw new Error('audit injected failure'); });
        assert.throws(() => liftFence(database, options), /audit injected failure/);
        fenced(database);
        t.mock.restoreAll();
    });
}

test('directory fsync failure retains fence', t => {
    const { database } = setup(t);
    const original = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('directory sync failed'); original(fd); });
    assert.throws(() => liftFence(database, options), /directory sync failed/);
    fenced(database);
});

test('audit rejects symlink, hardlink, permissive mode and nonregular file', t => {
    const { database, auditFile, file } = setup(t);
    fs.symlinkSync(file, auditFile);
    assert.throws(() => liftFence(database, options));
    fs.unlinkSync(auditFile);
    fs.linkSync(file, auditFile);
    assert.throws(() => liftFence(database, options), /one link/);
    fs.unlinkSync(auditFile);
    fs.writeFileSync(auditFile, '', { mode: 0o644 });
    assert.throws(() => liftFence(database, options), /0600/);
    fs.unlinkSync(auditFile);
    fs.mkdirSync(auditFile);
    assert.throws(() => liftFence(database, options));
    fenced(database);
});

test('short writes are completed; delete failure leaves intent only', t => {
    const { database, auditFile } = setup(t);
    const original = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd, data, offset, length) => original(fd, data, offset, Math.min(length, 19)));
    database.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON permission_generation_blocks BEGIN SELECT RAISE(ABORT,'delete rejected'); END");
    assert.throws(() => liftFence(database, options), /delete rejected/);
    fenced(database);
    assert.deepEqual(records(auditFile).map(r => r.event), ['lift_intent']);
});

test('completion failure reports committed database truth without repeating deletion', t => {
    const { database, auditFile } = setup(t);
    const original = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {
        if (data.toString().includes('lift_committed')) throw new Error('completion failed');
        return original(fd, data, ...rest);
    });
    const result = liftFence(database, options);
    assert.equal(result.databaseCommitted, true);
    assert.equal(result.completionAuditRecorded, false);
    assert.equal(result.error, 'AUDIT_COMPLETION_FAILED_AFTER_DATABASE_COMMIT');
    assert.equal(listFences(database).length, 0);
    assert.deepEqual(records(auditFile).map(r => r.event), ['lift_intent']);
});

test('concurrent writer cannot enter between snapshot and DELETE', t => {
    const { database, file } = setup(t);
    const other = new Database(file, { timeout: 0 });
    t.after(() => other.close());
    const original = fs.writeSync;
    let attempts = 0;
    t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {
        if (data.toString().includes('lift_intent')) {
            attempts += 1;
            assert.throws(() => other.prepare('UPDATE permission_admission_leases SET revision=revision+1').run(), /locked/);
        }
        return original(fd, data, ...rest);
    });
    liftFence(database, options);
    assert.equal(attempts, 1);
});

test('row and byte limits fail closed', t => {
    const { database } = setup(t);
    database.prepare('UPDATE permission_admission_leases SET owner_id = ?').run('x'.repeat(1024 * 1024));
    assert.throws(() => liftFence(database, options), /audit limits/);
    database.prepare("UPDATE permission_admission_leases SET owner_id = 'owner'").run();
    database.transaction(() => { for (let i = 2; i <= 1001; i++) seed(database, `d${i}`); })();
    assert.throws(() => liftFence(database, options), /audit limits/);
    fenced(database);
});

test('findOrphanCandidates is diagnostic only', () => {
    const ps = 'PID PPID ELAPSED COMMAND\n123 1 01:00:00 claude\n124 2 01:00:00 codex\n125 1 00:01:00 bash';
    assert.deepEqual(findOrphanCandidates(ps).map(row => row.pid), [123]);
});

function scopedSetup(t, scopeKind = 'session') {
    const fixture = setup(t);
    migratePermissionExecution(fixture.database);
    fixture.database.prepare("UPDATE permission_launch_decisions SET session_id = 'session-one' WHERE decision_id = 'd1'").run();
    const scopeKey = scopeKind === 'session' ? 'session-one' : '1:codex:spawn';
    fixture.database.prepare(`INSERT INTO permission_effect_fences
        (scope_kind, scope_key, protocol_generation, decision_id, reason_code, created_at_ms)
        VALUES (?, ?, 1, 'd1', 'RECONCILED_EFFECT_UNKNOWN', 100)`).run(scopeKind, scopeKey);
    return { ...fixture, selector: { scopeKind, scopeKey }, lift: { ...options, generation: undefined, scopeKind, scopeKey } };
}

test('scope selectors require a complete exclusive printable pair, including direct API', t => {
    assert.equal(parseArguments(['list', '--scope-kind', 'session', '--scope-key', 'abc']).scopeKey, 'abc');
    for (const args of [ ['--scope-kind', 'session'], ['--scope-key', 'x'],
        ['--scope-kind', 'other', '--scope-key', 'x'], ['--scope-kind', 'session', '--scope-key', 'x\n'],
        ['--scope-kind', 'session', '--scope-key', 'x', '--generation', '1'],
        ['--generation', '1', '--generation', '2'], ['--generation', '1', '--force'] ]) {
        assert.throws(() => parseArguments(['list', ...args]));
    }
    const { database, lift } = scopedSetup(t);
    assert.throws(() => liftFence(database, { ...lift, generation: 1 }), /selector/);
    assert.throws(() => liftFence(database, { ...lift, scopeKey: '' }), /selector/);
});

for (const kind of ['session', 'user_provider_purpose']) {
    test(`scoped ${kind} lift audits exact unresolved scope across generations and preserves other fences`, t => {
        const { database, auditFile, selector, lift } = scopedSetup(t, kind);
        seed(database, 'd2', 'spawn', 2);
        seed(database, 'outside', 'catalog');
        seed(database, 'settled');
        database.exec("UPDATE permission_launch_decisions SET session_id='session-one' WHERE decision_id IN ('d2','settled'); UPDATE permission_launch_decisions SET terminal_outcome='succeeded' WHERE decision_id='settled'");
        database.prepare(`INSERT INTO permission_effect_fences VALUES ('session','other',1,'outside','RECONCILED_EFFECT_UNKNOWN',101)`).run();
        const before = database.prepare('SELECT * FROM permission_launch_decisions ORDER BY decision_id').all();
        assert.equal(listFences(database, selector).length, 1);
        assert.throws(() => liftFence(database, { ...lift, forceExternal: false }), /force-external/);
        assert.equal(liftFence(database, lift).databaseCommitted, true);
        const [intent, done] = records(auditFile);
        assert.deepEqual(intent.snapshot.decisions.map(d => d.decision_id), ['d1', 'd2']);
        assert.deepEqual(intent.snapshot.leases.map(l => l.decision_id), ['d1', 'd2']);
        assert.equal(done.scopeKind, kind);
        assert.equal(done.scopeKey, selector.scopeKey);
        assert.deepEqual(database.prepare('SELECT * FROM permission_launch_decisions ORDER BY decision_id').all(), before);
        assert.equal(listFences(database, selector).length, 0);
        assert.equal(listFences(database).length, 1);
        assert.equal(database.prepare('SELECT COUNT(*) n FROM permission_effect_fences').get().n, 1);
    });
}

for (const method of ['openSync', 'writeSync', 'fsyncSync']) {
    test(`scoped audit ${method} failure retains fence`, t => {
        const { database, selector, lift } = scopedSetup(t);
        t.mock.method(fs, method, () => { throw Error('scoped audit failure'); });
        assert.throws(() => liftFence(database, lift), /scoped audit failure/);
        assert.equal(listFences(database, selector).length, 1);
    });
}

test('scoped open claim and audit failure never remove original evidence', t => {
    const { database, selector, lift } = scopedSetup(t);
    database.exec("UPDATE permission_launch_decisions SET state='effect_claimed', terminal_outcome=NULL WHERE decision_id='d1'");
    assert.throws(() => liftFence(database, lift), /open leases/);
    assert.equal(listFences(database, selector).length, 1);
    assert.equal(liftFence(database, { ...lift, force: true }).databaseCommitted, true);
});

test('scoped delete failure records only durable intent and rolls back; concurrent writers cannot enter', t => {
    const { database, file, auditFile, selector, lift } = scopedSetup(t);
    const other = new Database(file, { timeout: 0 });
    t.after(() => other.close());
    const write = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {
        if (data.toString().includes('lift_intent')) assert.throws(() => other.prepare("UPDATE permission_effect_fences SET created_at_ms=102").run(), /locked/);
        return write(fd, data, ...rest);
    });
    database.exec("CREATE TRIGGER refuse_scoped_delete BEFORE DELETE ON permission_effect_fences BEGIN SELECT RAISE(ABORT,'scoped delete rejected'); END");
    assert.throws(() => liftFence(database, lift), /scoped delete rejected/);
    assert.equal(listFences(database, selector).length, 1);
    assert.deepEqual(records(auditFile).map(r => r.event), ['lift_intent']);
});

test('scoped completion failure reports committed truth without retrying', t => {
    const { database, auditFile, selector, lift } = scopedSetup(t);
    const write = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {
        if (data.toString().includes('lift_committed')) throw Error('completion failed');
        return write(fd, data, ...rest);
    });
    assert.equal(liftFence(database, lift).completionAuditRecorded, false);
    assert.equal(listFences(database, selector).length, 0);
    assert.deepEqual(records(auditFile).map(r => r.event), ['lift_intent']);
});

test('scoped bounded snapshots reject oversized evidence before deletion', t => {
    const { database, selector, lift } = scopedSetup(t);
    database.prepare('UPDATE permission_admission_leases SET owner_id=?').run('x'.repeat(1024 * 1024));
    assert.throws(() => liftFence(database, lift), /audit limits/);
    assert.equal(listFences(database, selector).length, 1);
});

test('scope values are bound literally and a missing scoped schema fails explicitly', t => {
    const { database, selector, lift } = scopedSetup(t);
    const unusualKey = "scope' OR 1=1 --";
    assert.deepEqual(listFences(database, { ...selector, scopeKey: unusualKey }), []);
    assert.throws(() => liftFence(database, { ...lift, scopeKey: unusualKey }), /exact scope/);
    assert.equal(listFences(database, selector).length, 1);
    database.exec('DROP TABLE permission_effect_fences');
    assert.throws(() => listFences(database, selector), /no such table/);
});

test('scope row limit fails closed but unrelated unresolved rows do not exhaust it', t => {
    const { database, selector, lift } = scopedSetup(t);
    database.transaction(() => { for (let i = 0; i < 1001; i++) seed(database, `other${i}`, 'catalog'); })();
    assert.equal(listFences(database, selector).length, 1);
    database.exec("UPDATE permission_launch_decisions SET session_id='session-one'");
    assert.throws(() => liftFence(database, lift), /audit limits/);
    assert.equal(listFences(database, selector).length, 1);
});

test('scope discovery distinguishes legacy schema and empty state and bounds the visible list', t => {
    const { database, selector } = scopedSetup(t);
    assert.equal(discoverScopedFences(database).scopedFences[0].scopeKey, selector.scopeKey);
    database.prepare('DELETE FROM permission_effect_fences').run();
    assert.deepEqual(discoverScopedFences(database), { scopedFences: [], scopedFencesAvailable: true, scopedFencesTruncated: false });
    const insert = database.prepare("INSERT INTO permission_effect_fences VALUES ('session',?,1,'d1','RECONCILED_EFFECT_UNKNOWN',100)");
    database.transaction(() => { for (let i = 0; i <= 1000; i++) insert.run(`scope${i}`); })();
    assert.equal(discoverScopedFences(database).scopedFences.length, 1000);
    assert.equal(discoverScopedFences(database).scopedFencesTruncated, true);
    database.exec('DROP TABLE permission_effect_fences');
    assert.deepEqual(discoverScopedFences(database), { scopedFences: [], scopedFencesAvailable: false, scopedFencesTruncated: false });
    database.exec('CREATE TABLE permission_effect_fences (broken TEXT)');
    assert.throws(() => discoverScopedFences(database), /no such column/);
});
