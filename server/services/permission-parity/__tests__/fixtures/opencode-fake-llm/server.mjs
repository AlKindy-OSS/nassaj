// ADR-226 stage 0 / acceptance: scripted OpenAI-compatible chat-completions server (loopback only).
// Usage: node server.mjs <port|0> <log.jsonl> [shimDir]  -> prints `LISTENING <port>` on stdout.
//
// K1 (ADR-226 §6.0) shim gate: when shimDir is given, every script (main and SUB) must start with
// the step `{tool:'bash', args:{command:'command -v ssh pm2'}}`, and no later step is served unless
// that call's result is exactly `<shimDir>/ssh` and `<shimDir>/pm2`. Otherwise the reply is the
// text `shim check failed: aborted` (no further tool call) and an `abort` row is logged.
//
// Script: the FIRST user message of a request holds `NASSAJ_STEPS <json> END_STEPS`; a task child
// session's prompt holds `SUB_STEPS <json> END_SUB` (preferred when present). Step i is answered
// when the history holds i assistant messages.
//   step {tool, args, id?}  -> one streamed tool call (id defaults to call_<seq>; a fixed id
//                              lets a test reuse a callID across sessions, ADR-226 M3)
//   step {calls:[{tool,args,id?}]} -> several tool calls in one assistant message
//   step {text}             -> a final text reply
// A request without `tools` (title/summary generation) gets a short text reply.
// Every request is appended to the log with a ms timestamp, so ordering can be asserted.
import fs from 'node:fs';
import http from 'node:http';

const [portArg = '0', logFile, shimDir] = process.argv.slice(2);
export const SHIM_CHECK = 'command -v ssh pm2';
let seq = 0;

const textOf = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

function chunk(delta, finish = null) {
  return { id: `chatcmpl-probe-${seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: 'probe', choices: [{ index: 0, delta, finish_reason: finish }] };
}

function framesFor(step) {
  seq += 1;
  if (step.text !== undefined) {
    return [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop')];
  }
  const calls = step.calls ?? [step];
  const toolCalls = calls.map((c, index) => ({ index, id: c.id ?? `call_probe_${seq}_${index}`, type: 'function',
    function: { name: c.tool, arguments: typeof c.raw === 'string' ? c.raw : JSON.stringify(c.args ?? {}) } }));
  return [chunk({ role: 'assistant', content: null, tool_calls: toolCalls }), chunk({}, 'tool_calls')];
}

/** The first `<open> … <close>` span that parses as a JSON array (also when the prompt was escaped). */
function scriptsIn(text, open, close) {
  const found = [];
  for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at + 1)) {
    const end = text.indexOf(close, at);
    for (let stop = end; stop >= 0; stop = text.indexOf(close, stop + 1)) {
      const raw = text.slice(at + open.length, stop).trim();
      // `opencode run` quotes an argv message that has spaces as "…" escaping only `"` (not `\\`),
      // so an argv prompt arrives with every `"` as `\\"`; a stdin prompt arrives verbatim.
      const candidates = [() => JSON.parse(raw), () => JSON.parse(raw.replace(/\\"/g, '"')), () => JSON.parse(JSON.parse(`"${raw}"`))];
      for (const parse of candidates) {
        try { const v = parse(); if (Array.isArray(v)) { found.push(v); break; } } catch { /* next */ }
      }
      if (found.length) break;
    }
    if (found.length) break;
  }
  return found[0] ?? null;
}

function stepsFor(messages) {
  const users = messages.filter((m) => m.role === 'user').map(textOf).join('\n');
  return scriptsIn(users, 'SUB_STEPS ', ' END_SUB') ?? scriptsIn(users, 'NASSAJ_STEPS ', ' END_STEPS');
}

const logRow = (row) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...row })}\n`); };

/** The K1 gate: null when the next step may be served, else the abort reason. */
function shimGate(steps, messages) {
  if (!shimDir) return null;
  if (steps[0]?.tool !== 'bash' || steps[0]?.args?.command !== SHIM_CHECK) return 'script does not start with the shim check';
  const done = messages.filter((m) => m.role === 'assistant').length;
  if (done === 0) return null;
  const first = messages.find((m) => m.role === 'tool');
  const lines = textOf(first).trim().split('\n');
  const want = [`${shimDir}/ssh`, `${shimDir}/pm2`];
  return lines.length === 2 && lines[0] === want[0] && lines[1] === want[1] ? null : `shim check output: ${lines.join(' | ')}`;
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), method: req.method, url: req.url, body })}\n`);
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'probe', object: 'model', owned_by: 'nassaj' }] }));
      return;
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end(); return; }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    let step;
    if (!Array.isArray(body?.tools) || body.tools.length === 0) step = { text: 'Probe title' };
    else {
      const steps = stepsFor(messages) ?? [{ text: 'no steps' }];
      const abort = stepsFor(messages) ? shimGate(steps, messages) : null;
      if (abort) { logRow({ abort }); step = { text: 'shim check failed: aborted' }; }
      else step = steps[messages.filter((m) => m.role === 'assistant').length] ?? { text: 'probe done' };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const frame of framesFor(step)) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
server.listen(Number(portArg), '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
