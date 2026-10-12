/**
 * Header-echo harness for the ADR-200 S2 engine-pin matrix test. Runs INSIDE a
 * private network namespace (`unshare -rn`, loopback only), so neither this
 * server nor the CLI can reach any real host.
 *
 * Reads a JSON spec from the file named by argv[2]:
 *   { claudeBin, env, cwd, markers: { engine, dummies: string[] } }
 * Starts a local echo endpoint, points the CLI's ANTHROPIC_BASE_URL at it, and
 * records the auth-bearing headers of every /v1/messages request. It answers
 * 401 and stops the CLI after the first one. Header VALUES are never printed:
 * each is classified as `engine`, `dummy`, `other` or `none`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const RUN_TIMEOUT_MS = 45_000;
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

/** Classifies one header value without exposing it. */
function classify(value) {
  if (value === undefined) return 'none';
  const text = String(value);
  if (text === `Bearer ${spec.markers.engine}`) return 'engine';
  return spec.markers.dummies.some((marker) => text.includes(marker)) ? 'dummy' : 'other';
}

/** Summarises one request: auth headers classified, any other dummy-bearing header named. */
function summarise(req) {
  const leakedHeaders = Object.entries(req.headers)
    .filter(([name]) => name !== 'authorization' && name !== 'x-api-key')
    .filter(([, value]) => classify(value) === 'dummy')
    .map(([name]) => name);
  return {
    path: req.url,
    authorization: classify(req.headers.authorization),
    xApiKey: classify(req.headers['x-api-key']),
    leakedHeaders,
  };
}

const requests = [];
let child = null;
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url.startsWith('/v1/messages')) requests.push(summarise(req));
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'echo' } }));
    if (requests.length > 0 && child) child.kill('SIGKILL');
  });
});

server.listen(0, '127.0.0.1', () => {
  const env = { ...spec.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  child = spawn(spec.claudeBin, ['-p', 'ping', '--max-turns', '1'], {
    env, cwd: spec.cwd, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
  child.on('exit', () => {
    clearTimeout(timer);
    server.close();
    process.stdout.write(`${JSON.stringify({ requests })}\n`);
  });
});
