/**
 * T-1197 (ADR-093 §4) — "link this agent to nassaj instructions", pinned at the
 * ROUTE, because that is where the authorization lives.
 *
 * WHAT THESE TESTS PIN. Not the status codes — the FILESYSTEM. A gate that answers
 * 200 while writing into the operator's home would pass a status-code test and fail
 * these. Every case asserts where the bytes did and did not land, and what the file
 * IS: a real 0444 COPY whose sha256 equals the neutral source — never a symlink
 * (§4.1), because agy/codex run with expanded permissions and a link into the
 * shared source is a write-through vector into every user's governance.
 *
 * The rules asserted:
 *   1. an isolated user links their OWN tree, no elevation needed (§4.2);
 *   2. a write that lands in the OPERATOR home is owner-only, and a refusal writes
 *      NOTHING;
 *   3. claude, shared agy and mechanism-less engines have no action at all (§4.1/
 *      §4.4) — the endpoint refuses them even if a client calls it directly, so a
 *      hidden button is not the only thing standing between a caller and the write;
 *   4. the client cannot aim the write: no body, query or header changes the path;
 *   5. the response carries the verdict RE-READ from disk, not an optimistic one;
 *   6. GET /governance advertises exactly what POST will accept (one rule, two
 *      answers — the B-362 lesson).
 *
 * HOME is redirected to a sandbox for the whole file: every governance path is
 * derived from it, and a test that wrote into the real tree would rewrite live
 * members' governance.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { setProviderSharingConfig } from '@/services/provider-sharing.js';
import { AppError } from '@/shared/utils.js';

import providerRouter from './provider.routes.js';

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let sandboxHome = '';
let originalHome: string | undefined;

let memberUser: TestUser;
let ownerUser: TestUser;

type Channel = {
  id: string;
  linkable: boolean;
  linkScope: string | null;
  linkRefusal: string | null;
  status: string;
  path: string | null;
};

async function call(
  method: string,
  urlPath: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

async function channelsOf(provider: string, user: TestUser | null): Promise<Channel[]> {
  const response = await call('GET', `/api/providers/${provider}/governance`, user);
  assert.equal(response.status, 200);
  return (response.json.data as { sources: Channel[] }).sources;
}

/** The neutral source every governed copy must be byte-identical to. */
const neutralSource = (): string => path.join(sandboxHome, '.claude', 'AGENTS.md');
const sha256 = (file: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Asserts the artifact contract of §4.1: real file, 0444, exact copy, NOT a link. */
function assertAuthenticCopy(target: string, source: string): void {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false, 'governance must be a COPY, never a symlink');
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o444, 'the copy must be read-only (0444)');
  assert.equal(sha256(target), sha256(source), 'the copy must be identical to the neutral source');
}

const userCodexAgents = (userId: number): string =>
  path.join(sandboxHome, '.nassaj-users', String(userId), '.codex', 'AGENTS.md');
const userKimiAgents = (userId: number): string =>
  path.join(sandboxHome, '.nassaj-users', String(userId), '.kimi', 'AGENTS.md');
const operatorOpencodeAgents = (): string =>
  path.join(sandboxHome, '.config', 'opencode', 'AGENTS.md');

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-gov-link-db-'));
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-gov-link-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandboxHome;
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  delete process.env.XDG_CONFIG_HOME;
  await initializeDatabase();

  // Reproduce the production governance topology: ~/.claude is a link into the
  // governance repo, whose AGENTS.md is the build-agents neutral output. Seeded
  // from the REAL operator source when present (synthetic fixtures give false
  // confidence), else a representative neutral marker.
  const repo = path.join(sandboxHome, 'governance-repo');
  fs.mkdirSync(repo, { recursive: true });
  let neutral: string;
  try {
    neutral = fs.readFileSync(path.join(String(originalHome), '.claude', 'AGENTS.md'), 'utf8');
  } catch {
    neutral = '<!-- GENERATED — DO NOT EDIT -->\n# AGENTS.md — دليل وكلاء نسّاج\n';
  }
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), neutral);
  fs.symlinkSync(repo, path.join(sandboxHome, '.claude'));

  memberUser = userDb.createUser('gov_member', 'hash', 'user') as TestUser;
  ownerUser = { ...(userDb.createUser('gov_owner', 'hash', 'user') as TestUser), role: 'owner' };

  // Pin the policy this test reasons about: codex isolated (per-user home),
  // opencode + agy shared (operator home).
  setProviderSharingConfig({ codex: 'isolated', opencode: 'shared', agy: 'shared' });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

test('an isolated member links their OWN codex tree — and the artifact is a 0444 copy, not a link', async () => {
  const target = userCodexAgents(memberUser.id);
  assert.equal(fs.existsSync(target), false, 'precondition: nothing established yet');

  const before = await channelsOf('codex', memberUser);
  assert.equal(before[0].status, 'ungoverned');
  assert.equal(before[0].linkable, true, 'the surface must offer what the endpoint accepts');
  assert.equal(before[0].linkScope, 'user');

  const response = await call('POST', '/api/providers/codex/governance/link', memberUser);
  assert.equal(response.status, 200);

  assertAuthenticCopy(target, neutralSource());
  // The verdict must come from the RE-READ, not from the request succeeding.
  const data = response.json.data as { status: string; sources: Channel[] };
  assert.equal(data.status, 'governed');
  assert.equal(data.sources[0].status, 'governed');
  assert.equal(data.sources[0].path, target);
});

test('linking is idempotent and leaves no staging file behind', async () => {
  const response = await call('POST', '/api/providers/codex/governance/link', memberUser);
  assert.equal(response.status, 200);
  assertAuthenticCopy(userCodexAgents(memberUser.id), neutralSource());

  const dir = path.dirname(userCodexAgents(memberUser.id));
  const strays = fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
  assert.deepEqual(strays, [], 'the atomic staging file must never survive');
});

test('a planted SYMLINK is replaced by a real copy, and the shared source is NOT written through', async () => {
  const victim = userCodexAgents(memberUser.id);
  const sourceBefore = fs.readFileSync(neutralSource(), 'utf8');
  fs.rmSync(victim, { force: true });
  fs.symlinkSync(neutralSource(), victim);
  assert.equal(fs.lstatSync(victim).isSymbolicLink(), true, 'precondition: planted the vector');

  const response = await call('POST', '/api/providers/codex/governance/link', memberUser);
  assert.equal(response.status, 200);

  assertAuthenticCopy(victim, neutralSource());
  assert.equal(
    fs.readFileSync(neutralSource(), 'utf8'),
    sourceBefore,
    'the shared neutral source must be byte-identical — no write ever goes through a link',
  );
});

test('kimi links into the caller\'s own KIMI_CODE_HOME (isolated for any authenticated user)', async () => {
  const response = await call('POST', '/api/providers/kimi/governance/link', memberUser);
  assert.equal(response.status, 200);
  assertAuthenticCopy(userKimiAgents(memberUser.id), neutralSource());
  assert.equal((response.json.data as { status: string }).status, 'governed');
});

test('a SHARED provider is owner-only, and the refusal writes NOTHING', async () => {
  const advertised = await channelsOf('opencode', memberUser);
  assert.equal(advertised[0].linkable, false, 'no button may be offered to a member');
  assert.equal(advertised[0].linkRefusal, 'owner_required');

  const refused = await call('POST', '/api/providers/opencode/governance/link', memberUser);
  assert.equal(refused.status, 403);
  assert.equal(
    (refused.json.error as { code: string }).code,
    'GOVERNANCE_LINK_FORBIDDEN',
    'the endpoint refuses independently of the hidden button',
  );
  assert.equal(
    fs.existsSync(operatorOpencodeAgents()),
    false,
    'a refused link must not touch the operator home',
  );
});

test('the OWNER may link the shared operator home', async () => {
  const advertised = await channelsOf('opencode', ownerUser);
  assert.equal(advertised[0].linkable, true);
  assert.equal(advertised[0].linkScope, 'operator');

  const response = await call('POST', '/api/providers/opencode/governance/link', ownerUser);
  assert.equal(response.status, 200);
  assertAuthenticCopy(operatorOpencodeAgents(), neutralSource());
});

test('an anonymous caller is refused everywhere and writes nothing', async () => {
  const anonCodex = path.join(sandboxHome, '.codex', 'AGENTS.md');
  const refused = await call('POST', '/api/providers/codex/governance/link', null);
  assert.equal(refused.status, 403);
  assert.equal(fs.existsSync(anonCodex), false, 'no identity ⇒ no home ⇒ no write');

  const advertised = await channelsOf('codex', null);
  assert.equal(advertised[0].linkable, false, 'and the surface offers nothing either');
});

test('claude has NO link action — the endpoint refuses it directly (§4.1)', async () => {
  const advertised = await channelsOf('claude', ownerUser);
  assert.equal(advertised[0].linkable, false);
  assert.equal(advertised[0].linkRefusal, 'symlink_by_design');

  const refused = await call('POST', '/api/providers/claude/governance/link', ownerUser);
  assert.equal(refused.status, 400);
  assert.equal((refused.json.error as { code: string }).code, 'GOVERNANCE_LINK_UNAVAILABLE');
});

test('shared agy has NO link action: the file it reads IS the source', async () => {
  const [home, project] = await channelsOf('antigravity', ownerUser);
  assert.equal(home.linkable, false);
  assert.equal(home.linkRefusal, 'shared_source_is_the_file');
  assert.equal(project.linkable, false);
  assert.equal(project.linkRefusal, 'project_scoped');

  const refused = await call('POST', '/api/providers/antigravity/governance/link', ownerUser);
  assert.equal(refused.status, 400);
  assert.equal(
    fs.existsSync(path.join(sandboxHome, '.gemini', 'GEMINI.md')),
    false,
    'a refused link must create nothing',
  );
});

test('an ISOLATED agy user CAN link — into their own .gemini, never the operator\'s', async () => {
  setProviderSharingConfig({ codex: 'isolated', opencode: 'shared', agy: 'isolated' });
  try {
    // The agy source is ~/.gemini/GEMINI.md; establish the operator source first.
    const source = path.join(sandboxHome, '.gemini', 'GEMINI.md');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, '# neutral gemini governance\n');

    const advertised = await channelsOf('antigravity', memberUser);
    assert.equal(advertised[0].linkable, true);
    assert.equal(advertised[0].linkScope, 'user');

    const response = await call('POST', '/api/providers/antigravity/governance/link', memberUser);
    assert.equal(response.status, 200);

    const target = path.join(sandboxHome, '.nassaj-users', String(memberUser.id), '.gemini', 'GEMINI.md');
    assertAuthenticCopy(target, source);
    assert.equal((response.json.data as { status: string }).status, 'governed');
  } finally {
    setProviderSharingConfig({ codex: 'isolated', opencode: 'shared', agy: 'shared' });
  }
});

test('an engine with no mechanism has no action at all', async () => {
  const advertised = await channelsOf('hermes', ownerUser);
  assert.equal(advertised[0].linkable, false);
  assert.equal(advertised[0].linkRefusal, 'no_mechanism');

  const refused = await call('POST', '/api/providers/hermes/governance/link', ownerUser);
  assert.equal(refused.status, 400);
});

test('the client cannot aim the write: a hostile body changes nothing', async () => {
  const hostileTarget = path.join(sandboxHome, 'attacker', 'AGENTS.md');
  const response = await call('POST', '/api/providers/codex/governance/link', memberUser, {
    home: path.join(sandboxHome, 'attacker'),
    path: hostileTarget,
    filename: 'AGENTS.md',
    sourcePath: '/etc/passwd',
    userId: ownerUser.id,
  });
  assert.equal(response.status, 200, 'the body is simply not read');
  assert.equal(fs.existsSync(hostileTarget), false, 'no path may come from a client');
  assert.equal(
    (response.json.data as { sources: Channel[] }).sources[0].path,
    userCodexAgents(memberUser.id),
    'the write stays in the CALLER\'s own derived home, not the id they claimed',
  );
});

test('one member cannot link another member\'s tree', async () => {
  const other = userDb.createUser('gov_member_2', 'hash', 'user') as TestUser;
  await call('POST', '/api/providers/codex/governance/link', memberUser);
  assert.equal(
    fs.existsSync(userCodexAgents(other.id)),
    false,
    'the home is derived from the TOKEN identity alone',
  );
});

test('platform mode refuses the write outright — "owner" there means "anyone" (B-186)', async () => {
  // VITE_IS_PLATFORM makes authenticateToken answer every request as the first
  // user, so the owner role stops meaning anything. A governance write under it
  // would be a node-wide instruction-injection path for an unauthenticated caller.
  const target = path.join(sandboxHome, '.nassaj-users', String(ownerUser.id), '.codex', 'AGENTS.md');
  fs.rmSync(target, { force: true });
  process.env.VITE_IS_PLATFORM = 'true';
  try {
    const advertised = await channelsOf('codex', ownerUser);
    assert.equal(advertised[0].linkable, false, 'no affordance is offered under platform mode');
    assert.equal(advertised[0].linkRefusal, 'owner_required');

    const refused = await call('POST', '/api/providers/codex/governance/link', ownerUser);
    assert.equal(refused.status, 403);
    assert.equal(fs.existsSync(target), false, 'and nothing is written');
  } finally {
    delete process.env.VITE_IS_PLATFORM;
  }

  // Sanity: the same call succeeds once the flag is gone, so the test pins the
  // FLAG as the cause and not some unrelated refusal.
  const allowed = await call('POST', '/api/providers/codex/governance/link', ownerUser);
  assert.equal(allowed.status, 200);
  assertAuthenticCopy(target, neutralSource());
});
