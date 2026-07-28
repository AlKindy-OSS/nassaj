/**
 * OC-19 (route level) — POST /api/commands/list must filter Claude-only built-ins
 * for an opencode session and return the full static list for other providers.
 *
 * Mounts the real commands router (mirroring commands.project-visibility.test.ts)
 * and drives it over HTTP. No database is needed: /list without a projectPath never
 * calls projectsDb, and the DB connection is lazy, so the live database is untouched.
 * Providers here are non-Claude, so getClaudeBuiltInCommands is never invoked.
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import commandsRouter from '../commands.js';

let server: Server;
let baseUrl = '';

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = { id: 1, role: 'user' };
    next();
  });
  app.use('/api/commands', commandsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listFor(provider?: string) {
  const res = await fetch(`${baseUrl}/api/commands/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  assert.equal(res.status, 200, `/list must be 200 for provider=${provider}`);
  return (await res.json()) as {
    builtIn: Array<{ name: string }>;
    custom: unknown[];
    count: number;
  };
}

test('opencode: /list omits Claude-only built-ins, keeps the universal ones', async () => {
  const { builtIn } = await listFor('opencode');
  const names = new Set(builtIn.map((c) => c.name));
  for (const claudeOnly of ['/memory', '/config', '/compact', '/hooks', '/vim', '/agents', '/resume']) {
    assert.ok(!names.has(claudeOnly), `opencode /list must omit ${claudeOnly}`);
  }
  for (const universal of ['/help', '/models', '/cost', '/status']) {
    assert.ok(names.has(universal), `opencode /list must keep ${universal}`);
  }
});

test('cursor: /list returns the full static built-in list (unfiltered)', async () => {
  const { builtIn } = await listFor('cursor');
  const names = new Set(builtIn.map((c) => c.name));
  // Claude-only commands are still present for providers outside the OC-19 filter.
  assert.ok(names.has('/memory'), 'cursor keeps /memory (unfiltered)');
  assert.ok(names.has('/compact'), 'cursor keeps /compact (unfiltered)');
  // The opencode-filtered set is strictly smaller than the unfiltered one.
  const opencode = await listFor('opencode');
  assert.ok(opencode.builtIn.length < builtIn.length, 'opencode list is smaller');
});
// NOTE: provider=claude is intentionally not exercised here — it would trigger the
// live getClaudeBuiltInCommands probe. The Claude path is covered by
// commands-dynamic-resolve.test.ts (which mocks the SDK).
