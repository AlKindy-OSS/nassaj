import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BRIDGE = path.resolve('server/mcp-servers/remote-bridge.ts');

test('tombstone rejects before the remote bridge issues a fetch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-bridge-revoked-'));
  const grantFile = path.join(root, 'grant.json');
  fs.writeFileSync(grantFile, JSON.stringify({
    access_token: 'must-not-be-sent', refresh_token: 'refresh',
    expires_at: Date.now() + 60_000, token_url: 'https://example.test/token',
  }), { mode: 0o600 });
  fs.writeFileSync(`${grantFile}.revocation-pending.json`, JSON.stringify({ version: 1 }), { mode: 0o600 });
  let requests = 0;
  const server = http.createServer((_request, response) => { requests += 1; response.end('{}'); });
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await requestThroughBridge({
      grantFile,
      remoteUrl: `http://127.0.0.1:${address.port}/mcp`,
    });
    child = result.child;
    assert.match(JSON.stringify(result.reply), /طلب إبطال/);
    assert.equal(requests, 0);
  } finally {
    child?.kill();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intent alone rejects before the remote bridge issues its final fetch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-bridge-revocation-intent-'));
  const grantFile = path.join(root, 'grant.json');
  fs.writeFileSync(grantFile, JSON.stringify({
    access_token: 'must-not-be-sent', refresh_token: 'refresh',
    expires_at: Date.now() + 60_000, token_url: 'https://example.test/token',
  }), { mode: 0o600 });
  fs.writeFileSync(`${grantFile}.revocation-intent.json`, JSON.stringify({ version: 1 }), { mode: 0o600 });
  let requests = 0;
  const server = http.createServer((_request, response) => { requests += 1; response.end('{}'); });
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await requestThroughBridge({
      grantFile,
      remoteUrl: `http://127.0.0.1:${address.port}/mcp`,
    });
    child = result.child;
    assert.match(JSON.stringify(result.reply), /طلب إبطال/);
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(`${grantFile}.revocation-pending.json`), false);
  } finally {
    child?.kill();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function requestThroughBridge(input: {
  grantFile: string;
  remoteUrl: string;
  env?: Record<string, string>;
}): Promise<{ reply: unknown; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(process.execPath, ['--import', 'tsx', BRIDGE, input.remoteUrl], {
    env: {
      ...process.env,
      NASSAJ_GRANT_FILE: input.grantFile,
      NASSAJ_OAUTH_CLIENT_ID: 'test-client',
      NASSAJ_OAUTH_CLIENT_SECRET: 'test-secret',
      ...input.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reply = new Promise<unknown>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lineEnd = stdout.indexOf('\n');
      if (lineEnd >= 0) resolve(JSON.parse(stdout.slice(0, lineEnd)));
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => reject(new Error(`bridge exited ${code}: ${stderr}`)));
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
  return reply.then((value) => ({ reply: value, child }));
}

test('Google refresh uses client_secret_post and never sends Basic auth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-bridge-google-'));
  const grantFile = path.join(root, 'grant.json');
  fs.writeFileSync(
    grantFile,
    JSON.stringify({
      access_token: 'expired-access',
      refresh_token: 'refresh-one',
      expires_at: 0,
      token_url: '',
    }),
    { mode: 0o600 },
  );

  let refreshAuthorization: string | undefined;
  let refreshBody = '';
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/token') {
        refreshAuthorization = request.headers.authorization;
        refreshBody = body;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }));
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer fresh-access');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });
  });

  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const grant = JSON.parse(fs.readFileSync(grantFile, 'utf8')) as Record<string, unknown>;
    grant.token_url = `${baseUrl}/token`;
    fs.writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });

    child = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve('server/mcp-servers/remote-bridge.ts'), `${baseUrl}/mcp`],
      {
        env: {
          ...process.env,
          NASSAJ_GRANT_FILE: grantFile,
          NASSAJ_OAUTH_CLIENT_ID: 'google-client',
          NASSAJ_OAUTH_CLIENT_SECRET: 'google-secret',
          NASSAJ_OAUTH_TOKEN_AUTH_METHOD: 'client_secret_post',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const reply = new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child!.stdout.setEncoding('utf8');
      child!.stderr.setEncoding('utf8');
      child!.stdout.on('data', (chunk) => {
        stdout += chunk;
        const lineEnd = stdout.indexOf('\n');
        if (lineEnd >= 0) resolve(stdout.slice(0, lineEnd));
      });
      child!.stderr.on('data', (chunk) => { stderr += chunk; });
      child!.once('exit', (code) => reject(new Error(`bridge exited ${code}: ${stderr}`)));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);

    assert.deepEqual(JSON.parse(await reply), { jsonrpc: '2.0', id: 1, result: { ok: true } });
    assert.equal(refreshAuthorization, undefined);
    const parameters = new URLSearchParams(refreshBody);
    assert.equal(parameters.get('client_id'), 'google-client');
    assert.equal(parameters.get('client_secret'), 'google-secret');
    assert.equal(parameters.get('refresh_token'), 'refresh-one');
  } finally {
    child?.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two bridge processes consume one rotating refresh token exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-bridge-race-'));
  const grantFile = path.join(root, 'grant.json');
  let refreshCalls = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/token') {
      refreshCalls += 1;
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          access_token: 'access-next',
          refresh_token: 'refresh-next',
          expires_in: 3600,
        }));
      }, 150);
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer access-next');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });

  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    fs.writeFileSync(grantFile, JSON.stringify({
      access_token: 'expired',
      refresh_token: 'refresh-once',
      expires_at: 0,
      token_url: `${baseUrl}/token`,
    }), { mode: 0o644 });

    const requests = [1, 2].map(() => requestThroughBridge({
      grantFile,
      remoteUrl: `${baseUrl}/mcp`,
    }));
    const results = await Promise.all(requests);
    children.push(...results.map((result) => result.child));

    assert.equal(refreshCalls, 1);
    assert.ok(results.every((result) => (
      (result.reply as { result?: { ok?: boolean } }).result?.ok === true
    )));
    const stored = JSON.parse(fs.readFileSync(grantFile, 'utf8')) as Record<string, unknown>;
    assert.equal(stored.refresh_token, 'refresh-next');
    assert.equal(stored.generation, 1);
    assert.equal(fs.statSync(grantFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  } finally {
    for (const child of children) child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous successful refresh is journalled and never retried with the old token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-bridge-ambiguous-'));
  const grantFile = path.join(root, 'grant.json');
  let refreshCalls = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/token') {
      refreshCalls += 1;
      response.setHeader('Content-Type', 'application/json');
      response.end('{"refresh_token":"SYNTHETIC_ONLY_ROTATED_REFRESH"}');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });

  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    fs.writeFileSync(grantFile, JSON.stringify({
      access_token: 'expired',
      refresh_token: 'refresh-maybe-consumed',
      expires_at: 0,
      token_url: `${baseUrl}/token`,
    }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await requestThroughBridge({ grantFile, remoteUrl: `${baseUrl}/mcp` });
      children.push(result.child);
      assert.match(
        (result.reply as { error?: { message?: string } }).error?.message ?? '',
        /نتيجة|تأكيد|إعادة الربط/,
      );
      result.child.kill();
    }
    assert.equal(refreshCalls, 1, 'the old rotating token must not be retried after an ambiguous 2xx');
    assert.equal(fs.existsSync(`${grantFile}.refreshing.json`), true);
    assert.equal(fs.statSync(`${grantFile}.refreshing.json`).mode & 0o777, 0o600);
  } finally {
    for (const child of children) child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a 502 after sending refresh stays ambiguous and the rotating token is not retried', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-bridge-502-'));
  const grantFile = path.join(root, 'grant.json');
  let refreshCalls = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/token') {
      refreshCalls += 1;
      response.statusCode = 502;
      response.end('upstream reset after forwarding');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });

  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    fs.writeFileSync(grantFile, JSON.stringify({
      access_token: 'expired',
      refresh_token: 'rotating-token',
      expires_at: 0,
      token_url: `${baseUrl}/token`,
    }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await requestThroughBridge({ grantFile, remoteUrl: `${baseUrl}/mcp` });
      children.push(result.child);
      assert.match(
        (result.reply as { error?: { message?: string } }).error?.message ?? '',
        /تأكيد|أعد الربط|إعادة الربط/,
      );
      result.child.kill();
    }
    assert.equal(refreshCalls, 1, 'a 502 must never cause reuse of the rotating token');
    assert.equal(fs.existsSync(`${grantFile}.refreshing.json`), true);
  } finally {
    for (const child of children) child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
