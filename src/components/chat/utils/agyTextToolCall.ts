/**
 * B-1665: the Antigravity (agy) model sometimes writes its `send_message` tool
 * call as literal reply text:
 *
 *   send_message(Recipient="ibrahim", RecipientName="parent", message="…")
 *
 * No adapter turns that into a tool row yet (follow-up: emit a tool_use row in
 * the antigravity provider adapter), so the reply showed raw call syntax. This
 * pure parser lifts such calls out of the text so the view can render them as
 * cards. It is deliberately strict: only whole lines that start with
 * `send_message(`, only the known keyword arguments, double-quoted values with
 * backslash escapes. Anything else leaves the content untouched.
 */

export interface AgyTextToolCall {
  recipient: string;
  recipientName: string;
  message: string;
}

export interface AgyTextExtraction {
  body: string;
  calls: AgyTextToolCall[];
}

const CALL_OPEN = 'send_message(';
const KNOWN_ARGS = new Set(['Recipient', 'RecipientName', 'message']);
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };

interface Cursor { text: string; pos: number }

const skipSpaces = (c: Cursor) => { while (c.pos < c.text.length && /[ \t\r\n,]/.test(c.text[c.pos])) c.pos += 1; };

function readQuoted(c: Cursor): string | null {
  if (c.text[c.pos] !== '"') return null;
  let out = '';
  for (c.pos += 1; c.pos < c.text.length; c.pos += 1) {
    const ch = c.text[c.pos];
    if (ch === '"') { c.pos += 1; return out; }
    if (ch === '\\' && c.pos + 1 < c.text.length) {
      c.pos += 1;
      out += ESCAPES[c.text[c.pos]] ?? `\\${c.text[c.pos]}`;
    } else out += ch;
  }
  return null;
}

/** Parses the argument list after `send_message(`; returns null on any deviation. */
function readCall(c: Cursor): AgyTextToolCall | null {
  const args: Record<string, string> = {};
  for (;;) {
    skipSpaces(c);
    if (c.text[c.pos] === ')') { c.pos += 1; break; }
    const name = /^[A-Za-z_]+/.exec(c.text.slice(c.pos))?.[0];
    if (!name || !KNOWN_ARGS.has(name) || c.text[c.pos + name.length] !== '=') return null;
    c.pos += name.length + 1;
    const value = readQuoted(c);
    if (value === null) return null;
    args[name] = value;
  }
  if (typeof args.message !== 'string') return null;
  return { recipient: args.Recipient ?? '', recipientName: args.RecipientName ?? '', message: args.message };
}

/** Index of the next `send_message(` that starts a line (leading spaces allowed). */
function nextCallStart(text: string, from: number): number {
  for (let i = text.indexOf(CALL_OPEN, from); i !== -1; i = text.indexOf(CALL_OPEN, i + 1)) {
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    if (/^[ \t]*$/.test(text.slice(lineStart, i))) return i;
  }
  return -1;
}

export function extractAgyTextToolCalls(content: string): AgyTextExtraction {
  const unchanged = { body: content, calls: [] };
  if (!content.includes(CALL_OPEN)) return unchanged;
  const calls: AgyTextToolCall[] = [];
  const kept: string[] = [];
  let last = 0;
  for (let start = nextCallStart(content, 0); start !== -1; start = nextCallStart(content, last)) {
    const cursor = { text: content, pos: start + CALL_OPEN.length };
    const call = readCall(cursor);
    const lineEnd = content.indexOf('\n', cursor.pos);
    const rest = content.slice(cursor.pos, lineEnd === -1 ? content.length : lineEnd);
    if (!call || rest.trim()) return unchanged;
    calls.push(call);
    kept.push(content.slice(last, start));
    last = lineEnd === -1 ? content.length : lineEnd + 1;
  }
  if (calls.length === 0) return unchanged;
  kept.push(content.slice(last));
  return { body: kept.join('').replace(/\n{3,}/g, '\n\n').trim(), calls };
}
