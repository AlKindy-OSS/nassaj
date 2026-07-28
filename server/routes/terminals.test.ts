/**
 * terminals.test.ts — T-938 (ADR-063): REST contract tests for
 * /api/terminals over the REAL router + registry (node-pty, the isolation
 * seams and the database barrel module-mocked; a real express server drives
 * true status codes, mirroring system.restart.role-gate.test.ts).
 *
 * Proves the wire contract:
 *   - POST → 201 with the PTY already spawned; GET lists ONLY the caller's
 *     terminals, createdAt ascending; the terminal object never carries userId.
 *   - Foreign PATCH/DELETE → 404 with a body IDENTICAL to a nonexistent id
 *     (no existence oracle, never 403).
 *   - The 6th running terminal → 409 terminal_limit_reached; deleting one
 *     reopens the slot.
 *   - A nonexistent cwd and a KNOWN private project invisible to the caller
 *     → the IDENTICAL 400 invalid_cwd body (fail-indistinguishable).
 *   - Validation: invalid_title / invalid_initial_command with the
 *     {"error","code"} envelope; DELETE → 204 and kills the PTY.
 *
 * Auth note: authenticateToken is mounted in server/index.js (out of scope
 * here); the test app injects req.user the same way the middleware does.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

// --- Module mocks (before importing the router) -------------------------------

type FakePty = {
  killed: number;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

const spawnCalls: { fake: FakePty }[] = [];

mock.module('node-pty', {
  defaultExport: {
    spawn: () => {
      const fake: FakePty = {
        killed: 0,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {
          this.killed += 1;
        },
      };
      spawnCalls.push({ fake });
      return fake;
    },
  },
});

mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (
      _userId: unknown,
      _provider: string,
      baseEnv: Record<string, string>
    ) => ({ ...baseEnv }),
  },
});

mock.module('@/services/isolation/provider-cage-wiring.js', {
  namedExports: {
    resolveCagedLaunch: (spec: { cmd: string; args?: string[] }) => ({
      cmd: spec.cmd,
      args: spec.args ?? [],
    }),
  },
});

const registeredProjects = new Map<string, { project_id: string }>();
let visibleResult = true;
mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: (projectPath: string) => registeredProjects.get(projectPath) ?? null,
      isProjectVisibleToUser: () => visibleResult,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const { default: terminalsRouter } = await import('./terminals.js');
const registry = await import('../services/standalone-terminals/standalone-terminal-registry.js');

// --- Test server ----------------------------------------------------------------

let currentUserId: number | null = 1;

async function buildServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentUserId !== null) {
      (req as express.Request & { user: unknown }).user = { id: currentUserId, role: 'user' };
    }
    next();
  });
  app.use('/api/terminals', terminalsRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const request = async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* 204 has no body */
    }
    return { status: res.status, json };
  };

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { request, close };
}

function resetAll(): void {
  registry.resetStandaloneTerminalsForTest();
  spawnCalls.length = 0;
  registeredProjects.clear();
  visibleResult = true;
  currentUserId = 1;
}

function makeTempCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type TerminalBody = { terminal: Record<string, unknown> };
type ListBody = { terminals: Record<string, unknown>[] };

// --- criterion 1: ownership over REST ---------------------------------------------

test('POST→GET shows a running record to its owner only; foreign PATCH/DELETE are 404', async () => {
  resetAll();
  const cwd = makeTempCwd('term-rest-own-');
  const srv = await buildServer();
  try {
    currentUserId = 1;
    const created = await srv.request('POST', '/api/terminals', { title: '  My Term  ', cwd });
    assert.equal(created.status, 201);
    const terminal = (created.json as TerminalBody).terminal;
    assert.equal(terminal.title, 'My Term');
    assert.equal(terminal.status, 'running');
    assert.ok(!('userId' in terminal), 'the wire terminal never carries userId');
    assert.equal(spawnCalls.length, 1, 'the PTY spawned during POST, before any WS attach');

    const mine = await srv.request('GET', '/api/terminals');
    assert.equal(mine.status, 200);
    assert.equal((mine.json as ListBody).terminals.length, 1);
    assert.equal((mine.json as ListBody).terminals[0].id, terminal.id);

    // Another user: list empty; PATCH/DELETE answer EXACTLY like nonexistent.
    currentUserId = 2;
    const theirs = await srv.request('GET', '/api/terminals');
    assert.deepEqual((theirs.json as ListBody).terminals, [], "foreign GET doesn't show it");

    const foreignPatch = await srv.request('PATCH', `/api/terminals/${terminal.id}`, {
      title: 'hijack',
    });
    const missingPatch = await srv.request('PATCH', '/api/terminals/term_none', {
      title: 'hijack',
    });
    assert.equal(foreignPatch.status, 404);
    assert.deepEqual(foreignPatch.json, missingPatch.json, 'no existence oracle');
    assert.deepEqual(foreignPatch.json, { error: 'Terminal not found', code: 'not_found' });

    const foreignDelete = await srv.request('DELETE', `/api/terminals/${terminal.id}`);
    assert.equal(foreignDelete.status, 404);

    // Owner: rename 200, delete 204 (kills the PTY), then an empty list.
    currentUserId = 1;
    const renamed = await srv.request('PATCH', `/api/terminals/${terminal.id}`, {
      title: 'Renamed',
    });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.json as TerminalBody).terminal.title, 'Renamed');

    const deleted = await srv.request('DELETE', `/api/terminals/${terminal.id}`);
    assert.equal(deleted.status, 204);
    assert.equal(spawnCalls[0].fake.killed, 1, 'DELETE killed the live PTY');
    const after = await srv.request('GET', '/api/terminals');
    assert.deepEqual((after.json as ListBody).terminals, []);
  } finally {
    await srv.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- criterion 2: running limit ------------------------------------------------------

test('the 6th running terminal is 409; deleting one reopens the slot', async () => {
  resetAll();
  const cwd = makeTempCwd('term-rest-limit-');
  const srv = await buildServer();
  try {
    currentUserId = 5;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await srv.request('POST', '/api/terminals', { cwd });
      assert.equal(created.status, 201, `terminal ${i + 1} creates fine`);
      ids.push((created.json as TerminalBody).terminal.id as string);
    }

    const sixth = await srv.request('POST', '/api/terminals', { cwd });
    assert.equal(sixth.status, 409);
    assert.equal((sixth.json as { code: string }).code, 'terminal_limit_reached');

    const freed = await srv.request('DELETE', `/api/terminals/${ids[0]}`);
    assert.equal(freed.status, 204);
    const again = await srv.request('POST', '/api/terminals', { cwd });
    assert.equal(again.status, 201, 'deleting one reopens the slot');

    // GET stays createdAt-ascending (stable creation order).
    const list = await srv.request('GET', '/api/terminals');
    assert.deepEqual(
      (list.json as ListBody).terminals.slice(0, 4).map((t) => t.id),
      ids.slice(1),
      'ascending creation order preserved after the delete'
    );
  } finally {
    await srv.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- criterion 7: cwd indistinguishability over REST -----------------------------------

test('nonexistent cwd and invisible private-project cwd return the IDENTICAL 400 body', async () => {
  resetAll();
  const privateDir = makeTempCwd('term-rest-priv-');
  const srv = await buildServer();
  try {
    currentUserId = 7;
    const missing = await srv.request('POST', '/api/terminals', {
      cwd: '/nonexistent-terminals-route-test-dir',
    });
    assert.equal(missing.status, 400);

    registeredProjects.set(privateDir, { project_id: 'proj-x' });
    visibleResult = false;
    const invisible = await srv.request('POST', '/api/terminals', { cwd: privateDir });
    assert.equal(invisible.status, 400);

    assert.deepEqual(missing.json, invisible.json, 'byte-identical bodies — no oracle');
    assert.deepEqual(missing.json, { error: 'Invalid working directory', code: 'invalid_cwd' });
    assert.equal(spawnCalls.length, 0, 'nothing spawned on refusal');

    // The same directory, visible ⇒ 201 (the gate, not the path, refused it).
    visibleResult = true;
    const visible = await srv.request('POST', '/api/terminals', { cwd: privateDir });
    assert.equal(visible.status, 201);
  } finally {
    await srv.close();
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});

// --- validation envelope -----------------------------------------------------------------

test('validation failures use the {"error","code"} envelope', async () => {
  resetAll();
  const cwd = makeTempCwd('term-rest-val-');
  const srv = await buildServer();
  try {
    currentUserId = 9;
    const badTitle = await srv.request('POST', '/api/terminals', { title: '', cwd });
    assert.equal(badTitle.status, 400);
    assert.equal((badTitle.json as { code: string }).code, 'invalid_title');

    const badCmd = await srv.request('POST', '/api/terminals', {
      cwd,
      initialCommand: 'x'.repeat(4097),
    });
    assert.equal(badCmd.status, 400);
    assert.equal((badCmd.json as { code: string }).code, 'invalid_initial_command');

    const relativeCwd = await srv.request('POST', '/api/terminals', { cwd: 'not/absolute' });
    assert.equal(relativeCwd.status, 400);
    assert.equal((relativeCwd.json as { code: string }).code, 'invalid_cwd');

    // PATCH validation: a non-string/empty title is invalid_title on an OWNED id.
    const created = await srv.request('POST', '/api/terminals', { cwd });
    const id = (created.json as TerminalBody).terminal.id;
    const badRename = await srv.request('PATCH', `/api/terminals/${id}`, { title: '' });
    assert.equal(badRename.status, 400);
    assert.equal((badRename.json as { code: string }).code, 'invalid_title');
  } finally {
    await srv.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
