/**
 * raw-exec-audit tests (T-2037): the shared raw-exec audit sink keeps the
 * command_board_raw_exec action, redacts inline credentials, and the strict
 * variant refuses when the row cannot be proven.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { auditLogDb } from '@/modules/database/index.js';
import {
  actorFromRequest,
  auditRawExec,
  auditRawExecStrict,
  RAW_EXEC_AUDIT_ACTION,
} from '@/services/raw-exec-audit.js';

async function withDb(runTest: () => void | Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'rxa-test-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

const ACTOR = { userId: null, ip: '203.0.113.9', userAgent: 'test-agent' };

test('actorFromRequest reads user, peer address and user agent', () => {
  const actor = actorFromRequest({
    user: { id: 5 },
    headers: { 'user-agent': 'ua' },
    socket: { remoteAddress: '198.51.100.4' },
  } as never);
  assert.deepEqual(actor, { userId: 5, ip: '198.51.100.4', userAgent: 'ua' });
  assert.deepEqual(actorFromRequest(null), { userId: null, ip: null, userAgent: null });
});

test('writes the command_board_raw_exec row with the credential redacted', async () => {
  await withDb(() => {
    auditRawExec(ACTOR, 'shell_exec_start', { command: 'FOO_TOKEN=abc123xyz ./deploy.sh', runId: 'r' });
    const [row] = auditLogDb.recent(1);
    assert.equal(row?.action, RAW_EXEC_AUDIT_ACTION);
    assert.equal(row?.action, 'command_board_raw_exec');
    assert.equal(row?.ip_address, ACTOR.ip);
    assert.equal(row?.user_agent, ACTOR.userAgent);
    assert.equal(String(row?.metadata).includes('abc123xyz'), false);
    const metadata = JSON.parse(String(row?.metadata));
    assert.equal(metadata.result, 'shell_exec_start');
    assert.match(metadata.command, /^FOO_TOKEN=«redacted» \.\/deploy\.sh$/);
  });
});

test('strict audit proves the row landed and throws when it cannot', async () => {
  await withDb(() => {
    assert.doesNotThrow(() => auditRawExecStrict(ACTOR, 'exec_start', { command: 'ls' }));
    const metadata = JSON.parse(String(auditLogDb.recent(1)[0]?.metadata));
    assert.match(metadata.auditNonce, /^[0-9a-f-]{36}$/);
    getConnection().exec('DROP TABLE audit_log');
    assert.throws(() => auditRawExecStrict(ACTOR, 'exec_start', { command: 'ls' }), /audit_unverifiable/);
  });
});
