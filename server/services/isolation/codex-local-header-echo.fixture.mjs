/**
 * Header-echo harness for the Codex local-engine proof (ADR-227, T-2107). Runs
 * INSIDE a private network namespace (`unshare -rn`, loopback only), so neither
 * this server nor the CLI can reach any real host.
 *
 * Reads a JSON spec from the file named by argv[2]:
 *   { codexBin, env, config, cwd, model, listen: { host, port },
 *     markers: { engine, dummies: string[] }, resumeId?: string, respond?: 'echo401'|'tool-call',
 *     command?: string, sandboxMode?: string }
 * Listens at `listen` (the production base URL's vetted literal), drives the
 * real CLI through @openai/codex-sdk with the production env and config, and
 * records every request: the Authorization value classified (`engine`, `dummy`,
 * `other`, `none`), any other header carrying a dummy, whether the body carries
 * one, and the Host the CLI connected with. `echo401` (default) answers 401 and
 * aborts the turn after the first /v1/responses request; `tool-call` streams a
 * Responses turn whose first answer is an `exec_command` call (`touch ran.txt`)
 * (or `command`) and whose next answer ends the turn, so the CLI's tool path — and its hooks —
 * run for real. Header VALUES are never printed.
 */

import fs from 'node:fs';
import http from 'node:http';

import { Codex } from '@openai/codex-sdk';

const RUN_TIMEOUT_MS = 60_000;
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hasDummy = (text) => spec.markers.dummies.some((marker) => String(text).includes(marker));

/** Classifies the Authorization value without exposing it. */
function classify(value) {
  if (value === undefined) return 'none';
  if (String(value) === `Bearer ${spec.markers.engine}`) return 'engine';
  return hasDummy(value) ? 'dummy' : 'other';
}

const requests = [];
const abort = new AbortController();
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
let responsesSeen = 0;

/** A minimal streamed Responses turn: the tool call first, then a final message. */
function toolCallTurn(res, n) {
  const item = n === 1
    ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: JSON.stringify({ cmd: spec.command ?? 'touch ran.txt' }) }
    : { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
  const events = [
    { type: 'response.created', response: { id: `resp_${n}` } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${n}`, usage } },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    requests.push({
      path: req.url,
      host: String(req.headers.host ?? ''),
      authorization: classify(req.headers.authorization),
      leakedHeaders: Object.entries(req.headers)
        .filter(([name, value]) => name !== 'authorization' && hasDummy(value)).map(([name]) => name),
      bodyHasDummy: hasDummy(Buffer.concat(chunks).toString('utf8')),
    });
    if (spec.respond === 'tool-call' && req.url.startsWith('/v1/responses')) return toolCallTurn(res, ++responsesSeen);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'echo' } }));
    if (req.url.startsWith('/v1/responses')) setTimeout(() => abort.abort(), 300);
  });
});

server.listen(spec.listen.port, spec.listen.host, async () => {
  const codex = new Codex({ codexPathOverride: spec.codexBin, env: spec.env, config: spec.config });
  const options = {
    model: spec.model, workingDirectory: spec.cwd, skipGitRepoCheck: true,
    sandboxMode: spec.sandboxMode ?? 'read-only', approvalPolicy: 'never',
  };
  const thread = spec.resumeId ? codex.resumeThread(spec.resumeId, options) : codex.startThread(options);
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
  let threadId = spec.resumeId ?? null;
  try {
    const { events } = await thread.runStreamed('ping', { signal: abort.signal });
    for await (const event of events) if (event.type === 'thread.started') threadId = event.thread_id;
  } catch {
    // 401 or the abort above: the requests are the result.
  }
  clearTimeout(timer);
  server.close();
  process.stdout.write(`${JSON.stringify({ requests, threadId })}\n`);
  process.exit(0);
});
