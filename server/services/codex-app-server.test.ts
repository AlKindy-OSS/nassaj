import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { resolveCodexRuntime } from '../shared/codex-executable.js';
import { resolveInstalledCodexBuildFingerprint } from '../modules/execution-permissions/capability-registry.js';

function assertPackagedSpawn(command: string, options: { env: NodeJS.ProcessEnv }) {
  const runtime = resolveCodexRuntime();
  assert.equal(command, runtime.executablePath, 'PATH must not choose the App Server executable');
  assert.ok(command.startsWith('/'));
  for (const directory of runtime.pathDirs) assert.ok(options.env.PATH?.startsWith(directory));
}

test('App Server binary is the native binary version measured by permission capability admission', () => {
  const measured: string[] = [];
  const fingerprint = resolveInstalledCodexBuildFingerprint(((file: string, args: string[], options: object) => {
    measured.push(file);
    assert.deepEqual(args, ['--version'], 'no provider turn may be used for identity verification');
    return execFileSync(file, args, options);
  }) as typeof execFileSync);
  assert.deepEqual(measured, [resolveCodexRuntime().executablePath]);
  assert.equal(fingerprint.cliFingerprint.replace('codex-cli@', ''),
    fingerprint.sdkFingerprint.replace('openai-codex-sdk@', ''));
});

import {
  CODEX_SIDE_QUERY_MAX_ANSWER_BYTES,
  callCodexAppServer,
  isCodexCompactionActive,
  isCodexRpcActive,
  spawnCodexSideQuery,
  startCodexCompaction,
} from './codex-app-server.js';

test('Codex /btw answer byte ceiling accepts the boundary and stops before an overflowing delta', async () => {
  const run = async (deltas: string[]) => {
    const chunks: string[] = [];
    const errors: Array<[string, string]> = [];
    let completed: string | null = null;
    const child = createRpcChild((request) => {
      if (request.method === 'thread/fork') return { thread: { id: 'fork-limit' } };
      if (request.method === 'turn/start') {
        setImmediate(() => {
          for (const delta of deltas) {
            child.stdout.write(`${JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: 'fork-limit', turnId: 'turn-limit', itemId: 'a', delta },
            })}\n`);
          }
          child.stdout.write(`${JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'fork-limit', turn: { id: 'turn-limit', status: 'completed' } },
          })}\n`);
        });
        return { turn: { id: 'turn-limit' } };
      }
      return {};
    });
    await spawnCodexSideQuery(
      { sessionId: 'source-limit', question: 'q', userId: 9 },
      {
        onChunk: (text: string) => chunks.push(text),
        onError: (code: string, message: string) => errors.push([code, message]),
        onComplete: (answer: string) => { completed = answer; },
      },
      {
        spawnImpl: () => child,
        authorizeImpl: () => ({ project_path: '/authorized/project', provider: 'codex' }),
        envResolver: () => process.env,
        governanceImpl: () => ({ ok: true }),
      },
    );
    return { chunks, errors, completed, child };
  };

  const exactText = 'a'.repeat(CODEX_SIDE_QUERY_MAX_ANSWER_BYTES);
  const exact = await run([exactText]);
  assert.equal(exact.errors.length, 0);
  assert.equal(exact.completed?.length, CODEX_SIDE_QUERY_MAX_ANSWER_BYTES);
  assert.deepEqual(exact.chunks, [exactText]);

  const overflow = await run(['ok', 'b'.repeat(CODEX_SIDE_QUERY_MAX_ANSWER_BYTES)]);
  assert.deepEqual(overflow.chunks, ['ok'], 'the overflowing delta is never broadcast');
  assert.equal(overflow.completed, null);
  assert.equal(overflow.errors.length, 1);
  assert.equal(overflow.errors[0][0], 'response_too_large');
  assert.match(overflow.errors[0][1], /1048576 UTF-8 bytes/);
  assert.equal(overflow.child.killed, true);
});

test('Codex /btw uses an ephemeral read-only native thread fork and streams only its turn', async () => {
  const requests: Record<string, any>[] = [];
  const chunks: string[] = [];
  let spawnArgs: string[] = [];
  let completed = '';
  const child = createRpcChild((request) => {
    requests.push(request);
    if (request.method === 'thread/fork') {
      return { thread: { id: 'ephemeral-fork' } };
    }
    if (request.method === 'turn/start') {
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'other-thread', turnId: 'side-turn', itemId: 'x', delta: 'leak' },
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'ephemeral-fork', turnId: 'side-turn', itemId: 'a', delta: 'Answer' },
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'ephemeral-fork', turn: { id: 'side-turn', status: 'completed' } },
        })}\n`);
      });
      return { turn: { id: 'side-turn' } };
    }
    return {};
  });

  await spawnCodexSideQuery(
    { sessionId: 'source-thread', question: 'Why?', userId: 17, cwd: '/attacker' },
    {
      onChunk: (text: string) => chunks.push(text),
      onError: (code: string, message: string) => assert.fail(`${code}: ${message}`),
      onComplete: (answer: string) => { completed = answer; },
    },
    {
      spawnImpl: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        assertPackagedSpawn(command, options);
        spawnArgs = args;
        return child;
      },
      authorizeImpl: () => ({ project_path: '/authorized/project', provider: 'codex' }),
      envResolver: () => process.env,
      governanceImpl: () => ({ ok: true }),
    },
  );

  assert.deepEqual(requests.map((request) => request.method), [
    'initialize', 'initialized', 'thread/fork', 'turn/start',
  ]);
  assert.deepEqual(spawnArgs, ['app-server'], 'the side query must leave project instructions enabled');
  const fork = requests.find((request) => request.method === 'thread/fork')?.params;
  assert.equal(fork.threadId, 'source-thread');
  assert.equal(fork.ephemeral, true);
  assert.equal('excludeTurns' in fork, false, 'side-query forks must avoid the paginated fork path');
  assert.equal('lastTurnId' in fork, false, 'UI row ids are never misused as Codex turn ids');
  const turn = requests.find((request) => request.method === 'turn/start')?.params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.approvalPolicy, 'never');
  assert.match(turn.input[0].text, /^Why\?/);
  assert.deepEqual(chunks, ['Answer']);
  assert.equal(completed, 'Answer');
  assert.equal(child.killed, true);
});

test('Codex /btw fails closed before spawning for an inaccessible session', async () => {
  let spawned = false;
  const errors: Array<[string, string]> = [];
  await spawnCodexSideQuery(
    { sessionId: 'hidden', question: 'q', userId: 4 },
    {
      onChunk: () => {},
      onError: (code: string, message: string) => errors.push([code, message]),
      onComplete: () => assert.fail('must not complete'),
    },
    {
      authorizeImpl: () => { throw new Error('not found'); },
      spawnImpl: () => { spawned = true; throw new Error('must not spawn'); },
      governanceImpl: () => ({ ok: true }),
    },
  );
  assert.equal(spawned, false);
  assert.deepEqual(errors, [['session_not_found', 'not found']]);
});

test('Codex /btw interrupt targets the forked turn and terminates App Server', async () => {
  const requests: Record<string, any>[] = [];
  let interrupt: (() => void) | null = null;
  let releaseTurnStarted: (() => void) | null = null;
  const turnStarted = new Promise<void>((resolve) => { releaseTurnStarted = resolve; });
  const child = createRpcChild((request) => {
    requests.push(request);
    if (request.method === 'thread/fork') return { thread: { id: 'fork-i' } };
    if (request.method === 'turn/start') {
      releaseTurnStarted?.();
      return { turn: { id: 'turn-i' } };
    }
    return {};
  });
  const running = spawnCodexSideQuery(
    { sessionId: 'source-i', question: 'stop', userId: 8 },
    {
      onStarted: (handle: { interrupt: () => void }) => { interrupt = handle.interrupt; },
      onChunk: () => assert.fail('no chunks expected'),
      onError: () => assert.fail('interrupt is not a model error'),
      onComplete: () => assert.fail('interrupted query must not complete'),
    },
    {
      spawnImpl: () => child,
      authorizeImpl: () => ({ project_path: '/authorized/project', provider: 'codex' }),
      envResolver: () => process.env,
      governanceImpl: () => ({ ok: true }),
    },
  );
  await turnStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(interrupt);
  interrupt!();
  await running;

  const request = requests.find((entry) => entry.method === 'turn/interrupt');
  assert.deepEqual(request?.params, { threadId: 'fork-i', turnId: 'turn-i' });
  assert.equal(child.killed, true);
});

function createRpcChild(onRequest: (request: Record<string, any>) => unknown = () => ({})) {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdin.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString().trim().split('\n')) {
      if (!raw) continue;
      const request = JSON.parse(raw) as Record<string, any>;
      const result = onRequest(request);
      if (request.id != null) {
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    }
  });
  return child;
}

test('bounded App Server RPC uses authorized session cwd and read access', async () => {
  const requests: Record<string, any>[] = [];
  let accessMode = '';
  const child = createRpcChild((request) => {
    requests.push(request);
    return request.method === 'skills/list' ? { data: [] } : {};
  });

  const result = await callCodexAppServer(
    'thread-read',
    7,
    'skills/list',
    { cwds: ['/attacker/path'], forceReload: false },
    {
      spawnImpl: (command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        assertPackagedSpawn(command, options);
        assert.ok(options.env.PATH?.endsWith('/untrusted/path'));
        return child;
      },
      authorizeImpl: (_sessionId: string, _userId: number, mode: string) => {
        accessMode = mode;
        return { project_path: '/authorized/project', provider: 'codex' };
      },
      envResolver: () => ({ PATH: '/untrusted/path' }),
    },
  );

  assert.equal(accessMode, 'read');
  assert.deepEqual(result, { data: [] });
  assert.deepEqual(requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'skills/list',
  ]);
  assert.deepEqual(requests.at(-1)?.params.cwds, ['/authorized/project']);
  assert.equal(child.killed, true);
});

test('thread mutations require write access and bind the authorized thread id', async () => {
  let accessMode = '';
  let renameParams: Record<string, any> | null = null;
  const child = createRpcChild((request) => {
    if (request.method === 'thread/name/set') renameParams = request.params;
    return {};
  });

  await callCodexAppServer(
    'thread-owned',
    9,
    'thread/name/set',
    { threadId: 'foreign-thread', name: 'New title' },
    {
      accessMode: 'write',
      spawnImpl: () => child,
      authorizeImpl: (_sessionId: string, _userId: number, mode: string) => {
        accessMode = mode;
        return { project_path: process.cwd(), provider: 'codex' };
      },
      envResolver: () => process.env,
    },
  );

  assert.equal(accessMode, 'write');
  assert.deepEqual(renameParams, { threadId: 'thread-owned', name: 'New title' });
});

test('identical short RPCs are single-flight and release their lock after success', async () => {
  let spawned = 0;
  let finishUsage: (() => void) | null = null;
  const child = createRpcChild((request) => {
    if (request.method === 'account/usage/read') {
      return new Promise<void>((resolve) => { finishUsage = resolve; });
    }
    return {};
  });
  // Override request handling because createRpcChild serializes return values.
  child.stdin.removeAllListeners('data');
  child.stdin.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(raw) as Record<string, any>;
      if (request.method === 'account/usage/read') {
        finishUsage = () => child.stdout.write(`${JSON.stringify({ id: request.id, result: { summary: {} } })}\n`);
      } else if (request.id != null) {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    }
  });
  const options = {
    spawnImpl: () => { spawned += 1; return child; },
    authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
    envResolver: () => process.env,
  };

  const first = callCodexAppServer(
    'rpc-thread', 11, 'account/usage/read', { b: 2, nested: { z: 4, a: 3 } }, options,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = callCodexAppServer(
    'rpc-thread', 11, 'account/usage/read', { nested: { a: 3, z: 4 }, b: 2 }, options,
  );
  assert.equal(first, second);
  assert.equal(spawned, 1);
  assert.equal(isCodexRpcActive('rpc-thread', 11, 'account/usage/read'), true);
  assert.ok(finishUsage);
  finishUsage();
  await first;
  assert.equal(isCodexRpcActive('rpc-thread', 11, 'account/usage/read'), false);
});

test('short RPC lock is released after an App Server error', async () => {
  const child = createRpcChild();
  child.stdin.removeAllListeners('data');
  child.stdin.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(raw) as Record<string, any>;
      if (request.id == null) continue;
      const response = request.method === 'account/usage/read'
        ? { id: request.id, error: { message: 'usage unavailable' } }
        : { id: request.id, result: {} };
      child.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });

  await assert.rejects(
    callCodexAppServer('rpc-error', 12, 'account/usage/read', {}, {
      spawnImpl: () => child,
      authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
      envResolver: () => process.env,
    }),
    /usage unavailable/,
  );
  assert.equal(isCodexRpcActive('rpc-error', 12, 'account/usage/read'), false);
  assert.equal(child.killed, true);
});

test('one user cannot open more than three short App Server RPC processes', async () => {
  const finishers: Array<() => void> = [];
  const spawnImpl = () => {
    const child = createRpcChild();
    child.stdin.removeAllListeners('data');
    child.stdin.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(raw) as Record<string, any>;
        if (request.id == null) continue;
        if (request.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        } else {
          finishers.push(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
        }
      }
    });
    return child;
  };
  const options = {
    spawnImpl,
    authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
    envResolver: () => process.env,
  };

  const running = [
    callCodexAppServer('limit-rpc-a', 77, 'account/usage/read', {}, options),
    callCodexAppServer('limit-rpc-b', 77, 'account/usage/read', {}, options),
    callCodexAppServer('limit-rpc-c', 77, 'account/usage/read', {}, options),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => callCodexAppServer('limit-rpc-d', 77, 'account/usage/read', {}, options),
    (error: any) => error?.statusCode === 429 && error?.code === 'CODEX_RPC_LIMIT',
  );
  for (const finish of finishers.splice(0)) finish();
  await Promise.all(running);
  assert.equal(isCodexRpcActive('limit-rpc-a', 77, 'account/usage/read'), false);
  assert.equal(isCodexRpcActive('limit-rpc-b', 77, 'account/usage/read'), false);
  assert.equal(isCodexRpcActive('limit-rpc-c', 77, 'account/usage/read'), false);
});

function compactionItem(threadId: string, turnId = 'compact-turn', method = 'item/completed', id = 'compact-item') {
  return { method, params: { threadId, turnId, item: { type: 'contextCompaction', id } } };
}

function compactionTerminal(threadId: string, status = 'completed', turnId = 'compact-turn') {
  return { method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } };
}

function emitRpc(child: Record<string, any>, ...messages: unknown[]) {
  child.stdout.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
}

function compactionOptions(child: Record<string, any>) {
  return {
    spawnImpl: () => child,
    authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
    envResolver: () => process.env,
  };
}

test('manual compaction uses the native App Server RPC sequence', async () => {
  const methods: string[] = [];
  let childKilled = false;

  const spawnImpl = (command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    assertPackagedSpawn(command, options);
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      killed: boolean;
      kill: () => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      childKilled = true;
      return true;
    };

    let buffered = '';
    child.stdin.on('data', (chunk) => {
      buffered += chunk.toString();
      while (buffered.includes('\n')) {
        const newline = buffered.indexOf('\n');
        const raw = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!raw) continue;
        const message = JSON.parse(raw) as { id?: number; method: string };
        methods.push(message.method);
        if (message.id != null) {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
        if (message.method === 'thread/compact/start') {
          // Deliberately emit completion immediately after the RPC response to
          // exercise the response/await race (cleanup may precede continuation).
          emitRpc(child, compactionItem('thread-1'), compactionTerminal('thread-1'));
        }
      }
    });
    return child;
  };

  const result = await startCodexCompaction('thread-1', 7, {
    spawnImpl,
    authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
    envResolver: () => process.env,
  });

  assert.deepEqual(methods, [
    'initialize',
    'initialized',
    'thread/resume',
    'thread/compact/start',
  ]);
  assert.deepEqual(result, { status: 'completed', alreadyRunning: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(childKilled, true);
  assert.equal(isCodexCompactionActive('thread-1', 7), false);
});

test('authorization happens before spawning App Server', async () => {
  let spawned = false;
  await assert.rejects(
    startCodexCompaction('foreign-thread', 7, {
      authorizeImpl: () => {
        throw new Error('not found');
      },
      spawnImpl: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    }),
    /not found/,
  );
  assert.equal(spawned, false);
});

test('the same thread is single-flight across different authorized users', async () => {
  const children: Array<EventEmitter & Record<string, any>> = [];
  const spawnImpl = () => {
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.stdin.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().trim().split('\n')) {
        if (!raw) continue;
        const request = JSON.parse(raw) as { id?: number };
        if (request.id != null) {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
      }
    });
    children.push(child);
    return child;
  };
  const common = {
    spawnImpl,
    authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
    envResolver: () => process.env,
  };

  const firstPromise = startCodexCompaction('shared-thread', 7, common);
  await new Promise((resolve) => setImmediate(resolve));
  const secondPromise = startCodexCompaction('shared-thread', 8, common);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1);
  emitRpc(children[0], compactionItem('shared-thread'), compactionTerminal('shared-thread'));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.alreadyRunning, false);
  assert.equal(second.alreadyRunning, true);
  assert.equal(children.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isCodexCompactionActive('shared-thread', 7), false);
});

test('an accessible non-Codex session is rejected before spawning', async () => {
  let spawned = false;
  await assert.rejects(
    startCodexCompaction('claude-thread', 7, {
      authorizeImpl: () => ({ project_path: process.cwd(), provider: 'claude' }),
      spawnImpl: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    }),
    /not a Codex thread/,
  );
  assert.equal(spawned, false);
});

test('stdin EPIPE rejects the request and releases the thread lock', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.stdin.once('data', () => {
      const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
      child.stdin.emit('error', error);
    });
    return child;
  };

  await assert.rejects(
    startCodexCompaction('epipe-thread', 7, {
      spawnImpl,
      authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
      envResolver: () => process.env,
    }),
    /broken pipe/,
  );
  assert.equal(isCodexCompactionActive('epipe-thread', 7), false);
});

test('one user cannot keep more than two App Server compactions open', async () => {
  const children = new Map<string, EventEmitter & Record<string, any>>();
  let nextSession = '';
  const spawnImpl = () => {
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.stdin.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().trim().split('\n')) {
        if (!raw) continue;
        const request = JSON.parse(raw) as { id?: number };
        if (request.id != null) child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
    children.set(nextSession, child);
    return child;
  };
  const options = {
    spawnImpl,
    authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
    envResolver: () => process.env,
  };

  nextSession = 'limit-a';
  const first = startCodexCompaction(nextSession, 55, options);
  nextSession = 'limit-b';
  const second = startCodexCompaction(nextSession, 55, options);
  await new Promise((resolve) => setImmediate(resolve));
  nextSession = 'limit-c';
  await assert.rejects(startCodexCompaction(nextSession, 55, options), /maximum number/);

  for (const [threadId, child] of children) {
    emitRpc(child, compactionItem(threadId), compactionTerminal(threadId));
  }
  await Promise.all([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isCodexCompactionActive('limit-a', 55), false);
  assert.equal(isCodexCompactionActive('limit-b', 55), false);
});

test('manual compaction rejects a failed completed turn with displayable detail', async () => {
  const child = createRpcChild();
  child.stdin.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(raw) as Record<string, any>;
      if (request.method === 'thread/compact/start') {
        emitRpc(child, compactionItem('failed-compact', 'compact-turn', 'item/started'));
        child.stdout.write(`${JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'failed-compact',
            turn: { id: 'compact-turn', status: 'failed', error: { message: 'context summary failed' } },
          },
        })}\n`);
      }
    }
  });

  await assert.rejects(
    startCodexCompaction('failed-compact', 88, {
      spawnImpl: () => child,
      authorizeImpl: () => ({ project_path: process.cwd(), provider: 'codex' }),
      envResolver: () => process.env,
    }),
    /failed: context summary failed/,
  );
  assert.equal(isCodexCompactionActive('failed-compact', 88), false);
});

test('selected final native fork negotiates experimental capability and rechecks before exact mutation', async () => {
  const requests: Record<string, any>[] = [];
  const order: string[] = [];
  const child = createRpcChild(request => {
    requests.push(request);
    if (request.method === 'thread/fork') order.push('write');
    return { thread: { id: 'target' } };
  });
  await callCodexAppServer('source-native', 7, 'thread/fork', {
    threadId: 'untrusted', lastTurnId: 'selected', ephemeral: false, excludeTurns: true, threadSource: 'user',
  }, {
    spawnImpl: () => child, authorizeImpl: () => ({ provider: 'codex', project_path: process.cwd() }),
    envResolver: () => process.env, experimentalApi: true,
    beforeRequest: async () => { order.push('verify'); }, onRequestSent: () => order.push('submitted'),
  });
  assert.deepEqual(order, ['verify', 'submitted', 'write']);
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'initialized', 'thread/fork']);
  assert.equal(requests[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(requests[2].params, {
    threadId: 'source-native', lastTurnId: 'selected', ephemeral: false, excludeTurns: true, threadSource: 'user',
  });
});

test('RPC bounds incomplete frames before readline and never submits after initialization overflow', async () => {
  for (const totalOverflow of [false, true]) {
    let submitted = false;
    const child = createRpcChild(() => ({}));
    child.stdin.removeAllListeners('data');
    child.stdin.on('data', () => {
      if (totalOverflow) {
        const line = ' '.repeat(512 * 1024) + '\n';
        for (let i = 0; i < 9; i++) child.stdout.write(line);
      } else child.stdout.write('a'.repeat(1024 * 1024 + 1));
    });
    await assert.rejects(callCodexAppServer('overflow-' + totalOverflow, 7, 'thread/fork', {}, {
      spawnImpl: () => child, authorizeImpl: () => ({ provider: 'codex' }), envResolver: () => process.env,
      onRequestSent: () => { submitted = true; },
    }), /byte limit/);
    assert.equal(submitted, false);
    assert.equal(child.killed, true);
  }
});

test('failed pre-submission recheck does not write fork', async () => {
  const methods: string[] = [];
  const child = createRpcChild(request => { methods.push(request.method); return {}; });
  await assert.rejects(callCodexAppServer('denied-before-send', 7, 'thread/fork', {}, {
    spawnImpl: () => child, authorizeImpl: () => ({ provider: 'codex' }), envResolver: () => process.env,
    beforeRequest: () => { throw new Error('revoked'); },
  }), /revoked/);
  assert.deepEqual(methods, ['initialize', 'initialized']);
});

test('compaction ignores old turns, foreign terminals and cross-thread items before and after binding', async () => {
  const threadId = 'isolated-compaction';
  const child = createRpcChild();
  const running = startCodexCompaction(threadId, 90, compactionOptions(child));
  let resolved = false;
  running.then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  emitRpc(child,
    { method: 'turn/started', params: { threadId, turn: { id: 'old-turn' } } },
    compactionTerminal(threadId, 'completed', 'old-turn'),
    compactionTerminal(threadId, 'interrupted', 'old-turn'),
    compactionItem('other-thread', 'wrong-turn'),
    compactionTerminal('other-thread', 'completed', 'wrong-turn'),
    { method: 'item/completed', params: { threadId, turnId: 'ordinary', item: { type: 'agentMessage', id: 'text' } } },
    compactionTerminal(threadId, 'completed', 'ordinary'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(child.killed, false);
  assert.equal(isCodexCompactionActive(threadId, 90), true);
  emitRpc(child, compactionItem(threadId, 'own', 'item/started'),
    compactionItem(threadId, 'foreign'),
    compactionTerminal(threadId, 'completed', 'foreign'),
    compactionTerminal(threadId, 'interrupted', 'old-turn'),
    { method: 'error', params: { threadId, turnId: 'foreign', willRetry: false, error: { message: 'foreign failure' } } },
    { method: 'error', params: { threadId, turnId: 'own', willRetry: true, error: { message: 'retrying' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(child.killed, false);
  emitRpc(child, compactionItem(threadId, 'own'), compactionTerminal(threadId, 'completed', 'own'));
  assert.deepEqual(await running, { status: 'completed', alreadyRunning: false });
  assert.equal(child.killed, true);
  assert.equal(isCodexCompactionActive(threadId, 90), false);
});

for (const mode of ['before-ack', 'same-chunk', 'ack-error', 'ack-exit', 'ack-timeout']) {
  test(`compaction early notifications preserve the ACK contract for duplicate callers: ${mode}`, async t => {
    if (mode === 'ack-timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const threadId = `early-${mode}`;
    const child = createRpcChild();
    child.stdin.removeAllListeners('data');
    let compactId: number | undefined;
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString());
      if (request.method === 'thread/compact/start') compactId = request.id;
      else if (request.id != null) emitRpc(child, { id: request.id, result: {} });
    });
    const first = startCodexCompaction(threadId, 91, compactionOptions(child));
    await new Promise(resolve => setImmediate(resolve));
    const second = startCodexCompaction(threadId, 91, compactionOptions(child));
    const outcomes = Promise.allSettled([first, second]);
    let resolved = false;
    outcomes.then(() => { resolved = true; });
    assert.ok(compactId);
    const notifications = [compactionItem(threadId), compactionTerminal(threadId)];
    if (mode === 'same-chunk') {
      emitRpc(child, { id: compactId, result: {} }, ...notifications);
    } else {
      emitRpc(child, ...notifications);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(resolved, false, 'both callers must still wait for the ACK');
      assert.equal(child.killed, false, 'early terminal must not kill the process before its ACK');
      if (mode === 'ack-timeout') t.mock.timers.tick(20_000);
      else if (mode === 'ack-exit') child.emit('exit', 1, null);
      else emitRpc(child, mode === 'ack-error'
        ? { id: compactId, error: { message: 'compact request refused' } }
        : { id: compactId, result: {} });
    }
    const results = await outcomes;
    for (const result of results) {
      assert.equal(result.status, mode.startsWith('ack-') ? 'rejected' : 'fulfilled');
      if (result.status === 'rejected') assert.match(result.reason.message, /refused|exited before accepting|timed out during thread\/compact\/start/);
    }
    assert.equal(child.killed, true);
    assert.equal(isCodexCompactionActive(threadId, 91), false);
  });
}

for (const status of ['failed', 'interrupted', 'missing-item-completion']) {
  test(`compaction rejects its own ${status} terminal and releases duplicate callers`, async () => {
    const threadId = `own-${status}`;
    const child = createRpcChild();
    const first = startCodexCompaction(threadId, 92, compactionOptions(child));
    await new Promise(resolve => setImmediate(resolve));
    const second = startCodexCompaction(threadId, 92, compactionOptions(child));
    const outcomes = Promise.allSettled([first, second]);
    emitRpc(child, compactionItem(threadId, 'compact-turn', 'item/started'));
    if (status === 'missing-item-completion') {
      emitRpc(child, compactionItem(threadId, 'compact-turn', 'item/completed', 'wrong-item'));
    }
    emitRpc(child, compactionTerminal(threadId, status === 'missing-item-completion' ? 'completed' : status));
    for (const result of await outcomes) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(result.reason.message, /failed|interrupted|without a completed contextCompaction item/);
    }
    assert.equal(child.killed, true);
    assert.equal(isCodexCompactionActive(threadId, 92), false);
  });
}

for (const mode of ['timeout', 'exit', 'error']) {
  test(`compaction ${mode} without a terminal rejects and frees the thread`, async t => {
    if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const threadId = `unfinished-${mode}`;
    const child = createRpcChild();
    const first = startCodexCompaction(threadId, 93, compactionOptions(child));
    const rejected = assert.rejects(first, /timed out before completion|exited before.*completed|child failed/);
    await new Promise(resolve => setImmediate(resolve));
    emitRpc(child, compactionItem(threadId, 'compact-turn', 'item/started'));
    if (mode === 'timeout') t.mock.timers.tick(5 * 60_000);
    if (mode === 'exit') child.emit('exit', 1, null);
    if (mode === 'error') child.emit('error', new Error('child failed'));
    await rejected;
    assert.equal(child.killed, true);
    assert.equal(isCodexCompactionActive(threadId, 93), false);
  });
}
