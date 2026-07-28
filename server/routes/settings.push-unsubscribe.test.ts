/**
 * B-146 — POST /api/settings/push/unsubscribe must only delete a push
 * subscription the caller owns. The repository deletes purely by endpoint, so
 * before the fix any authenticated user could delete another user's subscription
 * by its endpoint (IDOR). The route now scopes the delete to the caller's own
 * subscription set.
 *
 * Framework: node:test + node:assert/strict via tsx against a REAL but
 * throwaway SQLite database (the test command points DATABASE_PATH at a temp
 * dir). This exercises the real repository SQL together with the real route; the
 * live database is never touched. The router is mounted with an injected
 * authenticated user (the server applies authenticateToken before it).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';

import { hashPassword } from '../services/password.service.js';
import settingsRouter from './settings.js';

let currentUser: { id: number } = { id: 0 };
let server: Server;
let baseUrl = '';
let dbDir = '';

before(async () => {
  // Own isolated database so parallel test files never share a connection.
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-push-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = currentUser;
    next();
  });
  app.use('/api/settings', settingsRouter);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function createUser(name: string): Promise<number> {
  const hash = await hashPassword('password1234');
  return userDb.createUser(name, hash, 'user').id;
}

async function unsubscribe(endpoint: string): Promise<Response> {
  return fetch(`${baseUrl}/api/settings/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}

function ownsEndpoint(userId: number, endpoint: string): boolean {
  return pushSubscriptionsDb.getSubscriptions(userId).some((s) => s.endpoint === endpoint);
}

test("B-146 attack: a user cannot unsubscribe another user's endpoint (IDOR)", async () => {
  const alice = await createUser('alice_b146');
  const bob = await createUser('bob_b146');
  const bobEndpoint = 'https://push.example/bob-device';
  pushSubscriptionsDb.saveSubscription(bob, bobEndpoint, 'p256dh-bob', 'auth-bob');

  currentUser = { id: alice };
  const res = await unsubscribe(bobEndpoint); // Alice attacks Bob's endpoint

  assert.equal(res.status, 200); // generic success — no ownership disclosure
  assert.equal(ownsEndpoint(bob, bobEndpoint), true, "Bob's subscription must survive");
});

test('B-146 behavior: a user can unsubscribe their own endpoint', async () => {
  const carol = await createUser('carol_b146');
  const carolEndpoint = 'https://push.example/carol-device';
  pushSubscriptionsDb.saveSubscription(carol, carolEndpoint, 'p256dh-carol', 'auth-carol');
  assert.equal(ownsEndpoint(carol, carolEndpoint), true);

  currentUser = { id: carol };
  const res = await unsubscribe(carolEndpoint);

  assert.equal(res.status, 200);
  assert.equal(ownsEndpoint(carol, carolEndpoint), false, "Carol's own subscription is removed");
});
