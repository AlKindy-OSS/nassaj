import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  consumeCloneTicket,
  createCloneTicket,
  resetCloneTicketsForTests,
} from '@/modules/projects/projects.routes.js';
import { AppError } from '@/shared/utils.js';

const input = {
  workspacePath: '/workspace/synthetic-projects',
  githubUrl: 'https://github.com/example/repository.git',
  githubTokenId: null,
  newGithubToken: 'ghp_synthetic_secret',
};

beforeEach(() => resetCloneTicketsForTests());

test('clone ticket is opaque, user-bound, and consumed exactly once', () => {
  const created = createCloneTicket(7, input, 1_000);
  assert.match(created.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.expiresInSeconds, 60);
  assert.ok(!created.ticket.includes(input.newGithubToken));

  assert.equal(consumeCloneTicket(created.ticket, 8, 1_001), null);
  assert.deepEqual(consumeCloneTicket(created.ticket, 7, 1_001), input);
  assert.equal(consumeCloneTicket(created.ticket, 7, 1_002), null);
});

test('expired and malformed clone tickets fail closed', () => {
  const created = createCloneTicket(7, input, 5_000);
  assert.equal(consumeCloneTicket('not-a-ticket', 7, 5_001), null);
  assert.equal(consumeCloneTicket(created.ticket, 7, 65_000), null);
});

test('clone ticket issuance is capped at eight active tickets per user', () => {
  for (let index = 0; index < 8; index += 1) createCloneTicket(7, input, 10_000);
  assert.throws(
    () => createCloneTicket(7, input, 10_001),
    (error: unknown) => error instanceof AppError && error.code === 'CLONE_TICKET_LIMIT_REACHED',
  );
  assert.doesNotThrow(() => createCloneTicket(8, input, 10_001));
});
