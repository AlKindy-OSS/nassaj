/**
 * provider-credential-write-guard.integration.test.ts — HTTP-level coverage for
 * the role-based 403 write guards on the provider routes (T-866 credential gate
 * + the Codex-isolation MCP global gate hardened in the 2026-07-11 review).
 *
 * These guards run live on nassaj today but had NO integration test: the review
 * flagged that gap explicitly. This suite closes it by driving the REAL code
 * path — the production `provider.routes` router and the real credential writers
 * against a sandboxed SQLite DB and HOME. Nothing about the guard is stubbed: only
 * the authentication middleware is faked (a header sets req.user.{id,role}),
 * exactly as authenticateToken populates it in production and as the sibling
 * provider-api-key.routes suite already does. The 403 is thrown at the
 * authorization layer BEFORE any credential writer runs, so no per-user tree
 * needs provisioning.
 *
 * Coverage:
 *  - POST /mcp/servers/global as a member → 403 MCP_GLOBAL_WRITE_FORBIDDEN;
 *    as an owner the same request clears the role gate (fails later at payload
 *    validation, proving the 403 is role-driven not blanket).
 *  - ADR-152 A1 (T-2083) condition 2: POST /:provider/api-key has no role gate
 *    any more — every write lands in the REQUESTER's own tree. A member's and an
 *    admin's opencode key each land in their own auth.json, never the operator's
 *    (there is no shared tree and no CREDENTIAL_WRITE_FORBIDDEN).
 */

import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { after, before, test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import providerRoutes from '@/modules/providers/provider.routes.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let sandboxHome = '';
let previousDatabasePath: string | undefined;
const realHomedir = os.homedir;

/**
 * Mirrors index.js mounting, except authenticateToken is replaced by a stub that
 * reads `x-test-user` → req.user.id and `x-test-role` → req.user.role. Both are
 * exactly the fields the real middleware attaches and the only ones the guards
 * read, so the guard logic under test runs unmodified.
 */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const id = req.header('x-test-user');
    const role = req.header('x-test-role');
    if (id || role) {
      (req as Request & { user?: { id?: string; role?: string } }).user = {
        id: id ?? undefined,
        role: role ?? undefined,
      };
    }
    next();
  });
  app.use('/api/providers', providerRoutes);
  // Mirror index.js global error middleware so AppError maps to its real
  // { success:false, error:{ code, message } } envelope and status code.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
  return app;
}

type ApiResponse = {
  status: number;
  body: { success?: boolean; data?: unknown; error?: { code?: string; message?: string } };
};

async function call(
  method: string,
  routePath: string,
  options: { user?: string; role?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.user) {
    headers['x-test-user'] = options.user;
  }
  if (options.role) {
    headers['x-test-role'] = options.role;
  }
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, body };
}

before(async () => {
  sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-write-guard-'));
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;

  // Sandbox the DB so every write and audit row stays hermetic.
  previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(sandboxHome, 'auth.db');
  await initializeDatabase();

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  (os as unknown as { homedir: () => string }).homedir = realHomedir;
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await fs.rm(sandboxHome, { recursive: true, force: true });
});

// ----------------- MCP global add: unconditional owner/admin gate -----------------

test('POST /mcp/servers/global as a member is rejected 403 MCP_GLOBAL_WRITE_FORBIDDEN', async () => {
  const res = await call('POST', '/api/providers/mcp/servers/global', {
    user: '2',
    role: 'member',
    // A body that WOULD be a valid global add for an owner, to prove the block
    // is the role gate and not payload validation.
    body: { name: 'shared-mcp', transport: 'http', url: 'https://example.com/mcp', scope: 'project' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, 'MCP_GLOBAL_WRITE_FORBIDDEN');
});

test('POST /mcp/servers/global as an owner clears the role gate (403 is role-driven)', async () => {
  // Empty body: the owner passes the role check, then fails at payload
  // validation (MCP_NAME_REQUIRED) — never a 403 — which proves the gate keys
  // on role. Validation short-circuits before any provider write touches disk.
  const res = await call('POST', '/api/providers/mcp/servers/global', {
    user: '1',
    role: 'owner',
    body: {},
  });
  assert.notEqual(res.status, 403);
  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code, 'MCP_NAME_REQUIRED');
});

// ----------------- ADR-152 A1 condition 2: every credential write is the caller's own -----------------

const ownOpencodeAuth = (userId: string) =>
  path.join(sandboxHome, '.nassaj-users', userId, '.local', 'share', 'opencode', 'auth.json');
const operatorOpencodeAuth = () => path.join(sandboxHome, '.local', 'share', 'opencode', 'auth.json');

async function readKey(file: string, target: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, { key?: string }>)[target]?.key;
  } catch {
    return undefined;
  }
}

test('ADR-152 A1: a member\'s opencode key lands in the member\'s own tree (no 403, no shared tree)', async () => {
  const res = await call('POST', '/api/providers/opencode/api-key', {
    user: '2',
    role: 'member',
    body: { apiKey: 'sk-member-own', target: 'glm' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await readKey(ownOpencodeAuth('2'), 'glm'), 'sk-member-own');
  assert.equal(await readKey(operatorOpencodeAuth(), 'glm'), undefined, 'the operator file is never written');
});

test('ADR-152 A1 condition 2: an admin\'s write lands in the ADMIN\'s tree, not the operator HOME', async () => {
  const res = await call('POST', '/api/providers/opencode/api-key', {
    user: '3',
    role: 'admin',
    body: { apiKey: 'sk-admin-own', target: 'glm' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await readKey(ownOpencodeAuth('3'), 'glm'), 'sk-admin-own');
  assert.equal(await readKey(operatorOpencodeAuth(), 'glm'), undefined, 'no role writes the operator file');
  assert.equal(await readKey(ownOpencodeAuth('2'), 'glm'), 'sk-member-own', 'and never another member\'s');
});

test('an empty key is still refused by validation, for every role, before any write', async () => {
  for (const [user, role] of [['1', 'owner'], ['2', 'member']]) {
    const res = await call('POST', '/api/providers/opencode/api-key', { user, role, body: { apiKey: '   ' } });
    assert.equal(res.status, 400, role);
    assert.equal(res.body.error?.code, 'INVALID_API_KEY', role);
  }
});
