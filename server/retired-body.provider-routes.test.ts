/**
 * retired-body.provider-routes.test.ts — T-1953 (ADR-192).
 *
 * `cursor`, `hermes`, `qwen` and `kimi` are retired AS BODIES. On
 * `/api/providers/<id>/...` that means:
 *
 *   - every route that configures or drives the body answers the typed 400
 *     `provider_removed` — never a 5xx, and never the old behaviour;
 *   - the surfaces where the same id has a live non-body meaning keep working:
 *     kimi is an engine (catalog + key status) and a key slot, qwen is a key slot;
 *   - historical cursor conversations stay listable and open; since ADR-229 S3
 *     those of hermes, qwen and kimi are hidden from every list (rows kept).
 *
 * The router runs behind a header-less stand-in for `authenticateToken`, against
 * the case-local database and HOME the test runner provides. History fixtures
 * are written by the SAME writers the run seams call (`writeVendorTranscriptMeta`,
 * `appendVendorTranscriptTurn`), not hand-built.
 *
 * It lives at the server root, not inside a module, because it crosses three
 * modules and `server/shared` on purpose (the module boundary lint forbids that
 * from inside `server/modules/<name>/`).
 *
 * Runner: node:test (`npm run test:server -- <this file>`).
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
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { getProjectSessionsPage } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import {
  appendVendorTranscriptTurn,
  writeVendorTranscriptMeta,
} from '@/modules/providers/shared/vendor/vendor-transcript.js';
import { AppError } from '@/shared/utils.js';

import { PROVIDER_REMOVED_CODE, RETIRED_PROVIDER_IDS, isHiddenHistoryProvider } from '../shared/retiredProviders.js';
import { sessionBucketKey } from '../shared/sessionBuckets.js';

/** The four bodies this step retires. The id retired by T-1853 is no longer parseable at all. */
const RETIRED_BODIES = ['cursor', 'hermes', 'qwen', 'kimi'] as const;
type RetiredBody = (typeof RETIRED_BODIES)[number];

const SESSION_ID: Record<RetiredBody, string> = {
  cursor: '00000001-0000-4000-8000-0000000000c1',
  hermes: '00000001-0000-4000-8000-0000000000e1',
  qwen: '00000001-0000-4000-8000-0000000000f1',
  kimi: '00000001-0000-4000-8000-0000000000a1',
};

let server: Server;
let baseUrl = '';
let requesterId = 0;
let projectPath = '';
let projectId = '';

type HistoryMessage = { role?: string; content?: string };
type ApiBody = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  /** The history route streams `{ messages, total }` without the success envelope. */
  messages?: HistoryMessage[];
};
type ApiResponse = { status: number; body: ApiBody };

async function call(method: string, routePath: string, body?: unknown): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}/api/providers${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as ApiBody : {} };
}

function assertProviderRemoved(response: ApiResponse, label: string): void {
  assert.equal(response.status, 400, `${label}: typed 400, got ${response.status} ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error?.code, PROVIDER_REMOVED_CODE, `${label}: carries the provider_removed code`);
}

before(async () => {
  closeConnection();
  await initializeDatabase();
  // An owner, so a refusal below is never explained by a role gate instead.
  requesterId = userDb.createUser('retired-body-owner', 'hash', 'owner').id;

  projectPath = path.join(os.homedir(), 'retired-body-project');
  await fs.mkdir(projectPath, { recursive: true });
  projectId = projectsDb.createProjectPath(projectPath, null, requesterId).project.project_id;

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
  await fs.rm(projectPath, { recursive: true, force: true });
});

describe('the list under test', () => {
  it('holds the four bodies and neither glm nor deepseek', () => {
    for (const provider of RETIRED_BODIES) assert.equal(RETIRED_PROVIDER_IDS.has(provider), true, provider);
    // Retiring these two is an open owner decision: their refusal would run
    // before the GLM carrier bypass and the hosted-supervision bypass.
    assert.equal(RETIRED_PROVIDER_IDS.has('glm'), false);
    assert.equal(RETIRED_PROVIDER_IDS.has('deepseek'), false);
  });
});

describe('body-only routes answer provider_removed for every retired body', () => {
  const sessionRoute = (provider: RetiredBody) => `/${provider}/sessions/${SESSION_ID[provider]}/active-model`;
  const bodyRoutes = (provider: RetiredBody): Array<[string, string, unknown?]> => [
    ['GET', `/${provider}/governance`],
    ['POST', `/${provider}/governance/link`, {}],
    ['GET', sessionRoute(provider)],
    ['POST', sessionRoute(provider), { model: 'any-model' }],
    ['DELETE', sessionRoute(provider)],
    ['GET', `/${provider}/skills`],
    ['POST', `/${provider}/skills`, { entries: [{ content: '# skill' }] }],
    ['DELETE', `/${provider}/skills/some-skill`],
    ['GET', `/${provider}/mcp/servers`],
    ['GET', `/${provider}/mcp/servers/inventory`],
    ['POST', `/${provider}/mcp/servers`, { name: 'srv', transport: 'stdio', command: 'true' }],
    ['DELETE', `/${provider}/mcp/servers/srv`],
  ];

  for (const provider of RETIRED_BODIES) {
    it(`${provider}: governance, session model pin, skills and MCP are refused`, async () => {
      for (const [method, routePath, body] of bodyRoutes(provider)) {
        assertProviderRemoved(await call(method, routePath, body), `${method} ${routePath}`);
      }
    });
  }
});

describe('catalog and key-status routes: live only for a retired body that is an engine', () => {
  for (const provider of ['cursor', 'hermes', 'qwen'] as const) {
    it(`${provider}: models and auth/status are refused`, async () => {
      assertProviderRemoved(await call('GET', `/${provider}/models`), `GET /${provider}/models`);
      assertProviderRemoved(await call('GET', `/${provider}/auth/status`), `GET /${provider}/auth/status`);
    });
  }

  it('kimi: the engine catalog and key status still answer 200', async () => {
    const models = await call('GET', '/kimi/models');
    assert.equal(models.status, 200, JSON.stringify(models.body));
    assert.equal(models.body.data?.provider, 'kimi');
    const status = await call('GET', '/kimi/auth/status');
    assert.equal(status.status, 200, JSON.stringify(status.body));
  });
});

describe('key routes: live only for a retired body that still owns a key slot', () => {
  for (const provider of ['cursor', 'hermes'] as const) {
    it(`${provider}: every api-key route is refused`, async () => {
      const keyRoute = `/${provider}/api-key`;
      assertProviderRemoved(await call('GET', keyRoute), `GET ${keyRoute}`);
      // `placeholder-` prefix: the leak gate's own allowlisted placeholder shape,
      // so the value stays an obvious non-secret without needing a gate exemption.
      assertProviderRemoved(await call('POST', keyRoute, { apiKey: 'placeholder-retired-body-key' }), `POST ${keyRoute}`);
      assertProviderRemoved(await call('PUT', keyRoute, { apiKey: 'placeholder-retired-body-key' }), `PUT ${keyRoute}`);
      assertProviderRemoved(await call('DELETE', keyRoute), `DELETE ${keyRoute}`);
      assertProviderRemoved(await call('GET', `${keyRoute}/capability`), `GET ${keyRoute}/capability`);
    });
  }

  for (const provider of ['kimi', 'qwen'] as const) {
    it(`${provider}: the key slot status and capability still answer 200`, async () => {
      const status = await call('GET', `/${provider}/api-key`);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.body.data?.configured, false);
      const capability = await call('GET', `/${provider}/api-key/capability`);
      assert.equal(capability.status, 200, JSON.stringify(capability.body));
    });
  }
});

describe('ids outside the retired list are unaffected', () => {
  it('an unknown id and the id deleted by T-1853 keep UNSUPPORTED_PROVIDER', async () => {
    const deletedEarlier = [...RETIRED_PROVIDER_IDS].filter(
      (id) => !(RETIRED_BODIES as readonly string[]).includes(id),
    );
    assert.equal(deletedEarlier.length, 1);
    for (const provider of ['nonsense', ...deletedEarlier]) {
      const response = await call('GET', `/${provider}/governance`);
      assert.equal(response.status, 400);
      assert.equal(response.body.error?.code, 'UNSUPPORTED_PROVIDER', provider);
    }
  });

  it('a live body is not refused on a body route', async () => {
    const response = await call('GET', '/claude/governance');
    assert.equal(response.status, 200, JSON.stringify(response.body));
  });
});

describe('historical conversations: cursor stays listable, the removed harnesses are hidden', () => {
  const PROMPT: Record<RetiredBody, string> = {
    cursor: 'cursor prompt', hermes: 'hermes prompt', qwen: 'qwen prompt', kimi: 'kimi prompt',
  };
  const REPLY: Record<RetiredBody, string> = {
    cursor: 'cursor reply', hermes: 'hermes reply', qwen: 'qwen reply', kimi: 'kimi reply',
  };

  /** Writes one turn the way that body's run seam wrote it. Cursor has no nassaj-owned writer. */
  async function writeTranscript(provider: RetiredBody): Promise<void> {
    const sessionId = SESSION_ID[provider];
    if (provider === 'cursor') return;
    // hermes-cli.js / qwen-cli.js / the kimi agent launcher (all removed, ADR-229)
    // wrote a meta line, then the turn; the shared vendor writer stands in here.
    await writeVendorTranscriptMeta(provider, sessionId, projectPath, PROMPT[provider]);
    await appendVendorTranscriptTurn(provider, sessionId, projectPath, 'user', PROMPT[provider]);
    await appendVendorTranscriptTurn(provider, sessionId, projectPath, 'assistant', REPLY[provider]);
  }

  before(async () => {
    for (const provider of RETIRED_BODIES) {
      sessionsDb.createSession(SESSION_ID[provider], provider, projectPath, `${provider} conversation`);
      participantsDb.recordSpawn(SESSION_ID[provider], requesterId);
      await writeTranscript(provider);
    }
  });

  it('cursor is listed in its own bucket; hermes, qwen and kimi are hidden (ADR-229)', async () => {
    const page = await getProjectSessionsPage(projectId, { currentUserId: requesterId }) as unknown as
      Record<string, Array<{ id: string }> | undefined>;
    for (const provider of RETIRED_BODIES) {
      const listed = (page[sessionBucketKey(provider)] ?? []).some((session) => session.id === SESSION_ID[provider]);
      assert.equal(listed, !isHiddenHistoryProvider(provider), `${provider}: listed only when not hidden`);
      assert.ok(sessionsDb.getSessionById(SESSION_ID[provider]), `${provider}: the row stays`);
    }
  });

  // ADR-229 deleted the qwen (S1), hermes and kimi (S2) readers; opening their
  // conversations is the provider_removed contract of
  // removed-harness-hidden.acceptance.test.ts (d).

  it('cursor: the history route is not refused (its store is the external CLI\'s and is empty here)', async () => {
    const response = await call('GET', `/sessions/${SESSION_ID.cursor}/messages`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.messages, []);
  });
});
