import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateCompatibleForwardPermissionReceipt } from './compatible-forward-permission-receipt.migration.js';

// Independent contract oracle, transcribed from reviewed candidate 10caa51f / B952 ADR.
// Do not import migration SQL or change the immutable predecessor fixture.
const oracle = [
  'ALTER TABLE pending_server_actions ADD COLUMN execution_attempt_nonce TEXT',
  `ALTER TABLE permission_admission_leases ADD COLUMN effect_footprint TEXT NOT NULL
        DEFAULT 'external' CHECK (effect_footprint IN ('local', 'external'))`,
  'ALTER TABLE permission_admission_leases ADD COLUMN effect_child_pid INTEGER',
  'ALTER TABLE permission_admission_leases ADD COLUMN effect_child_boot_id TEXT',
  'ALTER TABLE permission_admission_leases ADD COLUMN effect_child_start_ticks TEXT',
  'ALTER TABLE message_coordination_ingress ADD COLUMN accepted_at TEXT',
  `CREATE TABLE permission_effect_fences (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'user_provider_purpose')),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 512),
  protocol_generation INTEGER NOT NULL CHECK (protocol_generation > 0),
  decision_id TEXT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_key),
  FOREIGN KEY (decision_id) REFERENCES permission_launch_decisions(decision_id)
    ON DELETE RESTRICT
)`,
];
const fixtureBytes = readFileSync(new URL('../../scripts/fixtures/compatible-forward-schema-v1.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString()) as { objects: { type: string; name: string; sql: string }[]; markers: { key: string; present: boolean }[] };

function baseline(): Database.Database {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '0bb67fea8559d5413d5c4944352a003c73439684a4d8df15f9ab42c911760960');
  assert.equal(fixture.objects.length, 349);
  const db = new Database(':memory:');
  for (const type of ['table', 'index', 'view', 'trigger']) {
    for (const object of fixture.objects.filter(item => item.type === type)) db.exec(object.sql);
  }
  for (const marker of fixture.markers.filter(item => item.present)) {
    db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run(marker.key, 'unchanged-marker');
  }
  db.prepare('INSERT INTO users(id,username,password_hash) VALUES (?,?,?)').run(91, 'fixture', 'fixture-only');
  db.prepare(`INSERT INTO permission_launch_decisions
    (decision_id,user_id,principal_id,authentication_kind,authorization_generation,launch_id,
    project_id,workspace_digest,provider,body,engine,entrypoint,purpose,requested_profile,
    contract_version,profile_digest,capability_digest,release_build,protocol_generation,verdict,
    state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('decision',91,'fixture','session',1,'launch','project','workspace-digest','codex','cli','fixture','fixture',
      'spawn','{}','v1','profile','capability','old-release',1,'authorized','authorized',1,1);
  db.prepare(`INSERT INTO permission_admission_leases
    (lease_id,decision_id,purpose,protocol_generation,owner_id,owner_pid,owner_boot_id,owner_start_ticks,
    effect_identity,status,expires_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('lease','decision','spawn',1,'owner',123,'old-boot','123','effect','issued',1,1,1);
  db.prepare('INSERT INTO permission_generation_blocks VALUES (?,?,?,?,?)')
    .run(1,'legacy-block','decision','old-effect',1);
  db.prepare(`INSERT INTO message_coordination_ingress
    (session_id,client_msg_id,user_id,provider,canonical_content,content_hash,request_fingerprint,coordination_level,created_at,lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run('session','client-message',91,'codex','old content','hash','fingerprint','delegate_review','2026-01-01','started');
  db.prepare('INSERT INTO pending_server_actions (id, action_type, reason) VALUES (?,?,?)').run('action','safe-restart','old reason');
  db.pragma('foreign_keys = ON');
  return db;
}

function schema(db: Database.Database) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}

function oldRows(db: Database.Database, columns?: Record<string, string[]>) {
  const tableColumns = columns ?? Object.fromEntries(fixture.objects.filter(item => item.type === 'table').map(item => [
    item.name, (db.pragma(`table_info("${item.name}")`) as { name: string }[]).map(column => column.name),
  ]));
  return { columns: tableColumns, rows: Object.fromEntries(Object.entries(tableColumns).map(([table, names]) => [
    table, db.prepare(`SELECT ${names.map(name => `"${name}"`).join(',')} FROM "${table}"`).all(),
  ])) };
}

function migrate(db: Database.Database) {
  db.exec('BEGIN IMMEDIATE');
  try { migrateCompatibleForwardPermissionReceipt(db); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('exact immutable predecessor gains only reviewed six columns and one table, preserving all old projections', () => {
  const db = baseline(), control = baseline();
  try {
    const before = oldRows(db);
    for (const sql of oracle) control.exec(sql);
    migrate(db);
    assert.equal(schema(db).length, 350);
    assert.deepEqual(schema(db), schema(control));
    for (const table of fixture.objects.filter(item => item.type === 'table').map(item => item.name).concat('permission_effect_fences')) {
      assert.deepEqual(db.pragma(`table_xinfo("${table}")`), control.pragma(`table_xinfo("${table}")`));
      assert.deepEqual(db.pragma(`foreign_key_list("${table}")`), control.pragma(`foreign_key_list("${table}")`));
    }
    assert.deepEqual(oldRows(db, before.columns), before);
    assert.deepEqual(db.prepare('SELECT effect_footprint,effect_child_pid,effect_child_boot_id,effect_child_start_ticks FROM permission_admission_leases').get(),
      { effect_footprint: 'external', effect_child_pid: null, effect_child_boot_id: null, effect_child_start_ticks: null });
    assert.deepEqual(db.prepare('SELECT accepted_at FROM message_coordination_ingress').get(), { accepted_at: null });
    assert.deepEqual(db.prepare('SELECT execution_attempt_nonce FROM pending_server_actions').get(), { execution_attempt_nonce: null });
    assert.deepEqual(db.prepare('SELECT * FROM permission_effect_fences').all(), []);
    assert.equal((db.pragma('table_info(message_coordination_ingress)') as { name: string }[]).some(c => c.name.startsWith('claude_')), false);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); control.close(); }
});

test('missing caller transaction rejects before any schema or row mutation', () => {
  const db = baseline();
  try {
    const before = { schema: schema(db), data: oldRows(db) };
    assert.throws(() => migrateCompatibleForwardPermissionReceipt(db), /compatible_forward_transaction_required/);
    assert.deepEqual({ schema: schema(db), data: oldRows(db) }, before);
  } finally { db.close(); }
});

for (let failAfter = 1; failAfter <= 7; failAfter += 1) {
  test(`caller rollback after DDL ${failAfter} restores exact original schema and old rows`, () => {
    const db = baseline();
    try {
      const before = { schema: schema(db), data: oldRows(db) };
      let steps = 0;
      const execute = db.exec.bind(db);
      const faultBoundary = new Proxy(db, { get(target, key) {
        if (key === 'exec') return (sql: string) => { const result = execute(sql); if (++steps === failAfter) throw Error('injected-after-ddl'); return result; };
        return Reflect.get(target, key, target);
      } });
      db.exec('BEGIN IMMEDIATE');
      assert.throws(() => migrateCompatibleForwardPermissionReceipt(faultBoundary), /injected-after-ddl/);
      assert.equal(db.inTransaction, true, 'helper must not commit or roll back caller transaction');
      db.exec('ROLLBACK');
      assert.equal(steps, failAfter);
      assert.deepEqual({ schema: schema(db), data: oldRows(db) }, before);
    } finally { db.close(); }
  });
}

test('reviewed fence checks, composite scope uniqueness and restrictive decision foreign key remain effective', () => {
  const db = baseline();
  try {
    migrate(db);
    const insert = db.prepare('INSERT INTO permission_effect_fences VALUES (?,?,?,?,?,?)');
    for (const args of [ ['other','key',1,null,'reason',1], ['session','',1,null,'reason',1],
      ['session','x'.repeat(513),1,null,'reason',1], ['session','key',0,null,'reason',1],
      ['session','key',1,null,'',1], ['session','key',1,null,'x'.repeat(129),1],
      ['session','key',1,'missing','reason',1] ]) assert.throws(() => insert.run(...args));
    insert.run('session','key',1,'decision','reason',1);
    insert.run('user_provider_purpose','key',1,null,'reason',1);
    assert.throws(() => insert.run('session','key',2,null,'reason',2), /UNIQUE/);
    assert.throws(() => db.prepare('UPDATE permission_admission_leases SET effect_footprint=?').run('unknown'), /CHECK/);
    assert.throws(() => db.prepare('UPDATE permission_admission_leases SET effect_footprint=NULL').run(), /NOT NULL/);
    db.prepare('DELETE FROM permission_admission_leases WHERE decision_id=?').run('decision');
    db.prepare('DELETE FROM permission_generation_blocks WHERE decision_id=?').run('decision');
    assert.throws(() => db.prepare('DELETE FROM permission_launch_decisions WHERE decision_id=?').run('decision'), /FOREIGN KEY/);
  } finally { db.close(); }
});
