import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import express from 'express';

let compactCall: { sessionId: string; userId: number } | null = null;
const rpcCalls: Array<{
  sessionId: string;
  userId: number;
  method: string;
  params: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];

mock.module(pathToFileURL(path.resolve(import.meta.dirname, '../../claude-sdk.js')).href, {
  namedExports: { getClaudeBuiltInCommands: async () => null },
});
mock.module(pathToFileURL(path.resolve(import.meta.dirname, '../../services/codex-app-server.js')).href, {
  namedExports: {
    callCodexAppServer: async (
      sessionId: string,
      userId: number,
      method: string,
      params: Record<string, unknown> = {},
      options: Record<string, unknown> = {},
    ) => {
      if (sessionId === 'limit-thread') {
        throw Object.assign(new Error('too many Codex commands'), { statusCode: 429 });
      }
      rpcCalls.push({ sessionId, userId, method, params, options });
      if (method === 'account/usage/read') return { summary: { lifetimeTokens: 1234 } };
      if (method === 'mcpServerStatus/list') {
        return { data: [{ name: 'github', status: 'ready', tools: { search: {}, read: {} } }] };
      }
      if (method === 'skills/list') {
        return { data: [{ cwd: '/project', skills: [{ name: 'tester', description: 'Run tests' }] }] };
      }
      if (method === 'hooks/list') {
        return { data: [{ cwd: '/project', hooks: [{ key: 'audit', eventName: 'afterTurn' }] }] };
      }
      if (method === 'app/list') {
        return { data: [
          { displayName: 'Drive', isAccessible: false, isEnabled: true },
          { displayName: 'Calendar', isAccessible: true, isEnabled: false },
        ] };
      }
      if (method.startsWith('thread/goal/')) {
        return method.endsWith('/clear') ? {} : {
          goal: { objective: String(params.objective || 'Ship it'), status: params.status || 'active' },
        };
      }
      return { ok: true };
    },
    startCodexCompaction: async (sessionId: string, userId: number) => {
      compactCall = { sessionId, userId };
      return { status: 'completed', alreadyRunning: false };
    },
  },
});

const { default: commandsRouter } = await import('../commands.js');

test('POST /execute routes Codex /compact natively and overwrites client userId', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: number } }).user = { id: 42 };
    next();
  });
  app.use('/api/commands', commandsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandName: '/compact',
        context: { provider: 'codex', sessionId: 'thread-1', userId: 999 },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { type: string; action: string; data: { status: string } };
    assert.equal(body.type, 'builtin');
    assert.equal(body.action, 'compact');
    assert.equal(body.data.status, 'completed');
    assert.deepEqual(compactCall, { sessionId: 'thread-1', userId: 42 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function withCommandsServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: number } }).user = { id: 42 };
    next();
  });
  app.use('/api/commands', commandsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}/api/commands`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Codex command list advertises only wired web commands and official aliases', async () => {
  await withCommandsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      builtIn: Array<{ name: string; metadata?: { hasHandler?: boolean } }>;
    };
    const names = body.builtIn.map((command) => command.name);
    for (const supported of [
      '/help', '/model', '/models', '/cost', '/status', '/compact',
      '/usage', '/mcp', '/skills', '/hooks', '/apps', '/rename', '/goal',
    ]) {
      assert.ok(names.includes(supported), `missing ${supported}`);
    }
    for (const hidden of ['/delete', '/archive', '/logout', '/permissions', '/vim']) {
      assert.ok(!names.includes(hidden), `must hide ${hidden}`);
    }
    assert.ok(body.builtIn.every((command) => command.metadata?.hasHandler === true));
  });
});

test('Codex read and write commands map to their stable App Server RPCs', async () => {
  rpcCalls.length = 0;
  await withCommandsServer(async (baseUrl) => {
    for (const payload of [
      { commandName: '/usage', args: [], expected: 'account/usage/read', content: '1234' },
      { commandName: '/mcp', args: [], expected: 'mcpServerStatus/list', content: '2 tools' },
      { commandName: '/skills', args: [], expected: 'skills/list', content: 'tester' },
      { commandName: '/hooks', args: [], expected: 'hooks/list', content: 'audit** (afterTurn)' },
      { commandName: '/apps', args: [], expected: 'app/list', content: 'Drive** — unavailable' },
      { commandName: '/rename', args: ['Release', 'work'], expected: 'thread/name/set' },
      { commandName: '/goal', args: ['edit', 'Ship', 'it'], expected: 'thread/goal/set', content: 'Ship it' },
      { commandName: '/goal', args: ['pause'], expected: 'thread/goal/set', content: 'paused' },
      { commandName: '/goal', args: ['resume'], expected: 'thread/goal/set', content: 'active' },
      { commandName: '/goal', args: ['clear', 'this', 'backlog'], expected: 'thread/goal/set', content: 'clear this backlog' },
      { commandName: '/goal', args: [], expected: 'thread/goal/get' },
      { commandName: '/goal', args: ['clear'], expected: 'thread/goal/clear' },
    ]) {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandName: payload.commandName,
          args: payload.args,
          context: {
            provider: 'codex',
            sessionId: 'thread-1',
            projectPath: '/attacker/path',
            userId: 999,
          },
        }),
      });
      assert.equal(response.status, 200, payload.commandName);
      const body = await response.json() as { data?: { content?: string } };
      assert.equal(rpcCalls.at(-1)?.method, payload.expected);
      assert.equal(rpcCalls.at(-1)?.userId, 42);
      if (payload.content) {
        assert.ok(
          (body.data?.content || '').includes(payload.content),
          `${payload.commandName}: expected ${payload.content} in ${body.data?.content}`,
        );
      }
    }
    const rename = rpcCalls.find((call) => call.method === 'thread/name/set');
    assert.equal(rename?.params.name, 'Release work');
    assert.equal(rename?.options.accessMode, 'write');
    const pause = rpcCalls.find((call) => call.method === 'thread/goal/set' && call.params.status === 'paused');
    assert.deepEqual(pause?.params, { threadId: 'thread-1', status: 'paused' });
  });
});

test('/goal edit requires a non-empty objective', async () => {
  await withCommandsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandName: '/goal',
        args: ['edit'],
        context: { provider: 'codex', sessionId: 'thread-1' },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { message: string };
    assert.equal(body.message, 'Usage: /goal edit <objective>');
  });
});

test('unsupported Codex slash commands are rejected instead of treated as custom commands', async () => {
  await withCommandsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandName: '/delete',
        context: { provider: 'codex', sessionId: 'thread-1' },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'Unsupported Codex command');
  });
});

test('Codex App Server concurrency limits are returned as HTTP 429', async () => {
  await withCommandsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandName: '/usage',
        context: { provider: 'codex', sessionId: 'limit-thread' },
      }),
    });
    assert.equal(response.status, 429);
    const body = await response.json() as { message: string };
    assert.match(body.message, /too many Codex commands/);
  });
});
