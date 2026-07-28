import assert from 'node:assert/strict';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import { generateToken, JWT_SECRET } from './auth.js';

test('jwt: generated token carries id, username, role and verifies', () => {
  const token = generateToken({ id: 7, username: 'alice', role: 'admin' });
  const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
  assert.equal(decoded.userId, 7);
  assert.equal(decoded.username, 'alice');
  assert.equal(decoded.role, 'admin');
});

test('jwt: forged token (wrong secret) fails verification', () => {
  const forged = jwt.sign({ userId: 1 }, 'attacker-secret', { expiresIn: '7d' });
  assert.throws(() => jwt.verify(forged, JWT_SECRET));
});

test('jwt: expired token fails verification', () => {
  // iat in the far past, expired immediately.
  const expired = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: -10 });
  assert.throws(() => jwt.verify(expired, JWT_SECRET), /jwt expired/);
});

test('jwt: tampered payload fails verification', () => {
  const token = generateToken({ id: 1, username: 'bob', role: 'user' });
  const [header, , signature] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ userId: 1, role: 'owner' })).toString(
    'base64url'
  );
  const tampered = `${header}.${tamperedPayload}.${signature}`;
  assert.throws(() => jwt.verify(tampered, JWT_SECRET));
});
