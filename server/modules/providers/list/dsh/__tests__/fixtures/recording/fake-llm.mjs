// Recording-only fake Anthropic-Messages server for dsh (T-2086 S1). Not shipped.
// Usage: node fake-llm.mjs <port> <logFile> <label>
import fs from 'node:fs';
import http from 'node:http';

const [port, logFile, label = 'primary'] = process.argv.slice(2);
const MODELS = {
  object: 'list',
  data: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-flash'].map((id) => ({
    id, object: 'model', owned_by: 'deepseek', context_window: 1000000, max_output_tokens: 65536,
    input_modalities: ['text'], output_modalities: ['text'],
    api_capabilities: { anthropic_messages: {} },
  })),
};

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

let seq = 0;
function textReply(text) {
  const id = `msg_fake_${(seq += 1)}`;
  const parts = text.match(/.{1,12}/g) ?? [text];
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
      content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...parts.map((p) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: parts.length } },
    { type: 'message_stop' },
  ];
}
function toolReply(name, input) {
  const id = `msg_fake_${(seq += 1)}`;
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
      content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fake_${seq}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}

const lastUserText = (body) => {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (blocks.some((b) => b.type === 'tool_result')) return { toolResult: true, blocks };
    return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
  }
  return { text: '' };
};

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    fs.appendFileSync(logFile, `${JSON.stringify({ label, method: req.method, url: req.url, headers: req.headers, body })}\n`);
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(MODELS));
      return;
    }
    if (req.method === 'POST' && /\/messages$/.test(req.url)) {
      const last = lastUserText(body ?? {});
      if (last.toolResult) { sse(res, textReply('Tool step finished.')); return; }
      const directive = /NASSAJ_TOOL (\{.*\})/.exec(last.text ?? '');
      if (directive) {
        const { name, input } = JSON.parse(directive[1]);
        sse(res, toolReply(name, input));
        return;
      }
      sse(res, textReply(`Hello from fake DeepSeek: ${(last.text ?? '').slice(0, 40)}`));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: req.url } }));
  });
}).listen(Number(port), '127.0.0.1', () => process.stdout.write(`listening ${port}\n`));
