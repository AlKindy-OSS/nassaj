#!/usr/bin/env node
/**
 * connector-smoke.mjs — launch every catalog entry for real and report what
 * actually happens.
 *
 * WHY THIS EXISTS. A catalog row is a claim: this package exists, it starts, it
 * speaks MCP, and this endpoint accepts our redirect. Every one of those claims
 * has been wrong at least once in this catalog's short life — a package name
 * that npm does not have, an endpoint missing a path, a redirect the platform
 * refuses, a token that authenticates without authorising. Each was discovered
 * by a member pasting a live credential and watching nothing happen.
 *
 * So this drives each row the way an engine would:
 *   • stdio rows      → spawned with a dummy key, then handed a real MCP
 *                       handshake (initialize + tools/list) over stdin/stdout.
 *   • oauth rows      → the remote server's metadata is discovered, a client is
 *                       dynamically registered, and /authorize is driven to see
 *                       whether THIS install's redirect is accepted.
 *   • built-in rows   → spawned from dist-server, same handshake.
 *
 * WHAT A PASS DOES NOT MEAN. A dummy key gets a server to start and list its
 * tools; it does not prove any call succeeds. That distinction is the whole
 * Wafeq lesson (22 tools listed, every call refused), so the verdicts below say
 * "starts and lists tools", never "works".
 *
 *   node scripts/connector-smoke.mjs                 # everything
 *   node scripts/connector-smoke.mjs canva notion    # only these services
 *   node scripts/connector-smoke.mjs --origin https://nassaj.example.com
 *
 * Exit code: 0 when every tested row reached a green verdict, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONNECTOR_CATALOG, BUILT_IN_SERVERS_TOKEN } from '../dist-server/shared/connector-catalog.js';
import { discoverAuthServer, beginLink } from '../dist-server/server/modules/connectors/connector-oauth-flow.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BUILT_IN_DIR = path.join(REPO, 'dist-server', 'server', 'mcp-servers');

const args = process.argv.slice(2);
const originIndex = args.indexOf('--origin');
const ORIGIN = originIndex === -1 ? 'https://nassaj.example.com' : args[originIndex + 1];
const REDIRECT = `${ORIGIN.replace(/\/$/, '')}/connectors/oauth/callback`;
const only = args.filter((arg) => !arg.startsWith('--') && arg !== ORIGIN);

/** Long enough for `npx` to fetch a package it has never seen on this machine. */
const HANDSHAKE_TIMEOUT_MS = 120_000;

/**
 * Dummy keys that have to LOOK right. Some servers validate the key's shape at
 * startup and exit before speaking MCP — Stripe refuses anything that is not
 * `sk_*`/`rk_*`. Without a plausible shape the smoke test reports a healthy row
 * as broken, which is its own kind of false alarm.
 */
const SMOKE_KEYS = {
  STRIPE_SECRET_KEY: 'rk_test_smokeTestNotARealKey',
};

/**
 * Verdicts that mean "the row is sound". `starts, key rejected` and `endpoint
 * asks for key` belong here: both prove the packaging is right and only a real
 * credential is missing, which is exactly what a smoke test can establish.
 */
const GREEN = new Set([
  'starts + tools',
  'linkable',
  'starts, key rejected',
  'starts, needs link',
  'endpoint asks for key',
]);

/**
 * Speaks MCP to a child over stdio. Resolves with a verdict rather than
 * throwing: a row that crashes is a RESULT, not an error in this script.
 */
function handshake(command, argv, env) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      // A scratch cwd: some servers write state next to the working directory,
      // and none of them should write it into this repository.
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'connector-smoke-')),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const pending = new Map();
    let nextId = 1;

    const finish = (verdict, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ verdict, detail });
    };

    const timer = setTimeout(() => {
      // A proxy server (Stripe's package forwards every message to
      // mcp.stripe.com) starts fine and then never answers, because the dummy
      // key is rejected upstream. That is a healthy row with an unusable key,
      // not a broken row — and the difference is visible only in stderr.
      const rejected = /unauthori[sz]ed|\b401\b|invalid api key/i.test(stderr);
      finish(
        rejected ? 'starts, key rejected' : 'timeout',
        stderr.trim().split('\n').filter(Boolean).pop()?.slice(0, 60) ?? '',
      );
    }, HANDSHAKE_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        } catch {
          // Servers that print banners to stdout are common; ignore non-JSON.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish('cannot spawn', error.message));
    child.on('exit', (code) =>
      finish('exits early', `code ${code}: ${stderr.trim().split('\n').filter(Boolean).pop() ?? ''}`),
    );

    const call = (method, params) =>
      new Promise((resolveCall) => {
        const id = nextId++;
        pending.set(id, resolveCall);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    void (async () => {
      const init = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nassaj-smoke', version: '1' },
      });
      if (settled) return;
      const name = init?.result?.serverInfo?.name ?? '?';
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const listed = await call('tools/list', {});
      if (settled) return;
      const tools = listed?.result?.tools ?? [];
      if (tools.length === 0 && listed?.error) {
        // The bridge answers with a readable JSON-RPC error when the member has
        // not linked yet. That is the row working correctly with nothing to
        // authorise — not a packaging fault.
        const text = String(listed.error.message ?? '');
        finish(
          /اربط|link|grant|token/i.test(text) ? 'starts, needs link' : 'starts, error',
          text.slice(0, 60),
        );
        return;
      }
      finish(
        tools.length > 0 ? 'starts + tools' : 'starts, no tools',
        `${name}, ${tools.length} tools`,
      );
    })();
  });
}

/**
 * Drives a remote OAuth server all the way to the consent page.
 *
 * THE REQUEST TO `/authorize` IS THE POINT. Registration is not the gate:
 * Canva's registration endpoint answers 201 for any redirect on earth and then
 * its authorize endpoint refuses everything but localhost. An earlier version of
 * this function stopped after registering and reported Canva as "linkable" —
 * i.e. this tool reproduced the exact class of false claim it exists to catch.
 */
async function probeOAuth(remoteUrl) {
  let meta;
  try {
    meta = await discoverAuthServer(remoteUrl);
  } catch (error) {
    return { verdict: 'no oauth metadata', detail: error.message.slice(0, 120) };
  }
  if (!meta.registrationEndpoint) {
    return { verdict: 'no self-registration', detail: meta.issuer };
  }

  let authorizeUrl;
  try {
    ({ authorizeUrl } = await beginLink({
      userId: 0,
      connectorId: '__smoke__',
      remoteUrl,
      redirectUri: REDIRECT,
    }));
  } catch (error) {
    return { verdict: 'registration refused', detail: error.message.replace(/\s+/g, ' ').slice(0, 110) };
  }

  const response = await fetch(authorizeUrl, { redirect: 'manual' }).catch((error) => ({
    status: 0,
    statusText: error.message,
  }));

  // 3xx → the platform is sending the member on to sign in; 200 → it rendered
  // the consent page itself. Anything else is a refusal, and its body says why.
  if (response.status >= 300 && response.status < 400) {
    return { verdict: 'linkable', detail: `${meta.scopes.length} scopes, 302` };
  }
  if (response.status === 200) {
    return { verdict: 'linkable', detail: `${meta.scopes.length} scopes, consent page` };
  }
  const body = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
  return {
    verdict: 'redirect refused',
    detail: `${response.status}: ${body.replace(/\s+/g, ' ').trim().slice(0, 80)}`,
  };
}

const remoteUrlOf = (entry) => (entry.args ?? []).find((arg) => /^https?:\/\//.test(arg)) ?? entry.url;

const rows = CONNECTOR_CATALOG.filter((entry) => only.length === 0 || only.includes(entry.service));
const results = [];

for (const entry of rows) {
  process.stderr.write(`… ${entry.service}\n`);

  if (entry.authMode === 'oauth' && !entry.oauthClient) {
    const remote = remoteUrlOf(entry);
    results.push({ service: entry.service, kind: 'oauth', ...(await probeOAuth(remote)) });
    continue;
  }

  // A configured-client platform cannot be driven end to end from here: the
  // authorize call needs the operator's app, which lives in .env and may not be
  // set on the machine running this. What IS checkable is that the built-in
  // server starts and lists its tools, and whether the app is configured at all.
  if (entry.oauthClient) {
    const argv = (entry.args ?? []).map((arg) => arg.split(BUILT_IN_SERVERS_TOKEN).join(BUILT_IN_DIR));
    const result = await handshake(process.execPath, argv, {});
    const hasApp = Boolean(process.env[`${entry.oauthClient.clientEnvPrefix}_CLIENT_ID`]);
    results.push({
      service: entry.service,
      kind: 'built-in',
      verdict: result.verdict,
      detail: `${result.detail}${hasApp ? ', operator app set' : ', NO operator app in .env'}`,
    });
    continue;
  }

  if (entry.transport === 'http') {
    // A pasted-key HTTP row cannot be handshaken without the key; the honest
    // check is that the endpoint is an MCP endpoint at all.
    const response = await fetch(entry.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }).catch((error) => ({ status: 0, statusText: error.message }));
    const status = response.status;
    results.push({
      service: entry.service,
      kind: 'http',
      verdict: status === 401 || status === 403 ? 'endpoint asks for key' : `http ${status}`,
      detail: entry.url,
    });
    continue;
  }

  const isBuiltIn = (entry.args ?? []).some((arg) => arg.includes(BUILT_IN_SERVERS_TOKEN));
  const argv = (entry.args ?? []).map((arg) => arg.split(BUILT_IN_SERVERS_TOKEN).join(BUILT_IN_DIR));
  const command = isBuiltIn ? process.execPath : (entry.command ?? 'npx');

  const env = {};
  if (entry.keyEnvVar) env[entry.keyEnvVar] = SMOKE_KEYS[entry.keyEnvVar] ?? 'smoke-test-not-a-real-key';
  for (const extra of entry.extraEnv ?? []) env[extra.envVar] = 'SMOKE';

  results.push({
    service: entry.service,
    kind: isBuiltIn ? 'built-in' : 'npx',
    ...(await handshake(command, argv, env)),
  });
}

console.log('');
console.log('service              kind      verdict                 detail');
console.log('-------------------- --------- ----------------------- ------------------------------');
for (const row of results) {
  const mark = GREEN.has(row.verdict) ? '✔' : '✘';
  console.log(
    `${mark} ${row.service.padEnd(18)} ${row.kind.padEnd(9)} ${row.verdict.padEnd(23)} ${row.detail ?? ''}`,
  );
}

const failed = results.filter((row) => !GREEN.has(row.verdict));
console.log(`\n${results.length - failed.length}/${results.length} green`);
process.exit(failed.length === 0 ? 0 : 1);
