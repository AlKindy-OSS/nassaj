/**
 * B-823: the Claude branch of GET /api/projects/:projectId/sessions/:sessionId/token-usage.
 *
 * The unit test next door proves the resolver; this proves the WIRING — that the
 * route actually asks the resolver instead of re-deriving the path from the
 * project, and that swapping the source of truth from a visibility-checked
 * project to a session row did not widen the endpoint.
 *
 * HARNESS: index.js is the process entry point (it calls startServer() at module
 * scope) and the handler is an unexported inline arrow, so it can be neither
 * imported nor re-implemented without testing a copy of itself — the synthetic
 * fixture trap. Following server/index.security.test.js, the REAL source text of
 * the handler is extracted from index.js and evaluated with its collaborators
 * injected: the bytes under test are the bytes that ship, and the real resolver
 * and real fs run underneath. Reverting the route reverts this test to red.
 *
 * Scratch lives under /var/tmp — never /tmp, which is tmpfs on this host.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fsPromises, { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  latestClaudeTokenUsage,
  claudeContextSnapshot,
  latestClaudeCacheTtlMinutes,
  readClaudeTranscriptForSession,
} from '@/modules/providers/list/claude/claude-token-usage.js';

const INDEX_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../index.js',
);
const INDEX_SOURCE = readFileSync(INDEX_PATH, 'utf8');

const ROUTE_MARKER = "app.get('/api/projects/:projectId/sessions/:sessionId/token-usage'";
const SCRATCH_ROOT = '/var/tmp';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_PATH = '/var/tmp/x/repo';
const OVERLAY_PATH = `${PROJECT_PATH}/.git/nassaj-session-overlays/instances/abc/workspace`;
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const encode = (value: string) => value.replace(/[^a-zA-Z0-9-]/g, '-');

/** Slice a balanced `{...}` block starting at the first `{` at/after `from`. */
function sliceBalancedBlock(source: string, from: number): string {
  const start = source.indexOf('{', from);
  assert.notStrictEqual(start, -1, 'expected a block to extract');
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced block while extracting handler source');
}

/** The real `async (req, res) => {...}` registered at `ROUTE_MARKER`. */
function extractRouteHandler(): string {
  const at = INDEX_SOURCE.indexOf(ROUTE_MARKER);
  assert.notStrictEqual(at, -1, `${ROUTE_MARKER} not found in index.js`);
  const arrow = 'async (req, res) => {';
  const arrowAt = INDEX_SOURCE.indexOf(arrow, at);
  assert.notStrictEqual(arrowAt, -1, 'handler arrow not found');
  return `async (req, res) => ${sliceBalancedBlock(INDEX_SOURCE, arrowAt + arrow.length - 1)}`;
}

/** Minimal express-style response double that records exactly what was sent. */
function makeResponseDouble() {
  const sent: Array<{ status: number; payload: unknown }> = [];
  const res = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      sent.push({ status: res.statusCode, payload });
      return res;
    },
  };
  return { res, sent };
}

type Collaborators = {
  projectPathById: string | null;
  sessionRow: Record<string, unknown> | null;
  visible?: boolean;
};

function buildHandler(collaborators: Collaborators) {
  const handlerSrc = extractRouteHandler();

  // Sanity: the route must delegate, not re-derive the transcript path.
  assert.ok(
    handlerSrc.includes('readClaudeTranscriptForSession'),
    'token-usage handler must read the transcript through the race-safe helper',
  );
  assert.ok(
    !handlerSrc.includes("path.join(homeDir, '.claude', 'projects'"),
    'token-usage handler must not re-derive the Claude projects path',
  );

  const factory = new Function(
    'os', 'path', 'fsPromises', 'projectsDb', 'sessionsDb', 'isProjectVisible',
    'coerceUserId', 'readClaudeTranscriptForSession', 'latestClaudeTokenUsage',
    'resolveContextWindow', 'console', 'claudeContextSnapshot', 'latestClaudeCacheTtlMinutes',
    `return ${handlerSrc};`,
  );

  return factory(
    os,
    path,
    fsPromises,
    { getProjectPathById: async () => collaborators.projectPathById },
    { getSessionById: () => collaborators.sessionRow },
    () => collaborators.visible !== false,
    (id: unknown) => id ?? null,
    readClaudeTranscriptForSession,
    latestClaudeTokenUsage,
    () => 1_000_000,
    console,
    claudeContextSnapshot,
    latestClaudeCacheTtlMinutes,
  );
}

type Fixture = {
  overlayTranscript: string;
  cleanup: () => Promise<void>;
};

/**
 * An overlay-shaped tree: the transcript lives under the OVERLAY-encoded
 * directory, and nothing exists under the project-encoded one.
 */
async function buildFixture(): Promise<Fixture> {
  const base = await realpath(await mkdtemp(path.join(SCRATCH_ROOT, 'claude-token-usage-')));
  const home = path.join(base, 'home');
  const overlayDir = path.join(base, 'core', 'projects', encode(OVERLAY_PATH));

  await mkdir(overlayDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await symlink(path.join(base, 'core'), path.join(home, '.claude'));

  // A provider-shaped synthetic tail: the last assistant entry is the one that counts.
  const overlayTranscript = path.join(overlayDir, `${SESSION_ID}.jsonl`);
  await writeFile(
    overlayTranscript,
    `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`
      + `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 7159,
            cache_read_input_tokens: 246337,
            output_tokens: 971,
          },
        },
      })}\n`,
  );

  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;

  return {
    overlayTranscript,
    cleanup: async () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await buildFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  params: { projectId: PROJECT_ID, sessionId: SESSION_ID },
  query: { provider: 'claude' },
  user: { id: 1 },
  ...overrides,
});

test('answers 200 with cache-aware usage for an overlay-backed Claude session', async () => {
  await withFixture(async (fixture) => {
    const handler = buildHandler({
      projectPathById: PROJECT_PATH,
      sessionRow: {
        session_id: SESSION_ID,
        provider: 'claude',
        project_path: PROJECT_PATH,
        jsonl_path: fixture.overlayTranscript,
      },
    });
    const { res, sent } = makeResponseDouble();

    await handler(request(), res);

    assert.equal(sent[0].payload.cacheSnapshot?.transport, 'history');
    assert.equal(sent[0].payload.cacheSnapshot?.sessionId, SESSION_ID);
    delete sent[0].payload.cacheSnapshot;
    assert.deepStrictEqual(sent, [{
      status: 200,
      payload: {
        used: null,
        total: null,
        contextSnapshot: { ...claudeContextSnapshot(null, { sessionId: SESSION_ID, modelId: 'claude-opus-5' }, 253498), observedAt: null },
        cacheTtlMinutes: null,
        inputTokens: 253498,
        outputTokens: 971,
        breakdown: {
          input: 253498,
          output: 971,
          cacheRead: 246337,
          cacheCreation: 7159,
        },
      },
    }]);
  });
});

test('answers 404 without echoing a path when no transcript resolves', async () => {
  await withFixture(async () => {
    const handler = buildHandler({
      projectPathById: PROJECT_PATH,
      sessionRow: {
        session_id: SESSION_ID,
        provider: 'claude',
        project_path: PROJECT_PATH,
        jsonl_path: '/var/tmp/does-not-exist.jsonl',
      },
    });
    const { res, sent } = makeResponseDouble();

    await handler(request(), res);

    assert.deepStrictEqual(sent, [{
      status: 404,
      payload: { error: 'Session file not found', reason: 'transcript_unavailable' },
    }]);
  });
});

test('refuses a session that belongs to a different project', async () => {
  await withFixture(async (fixture) => {
    const handler = buildHandler({
      projectPathById: PROJECT_PATH,
      sessionRow: {
        session_id: SESSION_ID,
        provider: 'claude',
        project_path: '/var/tmp/x/other-repo',
        jsonl_path: fixture.overlayTranscript,
      },
    });
    const { res, sent } = makeResponseDouble();

    await handler(request(), res);

    assert.deepStrictEqual(sent, [{ status: 404, payload: { error: 'Session not found' } }]);
  });
});

test('keeps the project-visibility gate ahead of the session lookup', async () => {
  await withFixture(async (fixture) => {
    const handler = buildHandler({
      projectPathById: PROJECT_PATH,
      sessionRow: {
        session_id: SESSION_ID,
        provider: 'claude',
        project_path: PROJECT_PATH,
        jsonl_path: fixture.overlayTranscript,
      },
      visible: false,
    });
    const { res, sent } = makeResponseDouble();

    await handler(request(), res);

    assert.deepStrictEqual(sent, [{ status: 404, payload: { error: 'Project not found' } }]);
  });
});
