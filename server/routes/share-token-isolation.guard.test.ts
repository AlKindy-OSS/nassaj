/**
 * ADR-205 D1 point 2: `X-Share-Token` is honoured only by the share readers.
 *
 * 1. Static guard: no server source outside the allow-list names the header.
 *    The allow-list is the three readers the ADR names (live guest routes,
 *    legacy snapshot reader, document-share reader) plus the shared guest
 *    authorization module both session-share readers call.
 * 2. Differential sweep: the routers are mounted in the server/index.js
 *    order with the REAL authentication middleware; every registered route
 *    outside the allow-list is called twice, with and without a VALID live
 *    share token, and must answer the same status and body. Anonymous calls
 *    cover every method (a guest holds only the token); member calls cover
 *    every GET (the token must not widen a member either).
 *    Inline server/index.js routes cannot be mounted (importing index.js boots
 *    the server); the static guard covers them.
 */
// FIRST import — HOME becomes a /var/tmp sandbox before any provider root is computed.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';

import {
  closeConnection, createSessionSharesStore, getConnection, initializeDatabase, projectsDb, userDb,
} from '@/modules/database/index.js';

import { listExpressRoutes } from '../services/update-writer-lease.js';
import { createShareId, createShareToken, hashShareToken } from '../services/share-capability.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_MENTIONS = new Set(['routes/share-view.js', 'routes/session-shares.js', 'routes/document-shares.js',
  'services/share-guest-access.js']);
/** Routes owned by the allow-listed readers (their own tests cover them). */
const ALLOW_LISTED_ROUTE = /^\/api\/(?:document-shares(?:\/|$)|share-view\/)/;
/** Session-share management sits behind a function mount the walker cannot enter; listed explicitly. */
const MANAGEMENT_ROUTES = [
  ['POST', '/api/sessions/:sessionId/shares/preview'], ['POST', '/api/sessions/:sessionId/shares'],
  ['GET', '/api/sessions/:sessionId/shares'], ['GET', '/api/sessions/:sessionId/shares/eligibility'],
  ['GET', '/api/sessions/:sessionId/shares/status'], ['GET', '/api/session-shares/mine'],
  ['POST', '/api/session-shares/:id/revoke'],
].map(([method, routePath]) => ({ method, path: routePath }));

/** Every route the sweep covers. */
const sweptRoutes = () => [...listExpressRoutes(app).filter((route) => !ALLOW_LISTED_ROUTE.test(route.path)), ...MANAGEMENT_ROUTES];

let server: Server;
let baseUrl = '';
let app: express.Express;
let liveToken = '';
let liveId = '';
let memberBearer = '';
let scratchRoot = '';

/** Every non-test source file under server/, relative to it. */
function sourceFiles(dir = SERVER, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '__tests__', '__fixtures__', 'tests', 'dist'].includes(entry.name)) continue;
      out.push(...sourceFiles(path.join(dir, entry.name), relative));
    } else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

async function mountLikeIndex(target: express.Express): Promise<void> {
  const auth = await import('../middleware/auth.js');
  const { createSessionShareRuntime } = await import('../services/session-share-runtime.js');
  const { createDocumentShareVerifier } = await import('../services/document-share-auth.js');
  const { createSessionShareManagementMount } = await import('./session-shares.js');
  const { createDocumentSharesMount, createDocumentSharesRouter } = await import('./document-shares.js');
  const { createDocumentSharesStore } = await import('../modules/database/document-shares.js');
  const runtime = createSessionShareRuntime({ verifyUser: createDocumentShareVerifier(userDb, auth.JWT_SECRET),
    audit: () => {}, writer: (_q: unknown, _s: unknown, next: () => void) => next(), withWriter: async (op: () => unknown) => op(),
    publicOrigin: 'https://nassaj.example', deviceCookieName: '__Host-nassaj_device', deviceCookiesEnabled: () => false });
  target.use(runtime.publicHandler);
  target.use(runtime.shareViewHandler);
  target.use(cors({ origin: (_origin, callback) => callback(null, false) }));
  target.use(express.json());
  const documentRouter = createDocumentSharesRouter({ getStore: () => createDocumentSharesStore(getConnection()),
    verifyUser: createDocumentShareVerifier(userDb, auth.JWT_SECRET), isMember: () => false });
  target.use('/api', createDocumentSharesMount(documentRouter, { authenticateToken: auth.authenticateToken,
    deviceIdentity: auth.authenticateDeviceCookieIfPresent }));
  target.use('/api', createSessionShareManagementMount(
    (req: express.Request, res: express.Response, next: express.NextFunction) => runtime.managementRouter(req, res, next),
    auth.authenticateDeviceCookieIfPresent));
  target.use('/api', auth.validateApiKey);
  await mountProtected(target, auth.authenticateToken);
}

/** The authenticated routers, as server/index.js mounts them behind authenticateToken. */
async function mountProtected(target: express.Express, authenticateToken: express.RequestHandler): Promise<void> {
  const load = async (specifier: string) => (await import(specifier)).default;
  target.use('/api/projects', authenticateToken, await load('../modules/projects/projects.routes.js'));
  target.use('/api/projects', authenticateToken, await load('../modules/projects/project-stats.routes.js'));
  target.use('/api/sessions', authenticateToken, await load('../modules/providers/participants.routes.js'));
  target.use('/api/git', authenticateToken, await load('./git.js'));
  target.use('/api/project-board', authenticateToken, await load('./project-board.js'));
  target.use('/api/commands', authenticateToken, await load('./commands.js'));
  target.use('/api/cursor', authenticateToken, await load('./cursor.js'));
  target.use('/api/workflow-supervisor', authenticateToken, await load('../modules/workflow-supervisor/launch.route.js'));
  target.use('/api/providers', authenticateToken, await load('../modules/providers/provider.routes.js'));
  target.use('/api/references', authenticateToken, await load('../modules/reference-materials/index.js'));
  target.use('/api/connectors', authenticateToken, (await import('../modules/connectors/index.js')).connectorsRoutes);
  const { createChatImagesRouter } = await import('./chat-images.js');
  target.use('/api/chat-images', createChatImagesRouter({ authenticateToken }));
}

/** Fills every :param with a plausible value. */
const materialize = (routePath: string) => routePath.replace(/:([A-Za-z_]+)(\([^)]*\))?\??/g, (_m, name: string) =>
  (/session/i.test(name) ? 'isolation-session' : name === 'id' ? liveId : 'probe'));

async function call(method: string, routePath: string, headers: Record<string, string>): Promise<string> {
  const response = await fetch(`${baseUrl}${materialize(routePath)}`, {
    method, headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.77', ...headers },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({ probe: true }),
    signal: AbortSignal.timeout(15_000),
  });
  return `${response.status} ${await response.text()}`;
}

before(async () => {
  closeConnection();
  const root = fs.mkdtempSync('/var/tmp/share-token-isolation-');
  scratchRoot = root;
  process.env.WORKSPACES_ROOT = root;
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();
  const member = userDb.createUser('isolation_member', 'hash', 'user') as { id: number };
  const row = userDb.getUserById(member.id) as { password_changed_at: number; authorization_generation: number };
  const auth = await import('../middleware/auth.js');
  memberBearer = `Bearer ${jwt.sign({ userId: member.id, pwd_iat: row.password_changed_at, auth_gen: row.authorization_generation },
    auth.JWT_SECRET, { expiresIn: '1h' })}`;
  const projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  const projectId = projectsDb.createProjectPath(projectPath, 'Isolation', member.id).project?.project_id ?? '';
  liveToken = createShareToken();
  liveId = createShareId();
  createSessionSharesStore(getConnection()).insertLiveWithinCaps({ id: liveId, session_id: 'isolation-session',
    project_id: projectId, owner_user_id: member.id, token_hash: hashShareToken(liveToken), created_by: member.id,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ref_key: Buffer.alloc(32, 7) });
  app = express();
  await mountLikeIndex(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.WORKSPACES_ROOT;
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

test('static guard: only the allow-listed readers name X-Share-Token anywhere in server/', () => {
  const offenders = sourceFiles().filter((file) => !ALLOWED_MENTIONS.has(file)
    && /x-share-token/i.test(fs.readFileSync(path.join(SERVER, file), 'utf8')));
  assert.deepEqual(offenders, []);
  const reads = (file: string) => /req\.(?:get|header)\(\s*['"]x-share-token['"]|headers\[\s*['"]x-share-token['"]\s*\]/i
    .test(fs.readFileSync(path.join(SERVER, file), 'utf8'));
  assert.deepEqual([...ALLOWED_MENTIONS].filter(reads).sort(), ['routes/document-shares.js', 'services/share-guest-access.js'],
    'the header is read in exactly two places: the shared session-share guest check and the document-share reader');
  const index = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  assert.ok(index.indexOf('app.use(sessionShareRuntime.shareViewHandler)') < index.indexOf('app.use(cors('),
    'the guest routes are mounted before cors()');
  assert.ok(index.indexOf('app.use(sessionShareRuntime.shareViewHandler)') < index.indexOf("app.use('/api', validateApiKey)"),
    'and before every authentication layer');
});

test('control: the token is valid where it is meant to be (the guest routes accept it)', async () => {
  assert.match(await call('GET', `/api/share-view/${liveId}/meta`, { 'X-Share-Token': 'W'.repeat(43) }), /^404 /);
  const response = await call('GET', `/api/share-view/${liveId}/meta`, { 'X-Share-Token': liveToken });
  assert.doesNotMatch(response, /^(?:401|403) /, 'the live token passes verification on its own route');
});

test('differential sweep: a valid live token changes nothing on any other route (anonymous, every method)', async () => {
  const routes = sweptRoutes();
  assert.ok(routes.length > 50, `walker found ${routes.length} routes`);
  const differences: string[] = [];
  for (const route of routes) {
    const without = await call(route.method, route.path, {});
    const withToken = await call(route.method, route.path, { 'X-Share-Token': liveToken });
    if (without !== withToken) differences.push(`${route.method} ${route.path}: ${without.slice(0, 80)} vs ${withToken.slice(0, 80)}`);
  }
  assert.deepEqual(differences, []);
});

test('differential sweep: the token never widens a member either (every GET with a member JWT)', async () => {
  const routes = sweptRoutes().filter((route) => route.method === 'GET');
  const differences: string[] = [];
  for (const route of routes) {
    const without = await call('GET', route.path, { Authorization: memberBearer });
    const withToken = await call('GET', route.path, { Authorization: memberBearer, 'X-Share-Token': liveToken });
    if (without !== withToken) differences.push(`GET ${route.path}: ${without.slice(0, 80)} vs ${withToken.slice(0, 80)}`);
  }
  assert.deepEqual(differences, []);
});
