/**
 * claude-sdk.side-query.test.ts — T-881 (/btw read-only side query).
 *
 * Proves the hard gates the design review (qa-critic) attached to "البديل 2"
 * (SDK fork), driving the REAL spawnClaudeSideQuery with ONLY the Agent SDK
 * `query` module-mocked (no real Claude Code child is spawned):
 *
 *   (a·C2) a /btw query enters NOTHING into activeSessions — neither the live
 *          session id nor the fork id — before, DURING, or after the run, so the
 *          drain count / ghost-detach / mirror fan-out never see it; and it never
 *          appends to the original `<liveSid>.jsonl` (asserted structurally via
 *          the SDK options: forkSession:true routes writes to a NEW id and
 *          persistSession:false writes nothing at all — a bare resume is refused).
 *   (C1)   the fork is resume + forkSession:true (never a bare resume).
 *   (C3)   disallowedTools blocks Write/Edit/NotebookEdit/Bash and the run never
 *          uses bypassPermissions — a read-only query.
 *   (B-171) a PreToolUse hook re-enforces the read-only project-root confinement
 *          ABOVE the SDK permission-rule engine, so a broad settings
 *          `permissions.allow` rule (e.g. Read(/etc/**)) cannot short-circuit to
 *          ALLOW and bypass the canUseTool cage (T-920).
 *   (C4)   an optional upToMessageId is forwarded as SDK resumeSessionAt.
 *   + streaming: assistant text → onChunk, then onComplete; error/resume-missing
 *          results map to the sdk_error / session_not_found codes.
 *
 * Runner: node:test with --experimental-test-module-mocks (no vitest). The SDK
 * mock MUST be registered before importing the module-under-test, hence the
 * dynamic import below.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test, { mock, beforeEach, afterEach } from 'node:test';

type SdkMessage = Record<string, unknown>;

// --- Agent SDK mock ----------------------------------------------------------
// `query(arg)` records the constructed arg and returns an async-iterable that
// yields the scripted messages, exposing interrupt() for teardown. `onYield`
// lets a test observe state (e.g. activeSessions) DURING the stream.
let scriptedMessages: SdkMessage[] = [];
let lastQueryArg: { prompt?: unknown; options?: Record<string, unknown> } | null = null;
let interruptCount = 0;
let onYield: (() => void) | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { prompt?: unknown; options?: Record<string, unknown> }) => {
      lastQueryArg = arg;
      const messages = scriptedMessages;
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) {
            onYield?.();
            yield m;
          }
        },
        interrupt: async () => {
          interruptCount += 1;
        },
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    // Stubs so claude-sdk.js's transitive import graph (vendor-delegate-mcp.js)
    // instantiates. They are never invoked in these tests (no vendor delegation).
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  spawnClaudeSideQuery: (
    params: Record<string, unknown>,
    callbacks: {
      onStarted?: (handle: { interrupt: () => void }) => void;
      onChunk?: (text: string) => void;
      onError?: (code: string, message: string) => void;
      onComplete?: (fullAnswer: string) => void;
    }
  ) => Promise<void>;
  getActiveClaudeSDKSessions: () => string[];
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
};

const LIVE_SID = 'live-session-uuid-1111';
const FORK_SID = 'forked-session-uuid-9999';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'NASSAJ_PROVIDER_CAGE',
] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';

beforeEach(() => {
  scriptedMessages = [];
  lastQueryArg = null;
  interruptCount = 0;
  onYield = null;

  // Hermetic env: no competitor base URL / token, cage OFF, and an EMPTY claude
  // config dir so the real settings-env guards read nothing (degrade-safe → inert)
  // instead of the operator's real ~/.claude.
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.NASSAJ_PROVIDER_CAGE;
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

test('T-881(a/C1/C2/C3/C4): fork isolation, no activeSessions registration, read-only, streamed', async () => {
  scriptedMessages = [
    {
      type: 'assistant',
      session_id: FORK_SID,
      message: { content: [{ type: 'text', text: 'The build script is npm run build:server.' }] },
    },
    {
      type: 'result',
      session_id: FORK_SID,
      subtype: 'success',
      is_error: false,
      result: 'The build script is npm run build:server.',
    },
  ];

  // Precondition: the live session is not registered as active in this test scope.
  assert.ok(!sdk.getActiveClaudeSDKSessions().includes(LIVE_SID), 'liveSid absent before the run');

  // C2 (mid-stream): assert on EVERY yielded message that neither id is registered.
  onYield = () => {
    const active = sdk.getActiveClaudeSDKSessions();
    assert.ok(!active.includes(LIVE_SID), 'liveSid never registered mid-stream');
    assert.ok(!active.includes(FORK_SID), 'fork id never registered mid-stream');
  };

  const chunks: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  let completed = false;

  await sdk.spawnClaudeSideQuery(
    {
      sessionId: LIVE_SID,
      question: 'what is the build script?',
      upToMessageId: 'msg-uuid-42',
      userId: null,
      cwd: process.cwd(),
    },
    {
      onChunk: (t) => chunks.push(t),
      onError: (code, message) => errors.push({ code, message }),
      onComplete: () => {
        completed = true;
      },
    }
  );

  assert.ok(lastQueryArg, 'the SDK query was constructed');
  const opts = lastQueryArg!.options ?? {};

  // C1: forked resume — never a bare resume.
  assert.equal(opts.resume, LIVE_SID, 'resume targets the live session id (C1)');
  assert.equal(opts.forkSession, true, 'forkSession:true — never a bare resume (C1)');
  // C1/C2: the fork writes nothing to disk, so the original <liveSid>.jsonl is
  // never appended to (and forkSession would route any write to a NEW id anyway).
  assert.equal(opts.persistSession, false, 'persistSession:false — fork writes no jsonl (C1/C2)');
  // B-270: the prompt handed to the fork is the question WRAPPED with a terse
  // side-query framing line (belt-and-suspenders steering); the raw question is
  // still contained verbatim.
  assert.match(String(lastQueryArg!.prompt), /\/btw side question/, 'prompt is framed for the fork');
  assert.ok(
    String(lastQueryArg!.prompt).includes('what is the build script?'),
    'the framed prompt still contains the question verbatim'
  );

  // C4: the pinned message id is forwarded as resumeSessionAt.
  assert.equal(opts.resumeSessionAt, 'msg-uuid-42', 'upToMessageId → resumeSessionAt (C4)');

  // C3: read-only tool wall + never bypassPermissions.
  const disallowed = (opts.disallowedTools ?? []) as string[];
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
    assert.ok(disallowed.includes(tool), `disallowedTools blocks ${tool} (C3)`);
  }
  assert.notEqual(opts.permissionMode, 'bypassPermissions', 'never bypassPermissions (C3)');

  // C2 (after): neither id ever entered activeSessions.
  const activeAfter = sdk.getActiveClaudeSDKSessions();
  assert.ok(!activeAfter.includes(LIVE_SID), 'liveSid never entered activeSessions (C2)');
  assert.ok(!activeAfter.includes(FORK_SID), 'fork id never entered activeSessions (C2)');
  // getSession(liveSid) is a miss (never registered) ⇒ isClaudeSDKSessionActive is
  // falsy (undefined), which itself confirms the fork was never tracked (C2).
  assert.ok(!sdk.isClaudeSDKSessionActive(LIVE_SID), 'liveSid not reported active (C2)');

  // Streaming contract.
  assert.deepEqual(chunks, ['The build script is npm run build:server.'], 'assistant text streamed');
  assert.equal(completed, true, 'onComplete fired on success');
  assert.deepEqual(errors, [], 'no error on the happy path');
  assert.ok(interruptCount >= 1, 'the fork child is interrupted/torn down after the one-shot answer');
});

test('T-881(C4): no upToMessageId ⇒ resumeSessionAt is not set (fork from the tail)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];

  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', upToMessageId: null, userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );

  const opts = lastQueryArg!.options ?? {};
  assert.equal(opts.resume, LIVE_SID);
  assert.equal(opts.forkSession, true);
  assert.equal('resumeSessionAt' in opts, false, 'resumeSessionAt omitted when no message is pinned');
});

test('T-881: an error result maps to the sdk_error code (no complete)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'error_during_execution', is_error: true, result: 'boom' },
  ];

  const errors: Array<{ code: string; message: string }> = [];
  let completed = false;
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    {
      onChunk: () => {},
      onError: (code, message) => errors.push({ code, message }),
      onComplete: () => {
        completed = true;
      },
    }
  );

  assert.equal(errors.length, 1, 'exactly one terminal error');
  assert.equal(errors[0].code, 'sdk_error');
  assert.equal(completed, false, 'no onComplete after an error');
});

test('T-881: a "no conversation found" result maps to session_not_found', async () => {
  scriptedMessages = [
    {
      type: 'result',
      session_id: FORK_SID,
      subtype: 'error_during_execution',
      is_error: true,
      result: 'No conversation found with session ID: ' + LIVE_SID,
    },
  ];

  const errors: Array<{ code: string; message: string }> = [];
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: (code, message) => errors.push({ code, message }), onComplete: () => {} }
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'session_not_found', 'stale/missing session → session_not_found');
});

test('T-881: an empty question is rejected before any fork is constructed', async () => {
  const errors: Array<{ code: string; message: string }> = [];
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: '   ', userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: (code, message) => errors.push({ code, message }), onComplete: () => {} }
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'sdk_error');
  assert.equal(lastQueryArg, null, 'no SDK query constructed for an empty question');
});

test('T-881(A-2.3): a null/blank project path is refused (sdk_error, no fork constructed)', async () => {
  for (const badCwd of [null, '', '   ']) {
    lastQueryArg = null;
    const errors: Array<{ code: string; message: string }> = [];
    let completed = false;
    await sdk.spawnClaudeSideQuery(
      { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: badCwd },
      {
        onChunk: () => {},
        onError: (code, message) => errors.push({ code, message }),
        onComplete: () => {
          completed = true;
        },
      }
    );
    assert.equal(errors.length, 1, `exactly one error for cwd=${JSON.stringify(badCwd)}`);
    assert.equal(errors[0].code, 'sdk_error', 'a missing project path is sdk_error');
    assert.equal(completed, false, 'no completion when the project path is missing');
    assert.equal(lastQueryArg, null, 'the fork is never constructed without a project root');
  }
});

test('T-881(A-2.1): the tool wall is an allowlist — only Read/Grep/Glob/NotebookRead pass, all else denied', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const projectRoot = process.cwd();
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: projectRoot },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};
  const canUseTool = opts.canUseTool as (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<{ behavior: string; message?: string }>;
  assert.equal(typeof canUseTool, 'function', 'canUseTool is installed on the fork');

  // A-2.1: WebFetch/WebSearch dropped from the allowed set, along with every
  // mutating/executing/interactive tool.
  for (const denied of ['WebFetch', 'WebSearch', 'Write', 'Edit', 'Bash', 'Task', 'AskUserQuestion']) {
    const d = await canUseTool(denied, {});
    assert.equal(d.behavior, 'deny', `${denied} is denied by the allowlist`);
  }
  // The MCP resource readers are NOT "read-only tools" for this cage: they read a
  // connected server (mail/drive/accounting), not the project, and no path
  // confinement applies to them. They must stay denied even though the allowlist
  // was widened for NotebookRead.
  for (const denied of ['ReadMcpResource', 'ListMcpResources']) {
    const d = await canUseTool(denied, { server: 'x', uri: 'y' });
    assert.equal(d.behavior, 'deny', `${denied} is denied — MCP servers are outside the project`);
  }

  // Read/Grep/Glob/NotebookRead remain, inside the project.
  const rIn = await canUseTool('Read', { file_path: path.join(projectRoot, 'server/claude-sdk.js') });
  assert.equal(rIn.behavior, 'allow', 'Read inside the project is allowed');
  const gIn = await canUseTool('Grep', { pattern: 'x', path: path.join(projectRoot, 'server') });
  assert.equal(gIn.behavior, 'allow', 'Grep inside the project is allowed');
  const globNoPath = await canUseTool('Glob', { pattern: '**/*.ts' });
  assert.equal(globNoPath.behavior, 'allow', 'Glob with no path defaults to the project cwd (allowed)');
  const nbIn = await canUseTool('NotebookRead', {
    notebook_path: path.join(projectRoot, 'analysis.ipynb'),
  });
  assert.equal(nbIn.behavior, 'allow', 'NotebookRead inside the project is allowed');
});

test('T-1060(A-2.2): NotebookRead is confined exactly like Read, and an allowlisted tool with an unknown path field is refused', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const projectRoot = process.cwd();
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: projectRoot },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};
  const canUseTool = opts.canUseTool as (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<{ behavior: string; message?: string }>;

  // The confinement reads `notebook_path`, NOT `file_path` — the widening would be
  // worthless (or worse, unconfined) if it anchored on the wrong field.
  const nbRel = await canUseTool('NotebookRead', { notebook_path: 'server/nb.ipynb' });
  assert.equal(nbRel.behavior, 'allow', 'a relative NotebookRead resolves under the root');
  const nbOut = await canUseTool('NotebookRead', { notebook_path: '/etc/secrets.ipynb' });
  assert.equal(nbOut.behavior, 'deny', 'NotebookRead outside the project is denied');
  const nbEsc = await canUseTool('NotebookRead', { notebook_path: '../outside.ipynb' });
  assert.equal(nbEsc.behavior, 'deny', 'a relative ".." escape is denied for NotebookRead');

  // REGRESSION GUARD: a NotebookRead carrying no notebook_path must be DENIED, not
  // waved through. Before the fail-closed rewrite, every non-Read tool fell into the
  // Grep/Glob "optional path" branch, where a missing path meant ALLOW — so this
  // exact call would have granted an unconfined notebook read anywhere on the host.
  const nbNoPath = await canUseTool('NotebookRead', {});
  assert.equal(nbNoPath.behavior, 'deny', 'NotebookRead with no notebook_path is denied');
  const nbWrongField = await canUseTool('NotebookRead', { file_path: '/etc/passwd' });
  assert.equal(nbWrongField.behavior, 'deny', 'NotebookRead is not confined via file_path');
});

test('T-881(A-2.2): Read/Grep/Glob are confined to the project root (absolute + ".." escapes denied)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const projectRoot = process.cwd();
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: projectRoot },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};
  const canUseTool = opts.canUseTool as (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<{ behavior: string; message?: string }>;

  // A relative path resolves under the root ⇒ allowed.
  const relRead = await canUseTool('Read', { file_path: 'server/index.js' });
  assert.equal(relRead.behavior, 'allow', 'a relative Read resolves under the project root');

  // Absolute path outside the root ⇒ denied.
  const absOut = await canUseTool('Read', { file_path: '/etc/passwd' });
  assert.equal(absOut.behavior, 'deny', 'an absolute Read outside the project is denied');

  // ".." traversal (absolute or relative) that climbs out of the root ⇒ denied.
  const escAbs = await canUseTool('Read', { file_path: path.join(projectRoot, '../../../etc/passwd') });
  assert.equal(escAbs.behavior, 'deny', '".." traversal out of the root is denied');
  const escRel = await canUseTool('Read', { file_path: '../outside-secret' });
  assert.equal(escRel.behavior, 'deny', 'a relative ".." escape is denied');

  // Grep/Glob honour the same boundary on their `path` field.
  const grepOut = await canUseTool('Grep', { pattern: 'x', path: '/etc' });
  assert.equal(grepOut.behavior, 'deny', 'Grep outside the project is denied');
  const globOut = await canUseTool('Glob', { pattern: '*', path: path.join(projectRoot, '..') });
  assert.equal(globOut.behavior, 'deny', 'Glob rooted above the project is denied');

  // A Read with no file_path cannot be confined ⇒ denied.
  const readNoPath = await canUseTool('Read', {});
  assert.equal(readNoPath.behavior, 'deny', 'a Read with no file_path is denied');
});

test('T-920(B-171): a broad settings allow-rule cannot bypass the cage — the PreToolUse hook denies out-of-project reads authoritatively', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const projectRoot = process.cwd();
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: projectRoot },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};

  // WHY THIS EXISTS: the Agent SDK's permission engine evaluates settings
  // `permissions.allow` rules BEFORE canUseTool, and a match short-circuits to
  // `behavior:"allow"` WITHOUT ever calling canUseTool. Broad read allow-rules
  // exist in this environment across tiers — `Read(/etc/**)` (user + the
  // always-loaded /etc managed tier), `Read(//proc/**)`,
  // `Read(//home/dev/.pm2/logs/**)` — so a fork could silently read OUTSIDE
  // its project root, never hitting the canUseTool cage (B-171). The fork closes
  // this with a PreToolUse hook: the CLI evaluates PreToolUse hooks ABOVE the
  // rule engine and a hook `deny` is authoritative (no allow-rule at any tier can
  // override it — the same mechanism nassaj's config-protection / zero-rule
  // hooks use to beat the broad Bash(*)/Edit(~/.claude/**) allow-rules; the
  // hook-over-rule precedence was verified against Claude Code CLI 2.1.214). The
  // SDK `query` is module-mocked here, so the real permission engine is not
  // exercised; this test drives the installed hook directly and proves that for
  // the exact out-of-project paths a broad allow-rule WOULD grant, the hook still
  // denies — making our cage the sole decisive gate.
  const pre = (opts.hooks as Record<string, unknown> | undefined)?.PreToolUse as
    | Array<{ hooks?: Array<(input: unknown, id?: string, o?: unknown) => Promise<any>> }>
    | undefined;
  assert.ok(Array.isArray(pre) && pre.length >= 1, 'a PreToolUse hook is installed on the fork');
  const hookFn = pre![0]?.hooks?.[0];
  assert.equal(typeof hookFn, 'function', 'the PreToolUse matcher carries a callback');

  const decide = async (tool: string, toolInput: Record<string, unknown>) => {
    const out = await hookFn!(
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: 't' },
      't',
      { signal: new AbortController().signal }
    );
    return out?.hookSpecificOutput?.permissionDecision;
  };

  // The exact paths a broad settings allow-rule WOULD grant (outside the project
  // root) are denied by the hook regardless — this is the B-171 closure.
  for (const p of ['/etc/passwd', '/home/dev/.pm2/logs/app.log', '/proc/1/environ']) {
    assert.equal(
      await decide('Read', { file_path: p }),
      'deny',
      `hook denies out-of-project Read(${p}) even if a settings allow-rule matches it`
    );
  }
  assert.equal(await decide('Read', { file_path: '../outside-secret' }), 'deny', 'hook denies a ".." escape');
  assert.equal(await decide('Grep', { pattern: 'x', path: '/etc' }), 'deny', 'hook denies out-of-project Grep');

  // Non-allowlisted tools are denied by the hook too (read-only posture).
  for (const t of ['Bash', 'Write', 'WebFetch']) {
    assert.equal(await decide(t, {}), 'deny', `hook denies ${t}`);
  }

  // In-project reads are NOT denied by the hook — it returns no permission
  // opinion and defers to the normal flow (which allows the in-project read).
  assert.notEqual(
    await decide('Read', { file_path: path.join(projectRoot, 'server/claude-sdk.js') }),
    'deny',
    'hook does NOT deny an in-project Read (defers to the normal flow)'
  );
  assert.notEqual(
    await decide('Glob', { pattern: '**/*.ts' }),
    'deny',
    'hook does NOT deny a project-cwd Glob'
  );

  // Defense in depth: canUseTool still denies the same out-of-project read.
  const canUseTool = opts.canUseTool as (
    t: string,
    i: Record<string, unknown>
  ) => Promise<{ behavior: string }>;
  assert.equal(
    (await canUseTool('Read', { file_path: '/etc/passwd' })).behavior,
    'deny',
    'canUseTool still denies out-of-project (defense in depth)'
  );

  // Governance preserved: settingSources is left intact so CLAUDE.md still loads.
  const sources = (opts.settingSources ?? []) as string[];
  assert.ok(sources.includes('project'), "settingSources still includes 'project' so CLAUDE.md/governance load");
});

test('T-920(B-171 symlink): the boundary follows symlinks (real confinement) — an in-root symlink escaping the root is denied; an in-root not-yet-existing path is still allowed', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  // A throwaway project root that CONTAINS a symlink escaping it, plus an outside
  // directory the symlink targets. realpathSync the roots so the assertions hold
  // even if os.tmpdir() is itself a symlink.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'btw-root-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'btw-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), 'ok');
  const escape = path.join(root, 'escape'); // <root>/escape -> <outside>
  fs.symlinkSync(outside, escape);

  try {
    await sdk.spawnClaudeSideQuery(
      { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: root },
      { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
    );
    const opts = lastQueryArg!.options ?? {};
    const hookFn = (opts.hooks as any)?.PreToolUse?.[0]?.hooks?.[0] as (
      i: unknown,
      id?: string,
      o?: unknown
    ) => Promise<any>;
    const canUseTool = opts.canUseTool as (
      t: string,
      i: Record<string, unknown>
    ) => Promise<{ behavior: string }>;
    const hookDecide = async (tool: string, ti: Record<string, unknown>) =>
      (
        await hookFn(
          { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: ti, tool_use_id: 't' },
          't',
          { signal: new AbortController().signal }
        )
      )?.hookSpecificOutput?.permissionDecision;

    // Lexically these sit under <root>/, but they resolve OUTSIDE it via the
    // symlink — both gates must deny (a lexical-only check would have ALLOWED).
    const throughLink = path.join(escape, 'secret.txt'); // → <outside>/secret.txt
    assert.equal(await hookDecide('Read', { file_path: throughLink }), 'deny', 'hook denies a Read through an escaping symlink');
    assert.equal(
      (await canUseTool('Read', { file_path: throughLink })).behavior,
      'deny',
      'canUseTool denies a Read through an escaping symlink'
    );
    assert.equal(await hookDecide('Read', { file_path: escape }), 'deny', 'hook denies reading the escaping symlink node itself');
    assert.equal(await hookDecide('Grep', { pattern: 'x', path: escape }), 'deny', 'hook denies a Grep rooted at an escaping symlink');

    // No regression on legitimate in-root reads:
    assert.notEqual(
      await hookDecide('Read', { file_path: path.join(root, 'sub', 'ok.txt') }),
      'deny',
      'an existing in-root Read is allowed'
    );
    // A not-yet-existing in-root path must STILL be allowed — real confinement
    // resolves the deepest existing ancestor and keeps the new leaf lexical.
    assert.notEqual(
      await hookDecide('Read', { file_path: path.join(root, 'sub', 'not-created-yet.txt') }),
      'deny',
      'an in-root not-yet-existing Read is still allowed'
    );
    assert.equal(
      (await canUseTool('Read', { file_path: path.join(root, 'brand-new.md') })).behavior,
      'allow',
      'canUseTool allows an in-root not-yet-existing path'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('[BTW] diagnostic: an error logs code/session/userId-type but NEVER the question content', async () => {
  const SECRET_QUESTION = 'CONFIDENTIAL_QUESTION_TOKEN_9f3a_do_not_leak';
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'error_during_execution', is_error: true, result: 'boom' },
  ];

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await sdk.spawnClaudeSideQuery(
      { sessionId: LIVE_SID, question: SECRET_QUESTION, userId: 2, cwd: process.cwd() },
      { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
    );
  } finally {
    console.warn = realWarn;
  }

  const btwLine = warnings.find((w) => w.includes('[BTW]'));
  assert.ok(btwLine, 'a [BTW] diagnostic line was logged on error');
  assert.ok(btwLine!.includes('code=sdk_error'), 'the error code is logged');
  assert.ok(btwLine!.includes(`session=${LIVE_SID}`), 'the session id is logged');
  assert.ok(btwLine!.includes('userIdType=number'), 'the userId TYPE is logged');
  assert.ok(btwLine!.includes('userIdValue=2'), 'the userId value is logged');
  // The whole point: no conversation content ever reaches the log.
  for (const line of warnings) {
    assert.ok(!line.includes(SECRET_QUESTION), 'the question text is NEVER logged');
  }
});

test('B-270(steering): the side-query directive is APPENDED to the claude_code preset (not replaced)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};
  const sp = opts.systemPrompt as { type?: string; preset?: string; append?: string } | undefined;
  assert.ok(sp && typeof sp === 'object', 'systemPrompt is the preset object');
  assert.equal(sp!.type, 'preset', 'preset kept (CLAUDE.md/governance still loads)');
  assert.equal(sp!.preset, 'claude_code', 'the claude_code preset is not replaced');
  assert.equal(typeof sp!.append, 'string', 'the steering directive is appended');
  const append = sp!.append as string;
  // The load-bearing instructions must reach the fork.
  assert.match(append, /Read, Grep, Glob and NotebookRead/, 'names the only allowed tools');
  assert.match(append, /Agent or Task tool/i, 'forbids Agent/Task delegation');
  assert.match(append, /run\s+Bash/i, 'forbids Bash');
  assert.match(append, /from the conversation already in context/i, 'steers to answer from context');
  assert.match(append, /not (continuing the task|acting as the coordinator)/i, 'overrides the task persona');
});

test('B-270(steering): appending does NOT widen the read-only allowlist (Read/Grep/Glob only)', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const projectRoot = process.cwd();
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: projectRoot },
    { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
  );
  const opts = lastQueryArg!.options ?? {};
  const canUseTool = opts.canUseTool as (
    t: string,
    i: Record<string, unknown>
  ) => Promise<{ behavior: string }>;
  // The very tools the directive tells the model to avoid are STILL hard-denied by
  // the cage — steering is advisory, the allowlist is authoritative.
  for (const denied of ['Agent', 'Task', 'Bash', 'WebFetch', 'Write']) {
    assert.equal((await canUseTool(denied, {})).behavior, 'deny', `${denied} still denied`);
  }
  const rIn = await canUseTool('Read', { file_path: path.join(projectRoot, 'server/claude-sdk.js') });
  assert.equal(rIn.behavior, 'allow', 'in-project Read still allowed');
  // disallowedTools belt unchanged.
  const disallowed = (opts.disallowedTools ?? []) as string[];
  for (const tool of ['Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'ReadMcpResource']) {
    assert.ok(disallowed.includes(tool), `disallowedTools still blocks ${tool}`);
  }
});

test('B-270(errors): error_max_turns maps to a MEANINGFUL sdk_error, not the bare "Side query failed."', async () => {
  scriptedMessages = [
    {
      type: 'result',
      session_id: FORK_SID,
      subtype: 'error_max_turns',
      is_error: true,
      // error_max_turns carries NO `result` string — this is exactly the shape that
      // previously fell through to the generic message (B-270 root cause).
      permission_denials: [
        { tool_name: 'Agent', tool_use_id: 'a', tool_input: {} },
        { tool_name: 'Bash', tool_use_id: 'b', tool_input: {} },
      ],
    },
  ];

  const errors: Array<{ code: string; message: string }> = [];
  let completed = false;
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'test', userId: 2, cwd: process.cwd() },
    {
      onChunk: () => {},
      onError: (code, message) => errors.push({ code, message }),
      onComplete: () => {
        completed = true;
      },
    }
  );

  assert.equal(errors.length, 1, 'exactly one terminal error');
  assert.equal(errors[0].code, 'sdk_error', 'still the sdk_error code the WS layer understands');
  assert.notEqual(errors[0].message, 'Side query failed.', 'NOT the bare generic message');
  assert.match(errors[0].message, /step limit/i, 'names the step-limit cause');
  assert.match(errors[0].message, /specific question/i, 'suggests a recovery');
  assert.match(errors[0].message, /cannot use/i, 'mentions the doomed tool attempts');
  assert.equal(completed, false, 'no completion after an error');
});

test('B-270(diagnostic): tool denials are logged by [BTW] with tool names+counts but no input', async () => {
  scriptedMessages = [
    {
      type: 'result',
      session_id: FORK_SID,
      subtype: 'error_max_turns',
      is_error: true,
      permission_denials: [
        { tool_name: 'Agent', tool_use_id: 'a', tool_input: { secret: 'LEAK_TOKEN_QQ' } },
        { tool_name: 'Agent', tool_use_id: 'b', tool_input: {} },
        { tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'LEAK_CMD_QQ' } },
      ],
    },
  ];
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await sdk.spawnClaudeSideQuery(
      { sessionId: LIVE_SID, question: 'test', userId: 2, cwd: process.cwd() },
      { onChunk: () => {}, onError: () => {}, onComplete: () => {} }
    );
  } finally {
    console.warn = realWarn;
  }
  const denialLine = warnings.find((w) => w.includes('[BTW] tool denials'));
  assert.ok(denialLine, 'a [BTW] tool-denials line was logged');
  assert.match(denialLine!, /count=3/, 'the total denial count is logged');
  assert.match(denialLine!, /Agent:2/, 'per-tool counts are logged (Agent:2)');
  assert.match(denialLine!, /Bash:1/, 'per-tool counts are logged (Bash:1)');
  assert.match(denialLine!, new RegExp(`session=${LIVE_SID}`), 'the session id is logged');
  // The tool_input must NEVER reach the log.
  for (const line of warnings) {
    assert.ok(!line.includes('LEAK_TOKEN_QQ'), 'tool_input content is never logged');
    assert.ok(!line.includes('LEAK_CMD_QQ'), 'tool_input command is never logged');
  }
});

test('B-270(a): onComplete carries the FULL answer (the SDK result string) on success', async () => {
  const FULL = 'The build script is npm run build:server. Run it from the repo root.';
  scriptedMessages = [
    {
      type: 'assistant',
      session_id: FORK_SID,
      message: { content: [{ type: 'text', text: FULL }] },
    },
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: FULL },
  ];

  const chunks: string[] = [];
  let completedWith: string | undefined;
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'what is the build script?', userId: null, cwd: process.cwd() },
    {
      onChunk: (t) => chunks.push(t),
      onError: () => {},
      onComplete: (full) => {
        completedWith = full;
      },
    }
  );

  // btw-chunk streaming is preserved unchanged.
  assert.deepEqual(chunks, [FULL], 'the chunk still streams for progressive display');
  // The terminal callback carries the full answer, not a bare signal.
  assert.equal(completedWith, FULL, 'onComplete receives the full answer text');
});

test('B-270(b): onComplete carries the answer even when NO assistant chunk was streamed', async () => {
  // The exact live-failure shape server-side: the full text lands only on the
  // result (no incremental assistant block emitted before it).
  const FULL = 'الإجابة الكاملة وصلت على الإطار النهائي وحده.';
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: FULL },
  ];

  let completedWith: string | undefined;
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'س؟', userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: () => {}, onComplete: (full) => {
      completedWith = full;
    } }
  );

  assert.equal(completedWith, FULL, 'onComplete carries the full answer sourced from the result');
});

test('B-270(c): with no result string, onComplete carries the JOINED assistant chunks', async () => {
  scriptedMessages = [
    { type: 'assistant', session_id: FORK_SID, message: { content: [{ type: 'text', text: 'مترا' }] } },
    { type: 'assistant', session_id: FORK_SID, message: { content: [{ type: 'text', text: 'كِم' }] } },
    // A success result with NO `result` field ⇒ fall back to the joined chunks.
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false },
  ];

  let completedWith: string | undefined;
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    { onChunk: () => {}, onError: () => {}, onComplete: (full) => {
      completedWith = full;
    } }
  );

  assert.equal(completedWith, 'متراكِم', 'onComplete joins the streamed assistant chunks when the result carries no text');
});

test('T-881(A-1): onStarted hands back an interrupt handle that tears the fork down', async () => {
  scriptedMessages = [
    { type: 'result', session_id: FORK_SID, subtype: 'success', is_error: false, result: 'ok' },
  ];
  const handles: Array<{ interrupt: () => void }> = [];
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: null, cwd: process.cwd() },
    {
      onStarted: (h) => {
        handles.push(h);
      },
      onChunk: () => {},
      onError: () => {},
      onComplete: () => {},
    }
  );
  assert.equal(handles.length, 1, 'onStarted fired exactly once with a handle');
  assert.equal(typeof handles[0].interrupt, 'function', 'the handle exposes interrupt()');
  const before = interruptCount;
  handles[0].interrupt();
  assert.ok(interruptCount >= before + 1, 'invoking the handle interrupts the underlying fork');
});
