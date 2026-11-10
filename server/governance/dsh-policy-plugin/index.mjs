/**
 * dsh-policy-plugin — the Nassaj-owned policy plugin of the DeepSeek Harness, on dsh's PUBLIC
 * tools contract only (T-2091, ADR-225; measured: __tests__/fixtures/t2091-stage0). Loaded from
 * the Nassaj --patch layer by relative path; index.mjs and package.json are sha256-pinned in
 * server/modules/providers/list/dsh/dsh-launch.js. package.json engines.dsh is enforced by dsh:
 * on an incompatible dsh this row is disabled, the handshake never comes and Nassaj refuses
 * the launch (P4). Uses node: imports and ctx only.
 *
 * Every decision is the Nassaj server's, over fd 3 (newline-delimited JSON):
 *  - boot probes, then hello: P1 the public functions exist (dsh_cap_tools_api); P2 a probe
 *    call through ctx.tools.execute reaches this listener, the guard denies it without a
 *    permit and lets it reach UNKNOWN_TOOL with one (dsh_cap_gate); P3 restrict exists
 *    (non-fatal); the server answers with the tools it allows (P4 = the answer itself);
 *  - tools/pre-execute (prepend, global): names outside the allowed set, arguments failing the
 *    tool's own schema or not pure JSON are denied here; otherwise the server decides. Only an
 *    allow records a one-use permit keyed (agent id, callId, sha256 of canonical arguments);
 *  - ctx.tools.guard (monotonic, every agent): a call without its matching permit is denied.
 *    Outside a probe that means a listener ahead of ours allowed it without next():
 *    reported as dsh_gate_bypassed (the server ends the turn);
 *  - tools/post-execute reports the outcome (PostToolUse hooks; kill on an undecided result);
 *    tools/result clears the permit; a permitted call whose result skipped post-execute is
 *    reported as dsh_post_hook_skipped;
 *  - agent/pre-step hides the tools the server did not allow (best effort, from that agent's
 *    next step; the deny above is the guarantee).
 * A lost channel denies every call.
 */
import crypto from 'node:crypto';
import net from 'node:net';

export const name = 'nassaj-policy';
export const inject = ['tools'];

const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'items', 'description', 'title']);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const PROBE_TOOL = '__nassaj_probe__';
const PROBE_PREFIX = 'nassaj-probe-';
const API = ['guard', 'execute', 'definitions', 'get'];

/** Canonical JSON (sorted keys, no spaces), or null when the value is not pure JSON. */
export function canonicalJson(value) {
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
export const argumentHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Schema keywords this validator does not implement (checked at boot). */
export function unsupportedKeywords(schema, at = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at}: not a schema`];
  const issues = Object.keys(schema).filter((key) => !KEYWORDS.has(key)).map((key) => `${at}.${key}`);
  for (const type of [].concat(schema.type ?? [])) if (!TYPES.has(type)) issues.push(`${at}.type=${type}`);
  for (const [key, sub] of Object.entries(schema.properties ?? {})) issues.push(...unsupportedKeywords(sub, `${at}.${key}`));
  if (schema.items !== undefined) issues.push(...unsupportedKeywords(schema.items, `${at}[]`));
  if (typeof schema.additionalProperties === 'object') issues.push(...unsupportedKeywords(schema.additionalProperties, `${at}.*`));
  return issues;
}

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array'
  : Number.isInteger(value) ? 'integer' : typeof value);
const typeMatches = (want, value) => want === typeOf(value) || (want === 'number' && typeOf(value) === 'integer');

/** The first schema violation of `value`, or null. */
export function schemaError(schema, value, at = '$') {
  const types = [].concat(schema.type ?? []);
  if (types.length && !types.some((type) => typeMatches(type, value))) return `${at}: expected ${types.join('|')}`;
  if (schema.enum && !schema.enum.some((option) => canonicalJson(option) === canonicalJson(value))) return `${at}: not in enum`;
  if (typeOf(value) === 'array' && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      const error = schemaError(schema.items, value[i], `${at}[${i}]`);
      if (error) return error;
    }
  }
  if (typeOf(value) !== 'object') return null;
  for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${at}.${key}: required`;
  for (const [key, item] of Object.entries(value)) {
    const sub = schema.properties?.[key];
    if (sub) { const error = schemaError(sub, item, `${at}.${key}`); if (error) return error; continue; }
    if (schema.additionalProperties === false) return `${at}.${key}: not allowed`;
    if (typeof schema.additionalProperties === 'object') {
      const error = schemaError(schema.additionalProperties, item, `${at}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

/** A request/response client over fd 3. */
function channel(fd) {
  const socket = new net.Socket({ fd, readable: true, writable: true });
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let closed = false;
  const fail = () => {
    closed = true;
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      let reply = null;
      try { reply = JSON.parse(buffer.slice(0, at)); } catch { reply = null; }
      buffer = buffer.slice(at + 1);
      const resolve = pending.get(reply?.id);
      if (resolve) { pending.delete(reply.id); resolve(reply); }
      if (pending.size === 0) socket.unref?.();
    }
  });
  socket.on('error', fail);
  socket.on('close', fail);
  socket.unref?.();
  const write = (frame) => { if (!closed) socket.write(`${JSON.stringify(frame)}\n`); };
  return {
    request: (frame) => (closed ? Promise.resolve(null) : new Promise((resolve) => {
      const id = (nextId += 1);
      pending.set(id, resolve);
      socket.ref?.(); // an awaited decision keeps the process alive; idle, the channel does not
      write({ ...frame, id });
    })),
    notify: (frame) => write(frame),
  };
}

const failed = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true, error: { message } });
const agentOf = (agent) => (agent ? { id: agent.id ?? null, type: agent.options?.preset ?? agent.options?.name ?? null } : null);
const textOf = (result) => (result?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').slice(0, 65536);
/** One-use permit key: agent, callId and tool name (the arguments hash is the permit's value). */
const permitKey = (exec) => `${exec.agent?.id ?? ''}\u0000${exec.callId}\u0000${exec.name}`;
/** A boot-probe call: only while the probes run, before the handshake (qa I1). */
const isProbe = (state, exec) => state.probing && exec.name === PROBE_TOOL && String(exec.callId).startsWith(PROBE_PREFIX);
const hashOf = (args) => { const text = canonicalJson(args); return text === null ? null : argumentHash(text); };

/** tools/pre-execute: Nassaj's decision; only an allow writes the permit. */
function preExecute(ctx, server, state) {
  return async (exec, next) => {
    // The boot probe exists only BEFORE the handshake (qa I1): afterwards the name is just unmapped.
    if (isProbe(state, exec)) {
      state.probeSeen.add(exec.callId);
      if (exec.callId.endsWith('-permit')) state.permits.set(permitKey(exec), hashOf(exec.arguments));
      return next();
    }
    await state.ready;
    if (!state.allowed?.has(exec.name)) return { kind: 'deny', reason: `Nassaj: tool "${exec.name}" is not allowed.` };
    const definition = ctx.tools.executable?.(exec.name, exec.agent, exec.toolSet) ?? ctx.tools.get(exec.name, exec.agent, exec.toolSet);
    if (!definition) return { kind: 'deny', reason: `Nassaj: tool "${exec.name}" is not available to this agent.` };
    const hash = hashOf(exec.arguments);
    if (hash === null || typeOf(exec.arguments) !== 'object') return { kind: 'deny', reason: 'Nassaj: tool arguments must be a pure JSON object.' };
    const invalid = schemaError(definition.parameters ?? {}, exec.arguments);
    if (invalid) return { kind: 'deny', reason: `Nassaj: invalid arguments (${invalid}).` };
    const reply = await server.request({ type: 'pre', callId: exec.callId, rootCallId: exec.rootCallId ?? null, tool: exec.name,
      args: exec.arguments, hash, agent: agentOf(exec.agent) });
    if (reply?.decision !== 'allow') return { kind: 'deny', reason: reply?.reason || 'Nassaj: the call was not approved.' };
    state.permits.set(permitKey(exec), hash);
    return next();
  };
}

/** ctx.tools.guard: no matching permit, no body. */
function guard(server, state) {
  return (exec) => {
    const key = permitKey(exec);
    const permit = state.permits.get(key);
    if (permit !== undefined && permit === hashOf(exec.arguments)) {
      state.permitted.add(key);
      return undefined;
    }
    if (!isProbe(state, exec)) {
      server.notify({ type: 'incident', code: 'dsh_gate_bypassed', callId: exec.callId, tool: exec.name, agent: agentOf(exec.agent) });
    }
    return 'Nassaj: this call has no matching permit.';
  };
}

/** Registers the listeners and the guard. */
function register(ctx, server, state) {
  ctx.on('tools/pre-execute', preExecute(ctx, server, state), { prepend: true, global: true });
  if (typeof ctx.tools.guard === 'function') ctx.tools.guard(guard(server, state));
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (isProbe(state, exec)) return next(); // boot probes: nothing to report
    state.posted.add(permitKey(exec));
    const reply = await server.request({ type: 'post', callId: exec.callId, tool: exec.name, hash: hashOf(exec.arguments),
      isError: !!result?.isError, bodyRan: state.permitted.has(permitKey(exec)), agent: agentOf(exec.agent), output: textOf(result) });
    const decision = await next();
    if (reply?.block) return { kind: 'block', feedback: [{ type: 'text', text: reply.reason || 'Blocked by a Claude hook.' }] };
    const context = (reply?.additionalContext ?? []).filter((item) => typeof item === 'string' && item);
    if (context.length === 0 || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
    return { ...decision, content: [...(decision.content ?? result.content ?? []), ...context.map((item) => ({ type: 'text', text: item }))] };
  }, { prepend: true, global: true });
  ctx.on('tools/result', (exec, result) => {
    const key = permitKey(exec);
    const probe = isProbe(state, exec);
    if (!probe && state.permitted.has(key) && !state.posted.has(key)) {
      server.notify({ type: 'incident', code: 'dsh_post_hook_skipped', callId: exec.callId, tool: exec.name });
    }
    for (const set of [state.permitted, state.posted]) set.delete(key);
    state.permits.delete(key);
    if (!probe) {
      server.notify({ type: 'result', callId: exec.callId, tool: exec.name, isError: !!result?.isError, agent: agentOf(exec.agent) });
    }
  }, { global: true });
  const restricted = new WeakSet();
  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload?.agent;
    if (agent && !restricted.has(agent) && state.hidden.length) {
      restricted.add(agent);
      try { agent.ctx.tools.restrict({ deny: state.hidden }); } catch { /* best effort: the deny is the guarantee */ }
    }
    return next();
  });
}

/** P2: a probe call without, then with, a permit. */
async function probeGate(ctx, state) {
  const outcome = async (callId) => {
    const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: callId, name: PROBE_TOOL, arguments: '{}' }],
      signal: new AbortController().signal });
    return batch?.results?.find((entry) => entry.callId === callId)?.result ?? null;
  };
  try {
    const denied = await outcome(`${PROBE_PREFIX}gate`);
    const unknown = await outcome(`${PROBE_PREFIX}gate-permit`);
    const ok = state.probeSeen.size === 2 && denied?.isError === true && /no matching permit/.test(denied?.error?.message ?? '')
      && unknown?.error?.info?.code === 'UNKNOWN_TOOL';
    return { ok, seen: state.probeSeen.size, denied: denied?.error?.message ?? null, unknown: unknown?.error?.info?.code ?? null };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/** The hello frame after the probes. */
async function hello(ctx, state) {
  const missing = API.filter((fn) => typeof ctx.tools?.[fn] !== 'function');
  const probes = { P1: { ok: missing.length === 0, missing } };
  state.probing = true;
  try {
    probes.P2 = probes.P1.ok ? await probeGate(ctx, state) : { ok: false, skipped: true };
  } finally {
    state.probing = false;
  }
  probes.P3 = { ok: typeof ctx.tools?.restrict === 'function' };
  const definitions = probes.P1.ok ? ctx.tools.definitions() : [];
  return { type: 'hello', protocol: 2, probes,
    tools: definitions.map((definition) => ({ name: definition.name, schema: definition.parameters ?? {},
      schemaIssues: unsupportedKeywords(definition.parameters ?? {}) })) };
}

/** @param {any} ctx @param {{ channelFd?: number }} [config] */
export function apply(ctx, config = {}) {
  const server = channel(Number.isInteger(config?.channelFd) ? config.channelFd : 3);
  let markReady;
  const state = { allowed: null, probing: false, hidden: [], permits: new Map(), permitted: new Set(), posted: new Set(), probeSeen: new Set(),
    ready: new Promise((resolve) => { markReady = resolve; }) };
  register(ctx, server, state);
  const handshake = async () => {
    const reply = await server.request(await hello(ctx, state));
    state.allowed = reply?.ok === true && Array.isArray(reply.allowedTools) ? new Set(reply.allowedTools) : new Set();
    state.hidden = Array.isArray(reply?.hiddenTools) ? reply.hiddenTools : [];
    markReady();
  };
  const appReady = ctx.get?.('appReady');
  if (appReady?.onReady) appReady.onReady(() => { void handshake(); });
  else ctx.on('ready', handshake);
}
