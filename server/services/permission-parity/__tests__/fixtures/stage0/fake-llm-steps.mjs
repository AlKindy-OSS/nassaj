// T-2089 S0 probe-only fake Anthropic-Messages server. Steps come from a
// `NASSAJ_STEPS <json>` directive in the FIRST user message of each request;
// step i is answered when the history holds i assistant turns.
// step: {name, raw} -> tool_use with raw partial_json text; {text} -> text reply.
import fs from 'node:fs';
import http from 'node:http';

const [port, logFile] = process.argv.slice(2);
let seq = 0;
const MODELS = { object: 'list', data: ['deepseek-v4-flash', 'deepseek-v4-pro'].map((id) => ({
  id, object: 'model', owned_by: 'deepseek', context_window: 1000000, max_output_tokens: 65536,
  input_modalities: ['text'], output_modalities: ['text'], api_capabilities: { anthropic_messages: {} } })) };
const start = (id) => ({ type: 'message_start', message: { id, type: 'message', role: 'assistant',
  model: 'deepseek-v4-flash', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const textOf = (m) => (typeof m.content === 'string' ? m.content
  : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
function reply(step) {
  const id = `msg_probe_${(seq += 1)}`;
  if (step.text !== undefined) return [start(id),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  return [start(id),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_probe_${seq}`, name: step.name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: step.raw } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
}
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    fs.appendFileSync(logFile, `${JSON.stringify({ method: req.method, url: req.url, body })}\n`);
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(MODELS)); return;
    }
    if (req.method !== 'POST' || !/\/messages$/.test(req.url)) { res.writeHead(404); res.end(); return; }
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const all = msgs.filter((m) => m.role === 'user').map(textOf).join('\n');
    const m = /SUB_STEPS (\[.*?\]) END_SUB/s.exec(all) ?? /NASSAJ_STEPS (\[.*\]) END_STEPS/s.exec(all);
    const steps = m ? JSON.parse(m[1]) : [{ text: 'no steps' }];
    const done = msgs.filter((x) => x.role === 'assistant').length;
    sse(res, reply(steps[done] ?? { text: 'probe done' }));
  });
}).listen(Number(port), '127.0.0.1');
