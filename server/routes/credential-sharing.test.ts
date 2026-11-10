/**
 * credential-sharing.test — the one-time retirement notice (ADR-152 A1 §3.10, D3).
 *
 *   - owner role only; any other role (and an anonymous caller) gets 404;
 *   - {notice:null} without a snapshot, and after acknowledgement;
 *   - the notice lists shared providers, install-wide key providers and the
 *     members at retirement by username — never credential presence or email;
 *   - it tells owners they must link their own account too (qa condition 8);
 *   - POST ack → 204, idempotent, exactly one strict audit row.
 *
 * Runner: node:test. Sandboxed $HOME + throwaway DB opened before any import.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-credential-sharing-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
process.env.HOME = path.join(sandbox, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

const { initializeDatabase, closeConnection, getConnection, auditLogDb, userDb } = await import('@/modules/database/index.js');
const { default: router } = await import('./credential-sharing.js');
const { AppError } = await import('@/shared/utils.js');

await initializeDatabase();

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const owner = userDb.createUser('notice-owner', 'hash', 'owner');
const admin = userDb.createUser('notice-admin', 'hash', 'admin');
const ebtehal = userDb.createUser('ebtehal', 'hash', 'user');

describe('/api/credential-sharing/retirement-notice', () => {
  let server: Server;
  let baseUrl = '';
  let caller: { id: number; role: string } | null = null;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = caller ?? undefined; next(); });
    app.use('/api/credential-sharing', router);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = error instanceof AppError ? error.statusCode : 500;
      res.status(status).json({ success: false, error: { code: (error as { code?: string }).code } });
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/credential-sharing/retirement-notice`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const get = async (user: { id: number; role: string } | null) => {
    caller = user;
    const res = await fetch(baseUrl);
    return { status: res.status, body: res.status === 200 ? await res.json() as Record<string, any> : null };
  };
  const ack = async (user: { id: number; role: string } | null) => {
    caller = user;
    const res = await fetch(`${baseUrl}/ack`, { method: 'POST' });
    return res.status;
  };
  const ackAudits = () => auditLogDb.recent(1000).filter((row: { action: string }) => row.action === 'provider_sharing_notice_acknowledged');
  const asOwner = { id: owner.id, role: 'owner' };

  it('no snapshot yet: the owner gets {notice:null}', async () => {
    const { status, body } = await get(asOwner);
    assert.equal(status, 200);
    assert.deepEqual(body?.data, { notice: null });
  });

  it('with a snapshot: the owner sees providers and members by username, and that owners must link too', async () => {
    const db = getConnection();
    db.exec(`CREATE TABLE IF NOT EXISTS provider_sharing_retirement (id INTEGER PRIMARY KEY CHECK (id = 1),
      retired_at TEXT NOT NULL, raw_policy TEXT, shared_providers TEXT NOT NULL, org_key_providers TEXT NOT NULL,
      members_at_retirement TEXT NOT NULL, notice_acknowledged_at TEXT, notice_acknowledged_by INTEGER)`);
    db.prepare(`INSERT INTO provider_sharing_retirement (id, retired_at, raw_policy, shared_providers,
      org_key_providers, members_at_retirement) VALUES (1, '2026-11-05T00:00:00.000Z', '{"claude":"shared"}', ?, ?, ?)`)
      .run(JSON.stringify(['claude', 'agy']), JSON.stringify(['kimi']), JSON.stringify([admin.id, ebtehal.id, 9999]));

    const { status, body } = await get(asOwner);
    assert.equal(status, 200);
    assert.deepEqual(body?.data.notice, {
      retiredAt: '2026-11-05T00:00:00.000Z',
      sharedProviders: ['claude', 'agy'],
      orgKeyProviders: ['kimi'],
      members: [{ userId: admin.id, username: 'notice-admin' }, { userId: ebtehal.id, username: 'ebtehal' }],
      ownersMustLinkOwnAccount: true,
    });
    assert.ok(!JSON.stringify(body).includes('raw_policy') && !JSON.stringify(body).includes('"shared"}'),
      'the raw policy stays in the snapshot');
  });

  it('every other role, and an anonymous caller, gets 404 for both endpoints', async () => {
    for (const user of [{ id: admin.id, role: 'admin' }, { id: ebtehal.id, role: 'user' }, null]) {
      assert.equal((await get(user)).status, 404, `GET as ${user?.role ?? 'anonymous'}`);
      assert.equal(await ack(user), 404, `POST as ${user?.role ?? 'anonymous'}`);
    }
    assert.equal(ackAudits().length, 0);
  });

  it('ack → 204, idempotent, exactly one strict audit row; the notice is gone afterwards', async () => {
    assert.equal(await ack(asOwner), 204);
    assert.equal(await ack(asOwner), 204);
    const audits = ackAudits();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].user_id, owner.id);
    const row = getConnection().prepare('SELECT notice_acknowledged_by FROM provider_sharing_retirement').get() as
      { notice_acknowledged_by: number };
    assert.equal(row.notice_acknowledged_by, owner.id);
    assert.deepEqual((await get(asOwner)).body?.data, { notice: null });
  });
});

describe('deviation d: a retirement with nothing shared and no install-wide key shows no notice', () => {
  it('the snapshot is still recorded, but the owner gets {notice:null}', async () => {
    const { providerSharingRetirementNoticeService } = await import(
      '@/modules/providers/services/provider-sharing-retirement-notice.service.js');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, metadata TEXT,
        ip_address TEXT, user_agent TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE provider_sharing_retirement (id INTEGER PRIMARY KEY CHECK (id = 1), retired_at TEXT NOT NULL,
        raw_policy TEXT, shared_providers TEXT NOT NULL, org_key_providers TEXT NOT NULL,
        members_at_retirement TEXT NOT NULL, notice_acknowledged_at TEXT, notice_acknowledged_by INTEGER);
      INSERT INTO provider_sharing_retirement (id, retired_at, raw_policy, shared_providers, org_key_providers,
        members_at_retirement) VALUES (1, '2026-11-05T00:00:00Z', '{"claude":"isolated"}', '[]', '[]', '[2]');`);
    assert.equal(providerSharingRetirementNoticeService.getNotice(db), null);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM provider_sharing_retirement').get() as { n: number }).n, 1);
    // An unreadable key store ('unknown') is not "nothing": the notice shows.
    db.prepare("UPDATE provider_sharing_retirement SET org_key_providers = 'unknown'").run();
    assert.equal(providerSharingRetirementNoticeService.getNotice(db)?.orgKeyProviders, 'unknown');
    db.close();
  });
});
