/**
 * B-175 (1) — the skills API must not disclose the operator's absolute home path.
 *
 * `ProviderSkill.sourcePath` is built from `os.homedir()` (`~/.claude/skills/...`,
 * `~/.agents/skills/...`). `GET /:provider/skills` is open to EVERY authenticated
 * member (only the write verbs are owner/admin gated), so the raw record handed the
 * whole team the operator's real home layout — the account name, the fleet's user
 * root, and the exact on-disk location of every skill folder.
 *
 * The routes now collapse the home prefix to `~` on all three skill responses. The
 * frontend only displays, searches and React-keys this string (never resolves it),
 * so uniqueness and stability are preserved — which the second test pins.
 *
 * Runner: npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *           --test server/modules/providers/tests/skills.path-redaction.test.ts
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { mockDatabaseBarrel } from './helpers/database-barrel-mock.js';

// auth.js resolves its JWT secret at load time (env first, then db). Removing the
// env var forces the deterministic mocked-db path if auth.js is transitively hit.
delete process.env.JWT_SECRET;

const HOME = os.homedir();

const skillsServiceUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../services/skills.service.js'),
).href;
const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../database/index.js'),
).href;

const buildSkill = (sourcePath: string, name: string) => ({
  provider: 'claude',
  name,
  description: `${name} description`,
  command: `/${name}`,
  scope: 'user',
  sourcePath,
});

// Two skills with the SAME leaf name under different absolute roots: after
// redaction they must remain distinguishable (the frontend keys list items on
// sourcePath), which is what makes a prefix collapse safe here.
const LISTED_SKILLS = [
  buildSkill(path.join(HOME, '.claude', 'skills', 'alpha', 'SKILL.md'), 'alpha'),
  buildSkill(path.join(HOME, '.agents', 'skills', 'alpha', 'SKILL.md'), 'alpha'),
  buildSkill(path.join('/etc', 'codex', 'skills', 'beta', 'SKILL.md'), 'beta'),
];

mock.module(skillsServiceUrl, {
  namedExports: {
    providerSkillsService: {
      listProviderSkills: async () => LISTED_SKILLS,
      addProviderSkills: async () => [LISTED_SKILLS[0]],
      removeProviderSkill: async () => LISTED_SKILLS[0],
    },
  },
});

// The provider registry eagerly instantiates every provider and several of them
// statically import repository singletons from the database barrel, so the mock
// must expose EVERY value export of @/modules/database/index.js — ESM validates
// named imports structurally. The list is derived from the real barrel (see
// helpers/database-barrel-mock.ts) so a newly added export can no longer break
// this test; only the few exports this route path really uses are overridden.
await mockDatabaseBarrel(dbIndexUrl, {
  // auth.js falls back to this when process.env.JWT_SECRET is unset.
  appConfigDb: {
    getOrCreateJwtSecret: () => 'nassaj-skills-test-jwt-secret-0123456789abcd',
  },
  auditLogDb: { record: () => {} },
  getConnection: () => ({}),
  getDatabasePath: () => ':memory:',
  hashMessageAuthorContent: () => '',
  // (value: unknown) => number | null — no stored row exists in this test.
  parseStoredTimestampMs: () => null,
});

const { default: providerRouter } = await import('../provider.routes.js');

async function buildServer(role: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/providers', (req, _res, next) => {
    (req as express.Request & { user: unknown }).user = { id: 1, username: role, role };
    next();
  }, providerRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const request = async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { request, close };
}

test('skill responses never carry the operator home path (B-175)', async () => {
  const { request, close } = await buildServer('owner');

  try {
    const listed = await request('GET', '/api/providers/claude/skills');
    assert.equal(listed.status, 200);
    const listedPaths: string[] = listed.body.data.skills.map((s: any) => s.sourcePath);
    assert.deepEqual(listedPaths, [
      path.join('~', '.claude', 'skills', 'alpha', 'SKILL.md'),
      path.join('~', '.agents', 'skills', 'alpha', 'SKILL.md'),
      // Paths outside the home dir are passed through untouched.
      path.join('/etc', 'codex', 'skills', 'beta', 'SKILL.md'),
    ]);
    assert.ok(
      !JSON.stringify(listed.body).includes(HOME),
      'the raw home path must not appear anywhere in the list response',
    );

    // The write verbs echo skill records too, so they get the same treatment.
    const created = await request('POST', '/api/providers/claude/skills', {
      entries: [{ directoryName: 'alpha', content: '---\nname: alpha\ndescription: d\n---\n\nB.\n' }],
    });
    assert.equal(created.status, 200);
    assert.ok(!JSON.stringify(created.body).includes(HOME), 'POST response must be redacted too');

    const deleted = await request('DELETE', '/api/providers/claude/skills/alpha');
    assert.equal(deleted.status, 200);
    assert.ok(!JSON.stringify(deleted.body).includes(HOME), 'DELETE response must be redacted too');
  } finally {
    await close();
  }
});

test('redaction keeps sourcePath unique so the UI can still key on it', async () => {
  const { request, close } = await buildServer('user');

  try {
    const listed = await request('GET', '/api/providers/claude/skills');
    const listedPaths: string[] = listed.body.data.skills.map((s: any) => s.sourcePath);
    assert.equal(new Set(listedPaths).size, listedPaths.length);
    listedPaths.forEach((value) => assert.ok(value.length > 0, 'sourcePath must stay non-empty'));
  } finally {
    await close();
  }
});
