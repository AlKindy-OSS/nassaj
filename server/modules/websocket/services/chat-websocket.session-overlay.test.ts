import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { mock } from 'node:test';

import { resolveSessionWorkspace } from '@/modules/session-workspaces/index.js';
import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

let failLedgerMark = false;
let resumedRow: { session_id: string; project_path: string; provider: string } | null = null;
let legacyEligible = false;
let legacyParticipant = false;
let sharedWritable = false;
let failSharedMark = false;
const registeredPaths = new Set<string>();
const sharedMarks: Array<{ sessionId: string; projectPath: string; provider: string }> = [];

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: (projectPath: string) => resumedRow?.project_path === projectPath
        || registeredPaths.has(projectPath)
        ? { project_id: 'project-legacy' } : null,
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => sharedWritable,
    },
    participantsDb: { isParticipant: () => legacyParticipant },
    sessionsDb: { getSessionById: () => resumedRow },
    sessionWorkspaceModesDb: {
      readLegacyEligibility: () => legacyEligible ? { mode: 'legacy_shared' } : null,
      markOverlay: () => {
        if (failLedgerMark) throw new Error('injected ledger failure');
      },
      markShared: (sessionId: string, projectPath: string, provider: string) => {
        if (failSharedMark) throw new Error('injected shared ledger failure');
        sharedMarks.push({ sessionId, projectPath, provider });
      },
    },
    sessionOutcomesDb: {},
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixture(): string {
  const repo = fs.mkdtempSync(path.join(os.homedir(), 'nassaj-dispatch-overlay-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Overlay Dispatch Test');
  git(repo, 'config', 'user.email', 'overlay-dispatch@example.test');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'base\n');
  git(repo, 'add', 'source.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  return repo;
}

test('a bind/ledger failure suppresses session_created success and emits terminal failure', async () => {
  const repo = fixture();
  registeredPaths.add(repo);
  const sent: Array<Record<string, unknown>> = [];
  failLedgerMark = true;
  try {
    const writer = { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter;
    const dependencies = {
      getSessionProvider: () => null,
      getActiveClaudeSDKSessions: () => [],
      queryClaudeSDK: async (_command: string, _options: unknown, runtimeWriter: WebSocketWriter) => {
        runtimeWriter.send({ kind: 'session_created', sessionId: 'provider-session-failed' });
        runtimeWriter.send({ kind: 'complete', success: true });
      },
    } as never;

    await dispatchProviderCommand(
      'claude-command',
      { command: 'edit source', options: { cwd: repo, clientMsgId: 'client-message-failed' } },
      writer,
      dependencies,
    );

    assert.equal(sent.some((frame) => frame.kind === 'session_created'), false);
    assert.equal(sent.some((frame) => frame.kind === 'complete'
      && frame.code === 'session_workspace_bind_failed' && frame.success === false), true);
  } finally {
    registeredPaths.delete(repo);
    failLedgerMark = false;
    git(repo, 'worktree', 'prune');
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('legacy resume uses trusted snapshot path and fails closed on cwd or authorization mismatch', async () => {
  const repo = fixture();
  const other = fixture();
  resumedRow = { session_id: 'legacy-session', project_path: repo, provider: 'claude' };
  legacyEligible = true;
  legacyParticipant = true;
  try {
    const run = async (cwd: string, principalId: number | null) => {
      const sent: Array<Record<string, unknown>> = [];
      let runtimeCwd: unknown;
      await dispatchProviderCommand(
        'claude-command',
        { command: 'resume', options: { cwd, sessionId: 'legacy-session' } },
        { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
        {
          getSessionProvider: () => 'claude',
          getActiveClaudeSDKSessions: () => [],
          queryClaudeSDK: async (_command: string, options: Record<string, unknown>) => {
            runtimeCwd = options.cwd;
          },
        } as never,
        principalId,
      );
      return { sent, runtimeCwd };
    };

    const accepted = await run(repo, 7);
    assert.equal(accepted.runtimeCwd, fs.realpathSync(repo));

    const cwdRejected = await run(other, 7);
    assert.equal(cwdRejected.runtimeCwd, undefined);
    assert.equal(cwdRejected.sent.some((frame) => frame.code === 'session_workspace_path_unsafe'), true);

    legacyParticipant = false;
    const authRejected = await run(repo, null);
    assert.equal(authRejected.runtimeCwd, undefined);
    assert.equal(authRejected.sent.some((frame) => frame.code === 'session_workspace_forbidden'), true);
  } finally {
    resumedRow = null;
    legacyEligible = false;
    legacyParticipant = false;
    for (const directory of [repo, other]) {
      git(directory, 'worktree', 'prune');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('legacy resume accepts a snapshotted project directory that predates Git overlays', async () => {
  const project = fs.mkdtempSync(path.join(os.homedir(), 'nassaj-dispatch-legacy-directory-'));
  resumedRow = { session_id: 'legacy-non-repository', project_path: project, provider: 'claude' };
  legacyEligible = true;
  legacyParticipant = true;
  let runtimeCwd: unknown;
  try {
    const sent: Array<Record<string, unknown>> = [];
    await dispatchProviderCommand(
      'claude-command',
      { command: 'resume', options: { cwd: project, sessionId: 'legacy-non-repository' } },
      { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
      {
        getSessionProvider: () => 'claude',
        getActiveClaudeSDKSessions: () => [],
        queryClaudeSDK: async (_command: string, options: Record<string, unknown>) => {
          runtimeCwd = options.cwd;
        },
      } as never,
      7,
    );

    assert.equal(runtimeCwd, fs.realpathSync(project));
    assert.equal(sent.some((frame) => frame.code === 'session_workspace_unavailable'), false);
  } finally {
    resumedRow = null;
    legacyEligible = false;
    legacyParticipant = false;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('legacy resume rejects snapshotted final and parent symlinks before runtime', async () => {
  const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-dispatch-legacy-symlink-'));
  const physicalParent = path.join(root, 'physical-parent');
  const project = path.join(physicalParent, 'project');
  const finalAlias = path.join(root, 'project-alias');
  const parentAlias = path.join(root, 'parent-alias');
  fs.mkdirSync(project, { recursive: true });
  fs.symlinkSync(project, finalAlias, 'dir');
  fs.symlinkSync(physicalParent, parentAlias, 'dir');
  legacyEligible = true;
  legacyParticipant = true;
  let runtimeStarted = false;
  try {
    for (const [sessionId, projectPath] of [
      ['legacy-final-symlink', finalAlias],
      ['legacy-parent-symlink', path.join(parentAlias, 'project')],
    ]) {
      resumedRow = { session_id: sessionId, project_path: projectPath, provider: 'claude' };
      const sent: Array<Record<string, unknown>> = [];
      await dispatchProviderCommand(
        'claude-command',
        { command: 'resume', options: { cwd: projectPath, sessionId } },
        { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
        {
          getSessionProvider: () => 'claude',
          getActiveClaudeSDKSessions: () => [],
          queryClaudeSDK: async () => {
            runtimeStarted = true;
          },
        } as never,
        7,
      );

      assert.equal(runtimeStarted, false);
      assert.equal(sent.some((frame) => frame.code === 'session_workspace_path_unsafe'), true);
    }
  } finally {
    resumedRow = null;
    legacyEligible = false;
    legacyParticipant = false;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy resume accepts an attested repository subdirectory as shared', async () => {
  const repo = fixture();
  const subdirectory = path.join(repo, 'nested');
  fs.mkdirSync(subdirectory);
  resumedRow = { session_id: 'legacy-subdirectory', project_path: subdirectory, provider: 'claude' };
  legacyEligible = true;
  legacyParticipant = true;
  let runtimeCwd: unknown;
  try {
    const sent: Array<Record<string, unknown>> = [];
    await dispatchProviderCommand(
      'claude-command',
      { command: 'resume', options: { cwd: subdirectory, sessionId: 'legacy-subdirectory' } },
      { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
      {
        getSessionProvider: () => 'claude',
        getActiveClaudeSDKSessions: () => [],
        queryClaudeSDK: async (_command: string, options: Record<string, unknown>) => {
          runtimeCwd = options.cwd;
        },
      } as never,
      7,
    );

    assert.equal(runtimeCwd, fs.realpathSync(subdirectory));
    assert.equal(sent.some((frame) => frame.code === 'session_workspace_unavailable'), false);
  } finally {
    resumedRow = null;
    legacyEligible = false;
    legacyParticipant = false;
    git(repo, 'worktree', 'prune');
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('central provider dispatch passes a new session its overlay cwd and binds resume identity', async () => {
  const repo = fixture();
  registeredPaths.add(repo);
  try {
    let runtimeOptions: Record<string, unknown> | null = null;
    const writer = { send: () => undefined } as unknown as WebSocketWriter;
    const dependencies = {
      getSessionProvider: () => null,
      getActiveClaudeSDKSessions: () => [],
      queryClaudeSDK: async (_command: string, options: unknown, runtimeWriter: WebSocketWriter) => {
        runtimeOptions = options as Record<string, unknown>;
        runtimeWriter.send({ kind: 'session_created', sessionId: 'provider-session-a' });
      },
    } as never;

    await dispatchProviderCommand(
      'claude-command',
      {
        command: 'edit source',
        options: { cwd: repo, clientMsgId: 'client-message-a' },
      },
      writer,
      dependencies,
    );

    assert.ok(runtimeOptions);
    assert.equal(runtimeOptions.projectPath, fs.realpathSync(repo));
    assert.equal(runtimeOptions.nassajWorkspaceIsolation, 'overlay');
    assert.match(String(runtimeOptions.cwd), /\.git\/nassaj-session-overlays\/instances\//);
    const resumed = resolveSessionWorkspace({
      projectPath: repo, sessionId: 'provider-session-a', principalId: 1,
    });
    assert.equal(resumed.cwd, runtimeOptions.cwd);
  } finally {
    registeredPaths.delete(repo);
    git(repo, 'worktree', 'prune');
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('new registered writable non-git project is shared and ledger-bound before session_created', async () => {
  const project = fs.mkdtempSync(path.join(os.homedir(), 'nassaj-dispatch-new-shared-'));
  const canonical = fs.realpathSync(project);
  registeredPaths.add(canonical);
  sharedWritable = true;
  sharedMarks.length = 0;
  const sent: Array<Record<string, unknown>> = [];
  let runtimeOptions: Record<string, unknown> | null = null;
  try {
    await dispatchProviderCommand(
      'claude-command',
      { command: 'start', options: { cwd: canonical, clientMsgId: 'shared-client-message' } },
      { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
      {
        getSessionProvider: () => null,
        getActiveClaudeSDKSessions: () => [],
        queryClaudeSDK: async (_command: string, options: unknown, writer: WebSocketWriter) => {
          runtimeOptions = options as Record<string, unknown>;
          writer.send({ kind: 'session_created', sessionId: 'shared-provider-session' });
        },
      } as never,
      7,
    );

    assert.equal(runtimeOptions?.cwd, canonical);
    assert.equal(runtimeOptions?.nassajWorkspaceIsolation, 'legacy_shared');
    assert.deepEqual(sharedMarks, [{
      sessionId: 'shared-provider-session', projectPath: canonical, provider: 'claude',
    }]);
    const created = sent.find((frame) => frame.kind === 'session_created');
    assert.equal(created?.workspaceIsolation, 'legacy_shared');
  } finally {
    sharedWritable = false;
    registeredPaths.delete(canonical);
    sharedMarks.length = 0;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('shared launch fails closed before provider for missing, unregistered, and unsafe aliases', async () => {
  const project = fs.mkdtempSync(path.join(os.homedir(), 'nassaj-dispatch-shared-guard-'));
  const canonical = fs.realpathSync(project);
  const alias = `${project}-alias`;
  fs.symlinkSync(project, alias, 'dir');
  let providerCalls = 0;
  const run = async (cwd: string) => {
    const sent: Array<Record<string, unknown>> = [];
    await dispatchProviderCommand(
      'claude-command',
      { command: 'start', options: { cwd, clientMsgId: `guard-${providerCalls}-${cwd}` } },
      { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
      {
        getSessionProvider: () => null,
        getActiveClaudeSDKSessions: () => [],
        queryClaudeSDK: async () => { providerCalls += 1; },
      } as never,
      7,
    );
    return sent;
  };
  try {
    sharedWritable = true;
    const unregistered = await run(canonical);
    assert.equal(unregistered.some((frame) => frame.code === 'session_workspace_forbidden'), true);

    registeredPaths.add(canonical);
    sharedWritable = false;
    const readOnly = await run(canonical);
    assert.equal(readOnly.some((frame) => frame.code === 'session_workspace_forbidden'), true);
    sharedWritable = true;

    const unsafe = await run(alias);
    assert.equal(unsafe.some((frame) => frame.code === 'session_workspace_path_unsafe'), true);

    const forbiddenRoot = await run('/etc');
    assert.equal(forbiddenRoot.some((frame) => frame.code === 'session_workspace_path_unsafe'), true);

    const missing = await run(path.join(project, 'missing'));
    assert.equal(missing.some((frame) => frame.code === 'session_workspace_missing'), true);
    assert.equal(providerCalls, 0);
  } finally {
    sharedWritable = false;
    registeredPaths.delete(canonical);
    fs.rmSync(alias, { force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('shared ledger conflict suppresses session_created and emits terminal bind failure', async () => {
  const project = fs.mkdtempSync(path.join(os.homedir(), 'nassaj-dispatch-shared-bind-'));
  const canonical = fs.realpathSync(project);
  registeredPaths.add(canonical);
  sharedWritable = true;
  failSharedMark = true;
  const sent: Array<Record<string, unknown>> = [];
  try {
    await dispatchProviderCommand(
      'claude-command',
      { command: 'start', options: { cwd: canonical, clientMsgId: 'shared-bind-failure' } },
      { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
      {
        getSessionProvider: () => null,
        getActiveClaudeSDKSessions: () => [],
        queryClaudeSDK: async (_command: string, _options: unknown, writer: WebSocketWriter) => {
          writer.send({ kind: 'session_created', sessionId: 'shared-bind-conflict' });
          writer.send({ kind: 'complete', success: true });
        },
      } as never,
      7,
    );
    assert.equal(sent.some((frame) => frame.kind === 'session_created'), false);
    assert.equal(sent.some((frame) => frame.code === 'session_workspace_bind_failed'
      && frame.success === false), true);
  } finally {
    failSharedMark = false;
    sharedWritable = false;
    registeredPaths.delete(canonical);
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a second conflicting session_created cannot create another shared ledger binding', async () => {
  const project = fs.mkdtempSync(path.join(os.homedir(), 'nassaj-dispatch-shared-double-bind-'));
  const canonical = fs.realpathSync(project);
  registeredPaths.add(canonical);
  sharedWritable = true;
  sharedMarks.length = 0;
  const sent: Array<Record<string, unknown>> = [];
  try {
    await dispatchProviderCommand(
      'claude-command',
      { command: 'start', options: { cwd: canonical, clientMsgId: 'shared-double-bind' } },
      { send: (frame: Record<string, unknown>) => sent.push(frame) } as unknown as WebSocketWriter,
      {
        getSessionProvider: () => null,
        getActiveClaudeSDKSessions: () => [],
        queryClaudeSDK: async (_command: string, _options: unknown, writer: WebSocketWriter) => {
          writer.send({ kind: 'session_created', sessionId: 'shared-first-session' });
          writer.send({ kind: 'session_created', sessionId: 'shared-second-session' });
          writer.send({ kind: 'complete', success: true });
        },
      } as never,
      7,
    );

    assert.deepEqual(sharedMarks, [{
      sessionId: 'shared-first-session', projectPath: canonical, provider: 'claude',
    }]);
    assert.deepEqual(
      sent.filter((frame) => frame.kind === 'session_created').map((frame) => frame.sessionId),
      ['shared-first-session'],
    );
    assert.equal(sent.some((frame) => frame.code === 'session_workspace_bind_failed'), true);
    assert.equal(sent.some((frame) => frame.kind === 'complete' && frame.success === true), false);
  } finally {
    sharedWritable = false;
    registeredPaths.delete(canonical);
    sharedMarks.length = 0;
    fs.rmSync(project, { recursive: true, force: true });
  }
});
