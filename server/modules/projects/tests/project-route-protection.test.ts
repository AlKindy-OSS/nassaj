/* eslint-disable boundaries/dependencies, boundaries/no-unknown -- route inventory intentionally mounts every server module. */
/**
 * ADR-172 P1-1 — dynamic route-protection probe.
 *
 * Mounts the project-bearing routers exactly as server/index.js does, enumerates
 * EVERY registered route with the shared walker (listExpressRoutes, the same
 * traversal the update-lease installer uses) and, with PROJECT_MEMBERSHIP_ENFORCE
 * on, sends each project-scoped route a request from a NON-member carrying the
 * project id in params, query AND body. Exit criteria: zero unclassified routes
 * and zero 2xx answers for project-scoped routes.
 *
 * Per-route comparison (qa #8): for every `project` route the CREATOR must get
 * through (not 403/404) and the NON-member must get 403/404. A 400 counts as a
 * refusal only when the route carries an explicit `allow400` reason; a creator
 * refusal is tolerated only with an explicit `creatorDenied` reason.
 *
 * Routers NOT mounted, with the reason (index.js wires them with closures):
 *  - /api/agent: API-key principal (x-api-key), not a JWT user — covered by
 *    server/routes/agent.git-transport.test.ts.
 *  - /api/assistant-images: its session→roots resolver is an inline closure in
 *    index.js (isSessionAccessibleByUser); a copy here would test the copy.
 *  - auth/admin/settings/user/system/terminals/voice/credential-grants/github/
 *    governance: no project context (admin-only or self-scoped).
 *
 * Routes registered inline in server/index.js cannot be probed dynamically
 * (importing index.js boots the server); they are covered statically: every
 * inline route with `:projectId` OR reading a project from query/body must
 * pass through a guard, or be listed in INLINE_EXEMPT with a reason.
 *
 * Maintenance: a new route fails `every route is classified` until it is added
 * to project-route-classification.json. Run with ADR172_DISCOVER=1 to print the
 * observed status of every route.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  auditLogDb,
  canAccessProject,
  canAccessRegisteredProjectPath,
  closeConnection,
  getConnection,
  initializeDatabase,
  isProjectMembershipEnforced,
  projectsDb,
  scheduledMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { isSessionWritableByUser } from '@/modules/websocket/services/chat-websocket.service.js';
import { AppError } from '@/shared/utils.js';

import { listExpressRoutes } from '../../../services/update-writer-lease.js';

type Classification = Record<string, {
  class: 'project' | 'global';
  reason?: string;
  /** Why a 400 (input validation before the gate) is an acceptable refusal here. */
  allow400?: string;
  /** Why the creator is also refused by this generic probe (e.g. needs a real resource). */
  creatorDenied?: string;
}>;
type TestUser = { id: number; role: string; username: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFICATION_FILE = path.join(HERE, 'project-route-classification.json');
const INDEX_SOURCE = fs.readFileSync(path.join(HERE, '../../../index.js'), 'utf8');
const REFUSAL = new Set([403, 404]);

let server: Server;
let baseUrl = '';
let app: express.Express;
let currentUser: TestUser | null = null;
let stranger: TestUser;
let creator: TestUser;
let projectId = '';
let projectPath = '';
const SESSION_ID = 'adr172-probe-session-0001';

async function mountRouters(target: express.Express): Promise<void> {
  const load = async (specifier: string) => (await import(specifier)).default;
  target.use('/api/projects', await load('../projects.routes.js'));
  target.use('/api/projects', await load('../project-stats.routes.js'));
  target.use('/api/sessions', await load('../../providers/participants.routes.js'));
  target.use('/api/git', await load('../../../routes/git.js'));
  target.use('/api/project-board', await load('../../../routes/project-board.js'));
  target.use('/api/commands', await load('../../../routes/commands.js'));
  target.use('/api/cursor', await load('../../../routes/cursor.js'));
  target.use('/api/gemini', await load('../../../routes/gemini.js'));
  target.use('/api/workflow-supervisor', await load('../../workflow-supervisor/launch.route.js'));
  target.use('/api/providers', await load('../../providers/provider.routes.js'));
  target.use('/api/references', await load('../../reference-materials/index.js'));
  target.use('/api/connectors', (await import('../../connectors/index.js')).connectorsRoutes);
  const scheduled = await import('../../scheduled-messages/index.js');
  target.use('/api/scheduled-messages', scheduled.createScheduledMessagesRouter(
    scheduled.createScheduledMessagesService({
      repository: scheduledMessagesDb,
      getActiveUser: (userId: number) => userDb.getUserById(userId),
      sessionExists: (sessionId: string) => Boolean(sessionsDb.getSessionById(sessionId)),
      canWriteSession: (sessionId: string, userId: number) => isSessionWritableByUser(sessionId, userId),
      audit: () => {},
      dispatch: async () => ({ ok: false }),
    } as never),
  ));
  const { createChatImagesRouter } = await import('../../../routes/chat-images.js');
  target.use('/api/chat-images', createChatImagesRouter({ authenticateToken: (_q: unknown, _s: unknown, next: () => void) => next() }));
  const { createDocumentSharesRouter } = await import('../../../routes/document-shares.js');
  const { createDocumentSharesStore } = await import('../../database/document-shares.js');
  target.use('/api', createDocumentSharesRouter({
    getStore: () => createDocumentSharesStore(getConnection()),
    verifyUser: () => (currentUser ? { ...currentUser, status: 'active' } : null),
    isMember: (root: string, id: number) => canAccessRegisteredProjectPath(root, id),
    canManageProject: (pid: string, id: number) => isProjectMembershipEnforced() && canAccessProject(pid, id),
    audit: (action: never, userId: number) => auditLogDb.record(action, { userId }),
  }));
}

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

/** Fills every :param with the fixture value most likely to reach the guard. */
function materialize(routePath: string): string {
  return routePath.replace(/:([A-Za-z_]+)(\([^)]*\))?\??/g, (_m, name: string) => {
    if (/^project(Id|Name)?$/.test(name)) return encodeURIComponent(projectId);
    if (/session/i.test(name)) return SESSION_ID;
    if (name === "provider") return "claude";
    return 'probe';
  });
}

async function probe(method: string, routePath: string, user: TestUser = stranger): Promise<number> {
  currentUser = user;
  const query = new URLSearchParams({
    project: projectId, projectId, projectName: projectId, projectPath, path: projectPath, cwd: projectPath,
    workspacePath: projectPath, projectRoot: projectPath, root: projectPath,
    sessionId: SESSION_ID,
  });
  const body = {
    project: projectId, projectId, projectName: projectId, projectPath, path: projectPath, cwd: projectPath,
    workspacePath: projectPath, projectRoot: projectPath, root: projectPath,
    sessionId: SESSION_ID, message: 'probe', command: 'probe', file: 'probe.txt', files: ['probe.txt'],
  };
  const response = await fetch(`${baseUrl}${materialize(routePath)}?${query.toString()}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer probe' },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

before(async () => {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  closeConnection();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr172-probe-'));
  process.env.WORKSPACES_ROOT = root;
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();

  creator = userDb.createUser('probe_creator', 'hash', 'user') as TestUser;
  stranger = userDb.createUser('probe_stranger', 'hash', 'user') as TestUser;
  projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  projectId = projectsDb.createProjectPath(projectPath, 'Probe', creator.id).project?.project_id ?? '';
  sessionsDb.createSession(SESSION_ID, 'claude', projectPath, 'Probe session');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    // authenticateToken installs this identity fence (ecfdc7db5); the stub principal is current.
    (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
    next();
  });
  await mountRouters(app);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  delete process.env.WORKSPACES_ROOT;
});

test('every registered route is classified (new unclassified route fails)', () => {
  const classification = JSON.parse(fs.readFileSync(CLASSIFICATION_FILE, 'utf8')) as Classification;
  const keys = listExpressRoutes(app).map(routeKey);
  assert.ok(keys.length > 50, `walker found ${keys.length} routes`);
  const unclassified = keys.filter((key) => !(key in classification));
  assert.deepEqual(unclassified, [], 'classify these routes in project-route-classification.json');
});

test('per route: creator gets through, non-member gets 403/404 (enforcement on)', async () => {
  const classification = JSON.parse(fs.readFileSync(CLASSIFICATION_FILE, 'utf8')) as Classification;
  const problems: string[] = [];
  const seen = new Set<string>();
  const discover = process.env.ADR172_DISCOVER === '1';
  for (const route of listExpressRoutes(app)) {
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = classification[key];
    if (!discover && entry?.class !== 'project') continue;
    const strangerStatus = await probe(route.method, route.path, stranger);
    const creatorStatus = await probe(route.method, route.path, creator);
    if (discover) {
      console.log(`DISCOVER\t${strangerStatus}\t${creatorStatus}\t${key}`);
      continue;
    }
    const refused = REFUSAL.has(strangerStatus) || (strangerStatus === 400 && Boolean(entry.allow400));
    if (!refused) problems.push(`${key}: non-member got ${strangerStatus}`);
    if (REFUSAL.has(creatorStatus) && !entry.creatorDenied) {
      problems.push(`${key}: creator also refused (${creatorStatus}) — the probe proves nothing`);
    }
  }
  assert.deepEqual(problems, []);
});

/** Inline index.js routes that take no project although the scan matches them. */
const INLINE_EXEMPT: Record<string, string> = {
  'GET /api/browse-filesystem': 'filesystem picker for creating projects; owner/admin-scoped browse roots',
  'POST /api/create-folder': 'creates a folder for a NEW project (creation flow)',
  'GET /avatars/:userId.:ext': 'public user avatar; matched only via the next route\'s comment',
  'GET /project-logos/:projectId.:ext': 'public, unauthenticated project logo image (like avatars)',
};

test('inline index.js routes taking a project (param, query or body) pass a guard', () => {
  const registration = /^app\.(get|post|put|patch|delete)\('([^']+)'/gm;
  const takesProject = /:projectId|req\.(query|body)(\.|\?\.)(project|projectId|projectPath|projectName|cwd)\b|\{[^}]*\b(projectPath|projectName|projectId)\b[^}]*\}\s*=\s*req\.(query|body)/;
  const guard = /assertProjectVisible|isProjectVisible|isProjectWritableByUser|assertProjectWritable|resolveProjectPathForWrite|resolveVisibleProject|isProjectPathVisibleToUser|isSessionAccessibleByUser/;
  const matches = [...INDEX_SOURCE.matchAll(registration)];
  assert.ok(matches.length >= 20, `found ${matches.length} inline routes`);
  const unguarded: string[] = [];
  let projectRoutes = 0;
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? start + 6000;
    let body = INDEX_SOURCE.slice(start, Math.min(end, start + 6000));
    // A registration delegating to a named handler (`..., uploadFilesHandler);`)
    // is checked through that handler's own body.
    const named = /,\s*([A-Za-z]+Handler)\);/.exec(body.slice(0, 400));
    if (named) {
      const definition = INDEX_SOURCE.indexOf(`const ${named[1]} =`);
      body = definition >= 0 ? INDEX_SOURCE.slice(definition, definition + 6000) : body;
    }
    const key = `${match[1].toUpperCase()} ${match[2]}`;
    if (!takesProject.test(body) || key in INLINE_EXEMPT) return;
    projectRoutes += 1;
    if (!guard.test(body)) unguarded.push(key);
  });
  assert.ok(projectRoutes >= 10, `only ${projectRoutes} inline project routes detected`);
  assert.deepEqual(unguarded, []);
});

test('control: with enforcement OFF the same probe reaches handlers (ADR-089 unchanged)', async () => {
  const classification = JSON.parse(fs.readFileSync(CLASSIFICATION_FILE, 'utf8')) as Classification;
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '0';
  try {
    const reached: string[] = [];
    for (const [key, entry] of Object.entries(classification)) {
      if (entry.class !== 'project' || !key.startsWith('GET ')) continue;
      const status = await probe('GET', key.slice(4));
      if (status >= 200 && status < 300) reached.push(key);
    }
    // The probe is only meaningful if, without enforcement, it gets through.
    assert.ok(reached.length >= 5, `only ${reached.length} GET routes reached with the flag off`);
  } finally {
    process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  }
});

/** Sends a real request with a VALID payload and returns its status. */
async function send(method: string, url: string, user: TestUser, body?: unknown): Promise<number> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer probe' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

/** A fresh project owned by `creator` — the per-route probe mutates the shared one. */
let freshProject: { id: string; path: string } | null = null;
function ensureFreshProject(): { id: string; path: string } {
  if (!freshProject) {
    const dir = fs.mkdtempSync(path.join(path.dirname(projectPath), 'fresh-'));
    const id = projectsDb.createProjectPath(dir, 'Fresh', creator.id).project?.project_id ?? '';
    freshProject = { id, path: dir };
  }
  return freshProject;
}

test('qa م3: creator and member (non-participants) read a real session; strangers and removed launchers do not', async () => {
  const { id: projectId, path: projectPath } = ensureFreshProject();
  const member = userDb.createUser('probe_member', 'hash', 'user') as TestUser;
  const launcher = userDb.createUser('probe_removed_launcher', 'hash', 'user') as TestUser;
  getConnection().prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')")
    .run(projectId, member.id);
  const sessionId = 'adr172-real-transcript-0001';
  const transcript = path.join(projectPath, `${sessionId}.jsonl`);
  const line = (role: string, text: string, uuid: string) => JSON.stringify({
    type: role, uuid, sessionId, cwd: projectPath, timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }] },
  });
  fs.writeFileSync(transcript, `${line('user', 'hello', 'u1')}\n${line('assistant', 'hi there', 'a1')}\n`);
  sessionsDb.createSession(sessionId, 'claude', projectPath, 'Real', undefined, undefined, transcript);
  getConnection().prepare("INSERT INTO session_participants (session_id, user_id, attribution) VALUES (?, ?, 'spawn')")
    .run(sessionId, launcher.id);

  const reads = [`/api/providers/sessions/${sessionId}/messages`, `/api/sessions/${sessionId}/participants`];
  const observed: Record<string, number[]> = {};
  for (const url of reads) {
    observed[url] = [await send('GET', url, creator), await send('GET', url, member),
      await send('GET', url, stranger), await send('GET', url, launcher)];
  }
  for (const url of reads) {
    const [c, m, st, l] = observed[url];
    assert.equal(c, 200, `creator reads ${url}`);
    assert.equal(m, 200, `member reads ${url}`);
    assert.equal(st, 404, `stranger refused ${url}`);
    assert.equal(l, 404, `launcher without membership refused ${url}`);
  }
});

test('qa م3: allow400 routes with VALID payloads — creator passes the gate, non-member is refused', async () => {
  const { path: projectPath } = ensureFreshProject();
  const sessionId = 'adr172-real-transcript-0001';
  const commandFile = path.join(projectPath, '.claude', 'commands', 'probe.md');
  fs.mkdirSync(path.dirname(commandFile), { recursive: true });
  fs.writeFileSync(commandFile, 'probe command');
  const execute = { commandName: 'probe', commandPath: commandFile, context: { projectPath } };
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const scheduled = { sessionId, content: 'later', scheduledFor: future, options: {} };

  const results: Record<string, [number, number]> = {
    'POST /api/commands/execute': [
      await send('POST', '/api/commands/execute', creator, execute),
      await send('POST', '/api/commands/execute', stranger, execute)],
    'PUT /api/providers/sessions/:sessionId': [
      await send('PUT', `/api/providers/sessions/${sessionId}`, creator, { summary: 'renamed' }),
      await send('PUT', `/api/providers/sessions/${sessionId}`, stranger, { summary: 'renamed' })],
    'POST /api/scheduled-messages/': [
      await send('POST', '/api/scheduled-messages/', creator, scheduled),
      await send('POST', '/api/scheduled-messages/', stranger, scheduled)],
  };
  console.log('VALIDPAYLOAD', JSON.stringify(results));
  for (const [key, [creatorStatus, strangerStatus]] of Object.entries(results)) {
    assert.ok(creatorStatus < 300, `${key}: creator got ${creatorStatus}`);
    assert.ok(REFUSAL.has(strangerStatus), `${key}: non-member got ${strangerStatus}`);
  }
});

test('qa م3: bulk, scheduled PATCH and workflow launch with VALID payloads', async () => {
  const { path: projectPath } = ensureFreshProject();
  const sessionId = 'adr172-real-transcript-0001';
  const bulk = { ids: [sessionId], action: 'close' };
  currentUser = stranger;
  const strangerBulk = await fetch(`${baseUrl}/api/providers/sessions/bulk`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bulk),
  });
  const strangerBulkBody = await strangerBulk.json() as { data?: { results?: Array<{ success: boolean; error?: { code?: string } }> } };
  // Bulk answers 200 with a per-item verdict; the item itself must be refused (404-equivalent).
  const item = strangerBulkBody.data?.results?.[0];
  assert.equal(item?.success, false, 'non-member cannot act on the session in bulk');
  assert.equal(item?.error?.code, 'SESSION_NOT_FOUND');

  currentUser = creator;
  const created = await fetch(`${baseUrl}/api/scheduled-messages/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content: 'later', scheduledFor: new Date(Date.now() + 7_200_000).toISOString(), options: {} }),
  });
  const createdBody = await created.json() as Record<string, any>;
  const scheduledId = createdBody?.data?.id ?? createdBody?.id ?? createdBody?.message?.id;
  assert.ok(scheduledId, `scheduled id in ${JSON.stringify(createdBody)}`);
  const patch = { content: 'edited', scheduledFor: new Date(Date.now() + 7_300_000).toISOString(), options: {} };
  assert.ok(REFUSAL.has(await send('PATCH', `/api/scheduled-messages/${scheduledId}`, stranger, patch)));
  assert.ok((await send('PATCH', `/api/scheduled-messages/${scheduledId}`, creator, patch)) < 300);

  // Non-member only: a creator launch would spawn a real background run.
  const launch = { projectPath, scriptOrPrompt: 'noop', conversationId: sessionId, originMessageId: 'probe-origin-1' };
  assert.ok(REFUSAL.has(await send('POST', '/api/workflow-supervisor/launch', stranger, launch)));
});

test('qa ن2: session search with a valid term — members see the project, others see nothing', async () => {
  const { id: freshId, path: freshPath } = ensureFreshProject();
  const searchAs = async (user: TestUser): Promise<string> => {
    currentUser = user;
    const response = await fetch(`${baseUrl}/api/providers/search/sessions?q=hello&limit=20`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const member = userDb.getUserByUsername('probe_member') as unknown as TestUser;
  const launcher = userDb.getUserByUsername('probe_removed_launcher') as unknown as TestUser;
  const sees = (stream: string) => stream.includes(freshPath) || stream.includes(freshId)
    || stream.includes('adr172-real-transcript-0001');
  const creatorStream = await searchAs(creator);
  assert.match(creatorStream, /event: done/);
  assert.ok(sees(creatorStream), 'creator finds the session');
  assert.ok(sees(await searchAs(member)), 'member finds the session');
  assert.ok(!sees(await searchAs(stranger)), 'stranger sees nothing from the project');
  assert.ok(!sees(await searchAs(launcher)), 'launcher without membership sees nothing');
});
