/** Full provider router + real JWT/API-key middleware; startup workers are deliberately not booted. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { AddressInfo, Socket } from 'node:net';

import express from 'express';
import ts from 'typescript';
import Database from 'better-sqlite3';

import { assistantRecord } from '../../../../tests/helpers/memory-c0-adversarial-fixtures.mjs';

const project = path.resolve(import.meta.dirname, '../../../..'), scratch = process.env.HOME!;
assert.ok(scratch.startsWith(project + '/.memory-c0-full-router-'), 'run only in the dedicated isolated project-disk child');
assert.equal(process.env.DATABASE_PATH, path.join(scratch, 'fixture.sqlite'));
assert.ok((process.env.JWT_SECRET?.length ?? 0) >= 32, 'synthetic JWT authority must precede module import');
const methods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
const originals = Object.fromEntries(methods.map(key => [key, childProcess[key]]));
let deniedProcesses = 0;
const deniedProcessSites: string[] = [];
for (const key of methods) (childProcess as any)[key] = () => {
  deniedProcesses++; const error = new Error('C0_ROUTER_NATIVE_PROCESS_FORBIDDEN');
  deniedProcessSites.push(`${key}: ${error.stack?.split('\n').slice(2, 4).join(' ')}`); throw error;
};
syncBuiltinESMExports();
const legacyMethods = ['copyFileSync', 'readFileSync', 'existsSync', 'openSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'truncateSync', 'chmodSync', 'statSync',
  'copyFile', 'readFile', 'open', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'truncate', 'chmod', 'stat'] as const;
const legacyOriginals = Object.fromEntries(legacyMethods.map(key => [key, fsSync[key]]));
const promiseMethods = ['copyFile', 'readFile', 'open', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'truncate', 'chmod', 'stat'] as const;
const promiseOriginals = Object.fromEntries(promiseMethods.map(key => [key, fs[key]]));
let legacyAttempts = 0, processesAtReady = 0;
const guardPath = (file: any) => {
  const value = file instanceof URL ? fileURLToPath(file) : String(file);
  if (value.startsWith(path.join(project, 'database/auth.db')) || value.startsWith(path.join(project, 'server/database/auth.db'))) {
    legacyAttempts++; throw new Error('C0_LEGACY_DATABASE_FORBIDDEN');
  }
};
for (const key of legacyMethods) (fsSync as any)[key] = (file: any, ...args: any[]) => {
  guardPath(file); if (key.startsWith('copyFile') || key.startsWith('rename')) guardPath(args[0]);
  return (legacyOriginals as any)[key](file, ...args);
};
for (const key of promiseMethods) (fs as any)[key] = (file: any, ...args: any[]) => {
  guardPath(file); if (key === 'copyFile' || key === 'rename') guardPath(args[0]);
  return (promiseOriginals as any)[key](file, ...args);
};
syncBuiltinESMExports();
// Exercise interception on nonexistent forbidden names; no underlying legacy operation is reached.
const guardSentinel = path.join(project, 'database/auth.db.memory-c0-nonexistent-guard-probe');
let guardChecks = 0;
for (const [namespace, keys] of [[fsSync, legacyMethods], [fs, promiseMethods]] as const) {
  for (const key of keys) {
    assert.throws(() => (namespace as any)[key](guardSentinel), /C0_LEGACY_DATABASE_FORBIDDEN/); guardChecks++;
    if (key.startsWith('copyFile') || key.startsWith('rename')) {
      assert.throws(() => (namespace as any)[key](path.join(scratch, 'missing-probe'), guardSentinel), /C0_LEGACY_DATABASE_FORBIDDEN/); guardChecks++;
    }
  }
}
legacyAttempts = 0;
const interval = globalThis.setInterval, timers = new Set<NodeJS.Timeout>();
globalThis.setInterval = ((...args: any[]) => { const value = (interval as any)(...args); timers.add(value); value.unref(); return value; }) as typeof setInterval;
let db: any, server: http.Server, base: string, ownerToken: string, strangerToken: string;
const sockets = new Set<Socket>(), sources = new Map<string, string>();

before(async () => {
  // An existing empty fixture prevents the real connection bootstrap's legacy-copy fallback.
  new Database(process.env.DATABASE_PATH!).close();
  db = await import('@/modules/database/index.js');
  await db.initializeDatabase();
  const owner = db.userDb.createUser('memory-router-owner', 'synthetic-unusable-password-hash', 'user');
  const stranger = db.userDb.createUser('memory-router-stranger', 'synthetic-unusable-password-hash', 'user');
  db.projectsDb.createProjectPath(scratch, 'Memory router fixture', owner.id);
  // eslint-disable-next-line boundaries/dependencies -- full-router integration seeds the real sessions table.
  const { getConnection } = await import('@/modules/database/connection.js');
  for (const provider of ['claude', 'codex']) {
    const session = `memory-router-${provider}`, source = path.join(scratch, `${provider}.jsonl`);
    const record = assistantRecord(provider, 0, 'history العربية 🧵');
    if (provider === 'claude') record.sessionId = session;
    await fs.writeFile(source, JSON.stringify(record) + '\n'); sources.set(provider, source);
    db.sessionsDb.createSession(session, provider, scratch);
    getConnection().prepare('UPDATE sessions SET jsonl_path=? WHERE session_id=?').run(source, session);
    db.participantsDb.recordSpawn(session, owner.id);
  }
  getConnection().prepare('INSERT OR REPLACE INTO app_config(key,value) VALUES(?,?)').run('jwt_secret', process.env.JWT_SECRET);
  // eslint-disable-next-line boundaries/no-unknown -- full-router integration mints real JWTs.
  const auth = await import('../../../middleware/auth.js');
  ownerToken = auth.generateToken(owner); strangerToken = auth.generateToken(stranger);
  const { default: router } = await import('../provider.routes.js');
  const { AppError } = await import('@/shared/utils.js');
  // eslint-disable-next-line boundaries/no-unknown -- full-router integration uses the real body-limit classifier.
  const { isPayloadTooLargeError } = await import('../../../middleware/global-body-limits.js');
  const source = await fs.readFile(path.join(project, 'server/index.js'), 'utf8');
  const parsed = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let handler: ts.ArrowFunction | undefined;
  for (const statement of parsed.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(parsed) !== 'app.use') continue;
    const candidate = call.arguments[0];
    if (candidate && ts.isArrowFunction(candidate) && candidate.parameters.length === 4 && candidate.body.getText(parsed).includes('isPayloadTooLargeError')) handler = candidate;
  }
  assert.ok(handler, 'actual final error middleware must be found without executing server/index');
  const errorMiddleware = new Function('AppError', 'isPayloadTooLargeError', `"use strict";return (${handler!.getText(parsed)});`)(AppError, isPayloadTooLargeError);
  const app = express();
  app.use('/api', auth.validateApiKey);
  app.use('/api/providers', auth.authenticateToken, router);
  app.use(errorMiddleware);
  server = http.createServer(app); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  processesAtReady = deniedProcesses;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  db?.closeConnection(); timers.forEach(value => clearInterval(value)); globalThis.setInterval = interval;
  for (const key of methods) (childProcess as any)[key] = originals[key]; syncBuiltinESMExports();
  for (const key of legacyMethods) (fsSync as any)[key] = legacyOriginals[key]; syncBuiltinESMExports();
  for (const key of promiseMethods) (fs as any)[key] = promiseOriginals[key];
  console.log(JSON.stringify({ fixtureOnly: legacyAttempts === 0, guardChecks, legacyAttempts, deniedProcesses, deniedProcessSites, nativeChildren: 0 }));
});

async function call(provider: string, token?: string, suffix = '') {
  const result = await fetch(`${base}/api/providers/sessions/memory-router-${provider}/messages${suffix}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: result.status, body: await result.json() };
}
test('full history router refuses absent and forged JWT before history access', async () => {
  assert.equal((await call('claude')).status, 401);
  assert.equal((await call('claude', 'forged-synthetic-token')).status, 401);
});
for (const provider of ['claude', 'codex']) {
  test(`full ${provider} router preserves team visibility and refuses unattached nonparticipant history`, async () => {
    assert.equal((await call(provider, strangerToken)).status, 200, 'ADR-089 registered projects are team-readable');
    // eslint-disable-next-line boundaries/dependencies -- detaches the session from its project in the real table.
    const { getConnection } = await import('@/modules/database/connection.js');
    const session = `memory-router-${provider}`;
    getConnection().prepare('UPDATE sessions SET project_path=? WHERE session_id=?').run(null, session);
    try {
      assert.equal((await call(provider, strangerToken)).status, 404);
      const result = await call(provider, ownerToken); assert.equal(result.status, 200);
      assert.equal(result.body.messages[0].content, 'history العربية 🧵');
    } finally { getConnection().prepare('UPDATE sessions SET project_path=? WHERE session_id=?').run(scratch, session); }
  });
  test(`full ${provider} router sends invalid query through the actual final error middleware`, async () => {
    const result = await call(provider, ownerToken, '?limit=invalid');
    assert.equal(result.status, 400); assert.equal(result.body.error.code, 'INVALID_QUERY_PARAMETER');
  });
  test(`full ${provider} router keeps oversized and incomplete source failures typed`, async () => {
    const source = sources.get(provider)!, original = await fs.readFile(source);
    const { resetHistorySnapshotCacheForTests } = await import('../services/session-history-light.service.js');
    try {
      await fs.writeFile(source, original.subarray(0, original.length - 2));
      resetHistorySnapshotCacheForTests();
      let result = await call(provider, ownerToken); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'HISTORY_SOURCE_INCOMPLETE');
      await fs.writeFile(source, Buffer.alloc(4 * 1048576 + 1, 32));
      resetHistorySnapshotCacheForTests();
      result = await call(provider, ownerToken); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'HISTORY_BUDGET_EXCEEDED');
    } finally { await fs.writeFile(source, original); }
  });
}
test('full router API-key guard precedes JWT and no route launched a provider process', async () => {
  process.env.API_KEY = 'memory-c0-test-api-key';
  try { assert.equal((await call('claude', ownerToken)).status, 401); }
  finally { delete process.env.API_KEY; }
  assert.equal(deniedProcesses, processesAtReady); assert.equal(legacyAttempts, 0);
});
