/**
 * removed-harness-hidden.acceptance.test.ts — ADR-229, stage S0 (acceptance first).
 *
 * The owner's decision: the Kimi, Qwen Code and Hermes HARNESSES (bodies) are
 * removed. Their old conversations disappear from every list a member sees, at
 * READ time only — no row is deleted or rewritten. Opening one of them answers
 * a typed `provider_removed`, never a crash or a 400. What stays alive:
 *   - kimi as an ENGINE of the Claude body (catalog + key status);
 *   - kimi and qwen as isolated key slots (KNOWN_PROVIDERS, cost rows);
 *   - cursor and agy/gemini conversations stay visible;
 *   - project delete and membership revocation still see EVERY row, hidden
 *     ones included (they clean up and tear down; hiding must not orphan data).
 *
 * Tests marked `[guard]` pass today and must keep passing after removal. Every
 * other test fails today because the hidden conversations are still listed or
 * still opened.
 *
 * It lives at the server root because it crosses the database, projects,
 * providers and websocket modules on purpose (the module boundary lint forbids
 * that from inside `server/modules/<name>/`).
 *
 * Runner:
 *   TMPDIR=/var/tmp bash scripts/run-without-core.sh \
 *     node scripts/run-isolated-node-tests.mjs server server/removed-harness-hidden.acceptance.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  starredSessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';
import {
  getArchivedProjectsWithSessions,
  getProjectSessionsPage,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { applySubscriptionAmountVisibility } from '@/modules/providers/services/cost/subscription-visibility.js';
import { vendorHarnesses } from '@/modules/providers/services/cost/model-vendor.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  appendVendorTranscriptTurn,
  writeVendorTranscriptMeta,
} from '@/modules/providers/shared/vendor/vendor-transcript.js';
import { revokeProjectLiveAccess } from '@/modules/websocket/services/project-membership-revocation.service.js';
import { KNOWN_PROVIDERS } from '@/services/isolation/known-providers.js';
import { AppError } from '@/shared/utils.js';

import { PROVIDER_REMOVED_CODE } from '../shared/retiredProviders.js';
import { sessionBucketKey } from '../shared/sessionBuckets.js';

/** The removed harnesses whose conversations are hidden. */
const HIDDEN = ['kimi', 'qwen', 'hermes'] as const;
/** Controls that must stay visible. `gemini` has no payload bucket, so it is checked on row reads only. */
const VISIBLE = ['cursor', 'antigravity', 'gemini'] as const;
const VISIBLE_WITH_BUCKET = ['cursor', 'antigravity'] as const;
const ALL = [...HIDDEN, ...VISIBLE] as const;
type Provider = (typeof ALL)[number];

/** Visible rows are older; hidden rows are newer, so "newest"/"latest" reads expose a leak. */
const VISIBLE_CREATED = '2026-11-01T10:00:00.000Z';
const HIDDEN_CREATED = '2026-11-10T10:00:00.000Z';

let counter = 0;
const nextId = (): string => `00000229-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

type Project = { projectId: string; projectPath: string; ids: Record<Provider, string> };

let server: Server;
let baseUrl = '';
let requesterId = 0;
let active: Project;
let archivedSessions: Project;
let archivedProject: Project;

const hiddenIds = (project: Project): string[] => HIDDEN.map((provider) => project.ids[provider]);
const visibleIds = (project: Project): string[] => VISIBLE.map((provider) => project.ids[provider]);

async function newProject(name: string): Promise<Omit<Project, 'ids'>> {
  const projectPath = path.join(os.homedir(), `adr229-${name}`);
  await fs.mkdir(projectPath, { recursive: true });
  const created = projectsDb.createProjectPath(projectPath, null, requesterId).project;
  assert.ok(created, `${name}: project row created`);
  return { projectId: created.project_id, projectPath: created.project_path };
}

/** One native session row per provider (participant recorded, so the B-29 filter keeps it). */
function seedSessions(projectPath: string, label: string, archived = false): Record<Provider, string> {
  const ids = {} as Record<Provider, string>;
  for (const provider of ALL) {
    const id = nextId();
    const at = (HIDDEN as readonly string[]).includes(provider) ? HIDDEN_CREATED : VISIBLE_CREATED;
    sessionsDb.createSession(id, provider, projectPath, `${label} ${provider}`, at, at);
    participantsDb.recordSpawn(id, requesterId);
    if (archived) sessionsDb.updateSessionIsArchived(id, true);
    ids[provider] = id;
  }
  return ids;
}

const sessionRowCount = (): number =>
  Number((getConnection().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count);

/** Every session id in every provider bucket of a project payload. */
function bucketedIds(payload: unknown): string[] {
  const record = payload as Record<string, unknown>;
  const ids: string[] = [];
  for (const value of Object.values(record)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const id = (item as { id?: unknown })?.id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

function assertHiddenAbsentVisiblePresent(listed: string[], project: Project, label: string, expectVisible: readonly Provider[]): void {
  for (const provider of HIDDEN) {
    assert.equal(listed.includes(project.ids[provider]), false, `${label}: ${provider} conversation is hidden`);
  }
  for (const provider of expectVisible) {
    assert.equal(listed.includes(project.ids[provider]), true, `${label}: ${provider} conversation stays visible`);
  }
}

type ApiResponse = { status: number; raw: string; body: Record<string, unknown> };

async function call(method: string, routePath: string): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}/api/providers${routePath}`, { method });
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { body = {}; }
  return { status: response.status, raw, body };
}

before(async () => {
  closeConnection();
  await initializeDatabase();
  requesterId = userDb.createUser('adr229-owner', 'hash', 'owner').id;

  const activeBase = await newProject('active');
  active = { ...activeBase, ids: seedSessions(activeBase.projectPath, 'active') };
  archivedSessions = { ...activeBase, ids: seedSessions(activeBase.projectPath, 'archived', true) };
  for (const id of Object.values(active.ids)) starredSessionsDb.star(requesterId, id, 'adr229-active');

  const archivedBase = await newProject('archived-project');
  archivedProject = { ...archivedBase, ids: seedSessions(archivedBase.projectPath, 'in archived project') };
  projectsDb.updateProjectIsArchivedById(archivedBase.projectId, true);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: Record<string, unknown> }).user = {
      id: requesterId, role: 'owner', status: 'active', is_active: 1,
      authenticationKind: 'session', authorizationGeneration: 1,
    };
    (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  for (const project of [active, archivedProject]) {
    if (project) await fs.rm(project.projectPath, { recursive: true, force: true });
  }
});

describe('(a) [guard] kimi stays a live engine of the Claude body', () => {
  it('[guard] GET /kimi/models answers the kimi catalog', async () => {
    const response = await call('GET', '/kimi/models');
    assert.equal(response.status, 200, response.raw);
    const data = response.body.data as { provider?: string; models?: { OPTIONS?: Array<{ value?: string }> } } | undefined;
    assert.equal(data?.provider, 'kimi');
    const options = data?.models?.OPTIONS ?? [];
    assert.ok(options.some((option) => option.value === 'kimi-k3'), `the catalog lists kimi-k3: ${response.raw}`);
  });

  it('[guard] GET /kimi/auth/status answers a key-based status', async () => {
    const response = await call('GET', '/kimi/auth/status');
    assert.equal(response.status, 200, response.raw);
    const data = response.body.data as { provider?: string; authenticated?: unknown } | undefined;
    assert.equal(data?.provider, 'kimi');
    assert.equal(typeof data?.authenticated, 'boolean', response.raw);
  });
});

describe('(b) [guard] kimi and qwen stay isolated key slots with visible cost rows', () => {
  it('[guard] both stay in KNOWN_PROVIDERS', () => {
    assert.ok((KNOWN_PROVIDERS as readonly string[]).includes('kimi'));
    assert.ok((KNOWN_PROVIDERS as readonly string[]).includes('qwen'));
  });

  it('[guard] a member still sees their own Kimi (moonshot) and qwen cost rows', () => {
    const rows = ['moonshot', 'kimi', 'qwen'].map((provider) => ({ provider, available: true, totalUsd: 4.2, sessions: 3 }));
    const visible = applySubscriptionAmountVisibility(rows, 'user', { vendorHarnesses });
    for (const row of visible) {
      assert.equal(row.available, true, `${row.provider}: not redacted`);
      assert.equal(row.totalUsd, 4.2, `${row.provider}: amount kept`);
    }
  });
});

describe('(c) hidden conversations are absent from every list; the rows stay', () => {
  let rowsBefore = 0;
  before(() => { rowsBefore = sessionRowCount(); });

  it('the project session list (sidebar payload) hides kimi, qwen, hermes; keeps cursor and agy', async () => {
    const page = await getProjectSessionsPage(active.projectId, { currentUserId: requesterId });
    assertHiddenAbsentVisiblePresent(bucketedIds(page), active, 'project page', VISIBLE_WITH_BUCKET);
    for (const provider of HIDDEN) {
      const bucket = (page as unknown as Record<string, unknown>)[sessionBucketKey(provider)];
      assert.ok(bucket === undefined || (Array.isArray(bucket) && bucket.length === 0), `${provider}: bucket empty`);
    }
  });

  it('the anonymous project page (no user) hides them too', async () => {
    const page = await getProjectSessionsPage(active.projectId, { currentUserId: null });
    assertHiddenAbsentVisiblePresent(bucketedIds(page), active, 'anonymous page', VISIBLE_WITH_BUCKET);
  });

  it('starred lists hide them even when starred', () => {
    const starred = sessionsDb.getStarredSessionsByProjectPathForUser(requesterId, active.projectPath)
      .map((row) => row.session_id);
    assertHiddenAbsentVisiblePresent(starred, active, 'starred by project', VISIBLE);
    const accessible = starredSessionsDb.listAccessibleStarredSessions(requesterId).map((row) => row.sessionId);
    assertHiddenAbsentVisiblePresent(accessible, active, 'accessible stars', VISIBLE);
  });

  it('every native-predicate read (page, unstarred page, counts, newest) excludes them', () => {
    const page = sessionsDb.getSessionsByProjectPathPage(active.projectPath, 100, 0).map((row) => row.session_id);
    assertHiddenAbsentVisiblePresent(page, active, 'page', VISIBLE);
    assert.equal(sessionsDb.countSessionsByProjectPath(active.projectPath), VISIBLE.length, 'count');

    for (const id of visibleIds(active)) starredSessionsDb.unstar(requesterId, id);
    for (const id of hiddenIds(active)) starredSessionsDb.unstar(requesterId, id);
    try {
      const unstarred = sessionsDb.getUnstarredSessionsByProjectPathPageForUser(requesterId, active.projectPath, 100, 0)
        .map((row) => row.session_id);
      assertHiddenAbsentVisiblePresent(unstarred, active, 'unstarred page', VISIBLE);
      assert.equal(
        sessionsDb.countUnstarredSessionsByProjectPathForUser(requesterId, active.projectPath), VISIBLE.length, 'unstarred count',
      );
    } finally {
      for (const id of Object.values(active.ids)) starredSessionsDb.star(requesterId, id, 'adr229-active');
    }

    const newest = sessionsDb.getNewestSessionCreatedAtByProjectPath(active.projectPath);
    assert.equal(newest === null ? null : new Date(newest).toISOString(), VISIBLE_CREATED,
      'the project date comes from the newest VISIBLE conversation');
  });

  it('the archived conversations list hides them', () => {
    const listed = sessionsService.listArchivedSessions(requesterId)
      .map((item) => (item as unknown as { sessionId?: string; id?: string; session_id?: string }))
      .map((item) => item.sessionId ?? item.id ?? item.session_id ?? '');
    assertHiddenAbsentVisiblePresent(listed, archivedSessions, 'archived list', VISIBLE);
  });

  it('an archived project lists only the visible conversations', async () => {
    const projects = await getArchivedProjectsWithSessions({ skipSynchronization: true, currentUserId: requesterId });
    const project = projects.find((item) => item.projectId === archivedProject.projectId);
    assert.ok(project, 'the archived project is listed');
    assertHiddenAbsentVisiblePresent(bucketedIds(project), archivedProject, 'archived project', VISIBLE_WITH_BUCKET);
  });

  it('[guard] hiding writes nothing: the session row count is unchanged after every read', () => {
    assert.equal(sessionRowCount(), rowsBefore);
    for (const id of [...hiddenIds(active), ...hiddenIds(archivedSessions), ...hiddenIds(archivedProject)]) {
      assert.ok(sessionsDb.getSessionById(id), `row ${id} still exists`);
    }
  });

  it('[guard] membership revocation still tears down every session, hidden ones included', () => {
    let revoked: string[] = [];
    revokeProjectLiveAccess(
      { projectId: active.projectId, projectPath: active.projectPath, userId: requesterId, stillHasAccess: false },
      {
        clients: [], refreshPresence: () => {}, terminateShells: () => 0, listRunningSessionIds: () => [],
        revokeInternalChat: (_userId, sessionIds) => { revoked = sessionIds; return 0; },
      },
    );
    for (const id of [...Object.values(active.ids), ...Object.values(archivedSessions.ids)]) {
      assert.ok(revoked.includes(id), `revocation sees ${id}`);
    }
  });
});

describe('(d) opening a hidden conversation answers provider_removed', () => {
  const SECRET = 'adr229 transcript text that must not be served';

  before(async () => {
    for (const provider of ['qwen', 'hermes'] as const) {
      const sessionId = active.ids[provider];
      await writeVendorTranscriptMeta(provider, sessionId, active.projectPath, SECRET);
      await appendVendorTranscriptTurn(provider, sessionId, active.projectPath, 'user', SECRET);
      await appendVendorTranscriptTurn(provider, sessionId, active.projectPath, 'assistant', SECRET);
    }
  });

  for (const provider of HIDDEN) {
    it(`${provider}: the history service resolves with provider_removed (no throw, no transcript)`, async () => {
      let result: unknown;
      try {
        result = await sessionsService.fetchHistory(active.ids[provider], requesterId);
      } catch (error) {
        assert.fail(`fetchHistory threw ${(error as AppError)?.code ?? String(error)} instead of classifying`);
      }
      const json = JSON.stringify(result);
      assert.ok(json.includes(PROVIDER_REMOVED_CODE), `classified provider_removed: ${json.slice(0, 300)}`);
      assert.equal(json.includes(SECRET), false, 'no transcript text is served');
    });

    it(`${provider}: the history route answers provider_removed, never a 400 or 5xx`, async () => {
      const response = await call('GET', `/sessions/${active.ids[provider]}/messages`);
      assert.ok(response.status !== 400 && response.status < 500, `status ${response.status}: ${response.raw}`);
      assert.ok(response.raw.includes(PROVIDER_REMOVED_CODE), `carries provider_removed: ${response.raw.slice(0, 300)}`);
      assert.equal(response.raw.includes(SECRET), false, 'no transcript text is served');
    });
  }

  it('[guard] a cursor conversation still opens (empty store) over the history route', async () => {
    const response = await call('GET', `/sessions/${active.ids.cursor}/messages`);
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.raw.includes(PROVIDER_REMOVED_CODE), false);
  });
});

describe('(c) [guard] project force-delete still sees the hidden rows', () => {
  it('[guard] every hidden row\'s recorded transcript is considered for removal, and all rows go', async () => {
    const base = await newProject('delete');
    const ids = seedSessions(base.projectPath, 'delete');
    const transcriptDir = path.join(os.homedir(), 'adr229-delete-transcripts');
    await fs.mkdir(transcriptDir, { recursive: true });
    for (const provider of HIDDEN) {
      const file = path.join(transcriptDir, `${ids[provider]}.jsonl`);
      await fs.writeFile(file, '{}\n', 'utf8');
      getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(file, ids[provider]);
    }

    const outcome = await deleteOrArchiveProject(base.projectId, true);
    const summary = outcome.transcripts ?? { removed: 0, keptForSafety: 0, failed: 0 };
    assert.equal(summary.removed + summary.keptForSafety + summary.failed, HIDDEN.length,
      `each hidden transcript reached the removal step: ${JSON.stringify(summary)}`);
    for (const id of Object.values(ids)) assert.equal(sessionsDb.getSessionById(id), null, `row ${id} deleted`);
    await fs.rm(transcriptDir, { recursive: true, force: true });
    await fs.rm(base.projectPath, { recursive: true, force: true });
  });
});
