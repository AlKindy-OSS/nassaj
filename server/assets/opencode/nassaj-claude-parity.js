/**
 * ADR-226 (B-1759..B-1763): the nassaj OpenCode plugin is a channel client. It decides
 * nothing itself: every tool call goes over fd 3 to the server's parity engine (Claude's
 * hooks, rules and mode), and the plugin only carries out the answer.
 *
 * Protocol `nassaj-opencode-parity/1`, newline-delimited JSON over fd 3 (a socketpair the
 * server created for this child; opencode marks it CLOEXEC, so tool children never hold it):
 *  - server → `{ type: 'challenge', nonce }` (a per-turn nonce, never in env);
 *  - plugin → `{ type: 'hello', id, nonce, pluginDigest, protocol }`; the server writes the
 *    prompt to stdin only after it accepted this hello (`{ id, ok: true }`), so a turn whose
 *    plugin did not load sends nothing to the model;
 *  - `tool.execute.before` → `{ type: 'pre', id, sessionID, callID, tool, args, hash }` →
 *    `{ id, decision, reason }`. Allow: the args are deep-frozen and `output.args` locked, so
 *    a later plugin cannot change what runs. Anything else throws `nassaj:<code>: <reason>`;
 *  - `tool.execute.after` → `{ type: 'post', … , output }` → `{ id, block, reason,
 *    additionalContext }` (Claude's PostToolUse hooks), appended to the tool output;
 *  - `shell.env`: every NASSAJ_* variable is unset for bash children (assigning `undefined`;
 *    `delete` does not remove an inherited variable, stage 0 item 5).
 * No fd 3 at load (a nested opencode started from bash inherits the plugin entry but not fd
 * 3), a refused hello, a lost channel or a server error: every tool call is refused.
 *
 * This plugin must be FIRST in the plugin list (a plugin before it could show it decoy
 * args). Only the plugin function is exported: opencode loads every export as a plugin.
 */
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const PROTOCOL = 'nassaj-opencode-parity/1';
const CHANNEL_FD = 3;
const DENIED = 'permission_denied_by_claude_rule';
const UNAVAILABLE = 'opencode_parity_unavailable';
/** How long the plugin waits for the server's challenge and its hello answer. */
const HELLO_WAIT_MS = 120_000;

const refuse = (code, reason) => { throw new Error(`nassaj:${code}: ${reason}`); };

/** Canonical JSON (sorted keys, no spaces), or null when the value is not pure JSON. */
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.includes(null) ? null : `[${items.join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const item = canonicalJson(value[key]);
    if (item === null) return null;
    parts.push(`${JSON.stringify(key)}:${item}`);
  }
  return `{${parts.join(',')}}`;
}

function argumentHash(value) {
  const text = canonicalJson(value);
  return text === null ? null : createHash('sha256').update(text).digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** sha256 of this file as loaded: the server compares it with the plugin it shipped. */
function ownDigest() {
  return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
}

/** The fd 3 socket, or null. Bun (opencode) needs net.connect; Node needs the Socket ctor. */
function openSocket() {
  try {
    if (!fstatSync(CHANNEL_FD).isSocket()) return null;
    return process.versions.bun
      ? net.connect({ fd: CHANNEL_FD })
      : new net.Socket({ fd: CHANNEL_FD, readable: true, writable: true });
  } catch {
    return null;
  }
}

/** A request/response client over one socket; `closed` once the channel is gone. */
function createChannel(socket) {
  const waiting = new Map();
  const state = { closed: false, challenge: null, onChallenge: null };
  const fail = () => {
    state.closed = true;
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
    state.onChallenge?.(null);
  };
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      let frame = null;
      try { frame = JSON.parse(buffer.slice(0, at)); } catch { frame = null; }
      buffer = buffer.slice(at + 1);
      if (frame?.type === 'challenge' && state.challenge === null) {
        state.challenge = String(frame.nonce ?? '');
        state.onChallenge?.(state.challenge);
      } else if (frame && waiting.has(frame.id)) {
        waiting.get(frame.id)(frame);
        waiting.delete(frame.id);
      }
    }
  });
  socket.on('error', fail);
  socket.on('close', fail);
  return {
    get closed() { return state.closed; },
    challenge: () => new Promise((resolve) => {
      if (state.challenge !== null || state.closed) resolve(state.challenge);
      else state.onChallenge = resolve;
    }),
    /** Sends one request; resolves with its reply, or null when the channel is lost. */
    request(body) {
      if (state.closed) return Promise.resolve(null);
      const id = randomUUID();
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.write(`${JSON.stringify({ ...body, id })}\n`);
      });
    },
  };
}

const withTimeout = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
  promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
});

/** Opens the channel and completes the hello; null means deny-all. */
async function connect() {
  const socket = openSocket();
  if (!socket) return null;
  const channel = createChannel(socket);
  const nonce = await withTimeout(channel.challenge(), HELLO_WAIT_MS);
  if (!nonce) return null;
  const reply = await withTimeout(channel.request({ type: 'hello', nonce, pluginDigest: ownDigest(), protocol: PROTOCOL }),
    HELLO_WAIT_MS);
  return reply?.ok === true ? channel : null;
}

/** The OpenCode plugin. */
export const NassajClaudeParity = async () => {
  const channel = await connect();
  const live = () => channel && !channel.closed;
  return {
    'tool.execute.before': async (input, output) => {
      if (!live()) refuse(UNAVAILABLE, 'nassaj\'s permission channel is not available, so no tool may run');
      const args = output?.args;
      const reply = await channel.request({ type: 'pre', sessionID: input?.sessionID, callID: input?.callID,
        tool: String(input?.tool ?? ''), args, hash: argumentHash(args) });
      if (reply?.decision !== 'allow') {
        if (!reply) refuse(UNAVAILABLE, 'nassaj\'s permission channel was lost');
        refuse(reply.code || DENIED, reply.reason || 'Claude\'s rules do not allow this call');
      }
      deepFreeze(args);
      Object.defineProperty(output, 'args', { value: args, writable: false, configurable: false, enumerable: true });
    },
    'tool.execute.after': async (input, output) => {
      if (!live()) return;
      const reply = await channel.request({ type: 'post', sessionID: input?.sessionID, callID: input?.callID,
        tool: String(input?.tool ?? ''), hash: argumentHash(input?.args),
        output: typeof output?.output === 'string' ? output.output : '' });
      const notes = [...(reply?.block && reply.reason ? [reply.reason] : []),
        ...(Array.isArray(reply?.additionalContext) ? reply.additionalContext : [])].filter((n) => typeof n === 'string' && n);
      if (notes.length && typeof output?.output === 'string') output.output += `\n${notes.join('\n')}`;
    },
    'shell.env': async (_input, output) => {
      if (!output?.env) return;
      for (const key of new Set([...Object.keys(process.env), ...Object.keys(output.env)])) {
        if (key.startsWith('NASSAJ_')) output.env[key] = undefined;
      }
    },
  };
};
