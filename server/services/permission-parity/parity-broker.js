/**
 * parity-broker — the Nassaj side of the fd-3 policy channel of a harness that mirrors
 * Claude (dsh: T-2089/T-2091, ADR-225; OpenCode: ADR-226 §1, §2). Newline-delimited JSON;
 * requests carry `id`, replies echo it. The harness plugin decides nothing on its own.
 *
 *  - hello: exactly one, checked by the harness `helloPolicy` (dsh: capability probes and
 *    the tool map, dsh-parity-broker.js; OpenCode: the per-turn nonce, the plugin content
 *    digest and the protocol literal). A refused or second hello records `state.refusal`
 *    and kills the harness. A call before an accepted hello is denied.
 *  - pre: decisions are keyed by sessionID + callID. A key whose previous call has not
 *    settled is a concurrent duplicate: denied and logged (`parity_call_replayed`). Stage 0
 *    (ADR-226 item 7) measured a local model server reusing one callID inside ONE session
 *    for two legitimate calls, so with `callIdReuse: 'afterSettle'` (the default) a key may
 *    be decided again once its previous call settled (a deny settles at once, an allow at
 *    its post); dsh keeps `'never'`. The engine decides (hooks + rules + mode); ask goes to
 *    the member (`askMember`) and only `approve` allows. Every decision is logged with the
 *    argument hash (`requireHash`: the plugin must send it; else checked when present).
 *  - post: PostToolUse hooks run for every Claude call of the decision; a result with no
 *    recorded allow for the same key and hash kills the harness, unless it failed without
 *    its body running.
 *  - checkResult / toolResult: the same rule for the harness's own result stream (dsh ACP
 *    view; OpenCode stdout tool parts — main session only: subagent parts never reach
 *    stdout, stage 0 item 9). `strictFailures`: a failed result needs a recorded decision
 *    too (OpenCode: the hook fires for every call, so no record means a bypass).
 */
import crypto from 'node:crypto';

export const BROKER_CODES = Object.freeze({
  helloRefused: 'parity_hello_refused',
  replayedCall: 'parity_call_replayed',
  undecidedResult: 'parity_undecided_result',
  beforeHello: 'parity_call_before_hello',
});

/** Canonical JSON (sorted keys, no spaces), or null when not pure JSON (mirrors the plugins). */
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

/** sha256 of the canonical JSON, or null when the value is not pure JSON. */
export const argumentHash = (value) => {
  const text = canonicalJson(value);
  return text === null ? null : crypto.createHash('sha256').update(text).digest('hex');
};

/** The decision key of one call: sessionID + callID (dsh has no sessionID). */
export const callKey = (sessionID, callId) => `${typeof sessionID === 'string' ? sessionID : ''}\u0000${callId}`;

/**
 * A hello policy from its options: an object with `check(frame)`, or the OpenCode triple
 * `{ nonce, pluginDigest, protocol }` (every field must equal the per-turn value).
 * @returns {{ check: (frame: any) => { ok: true, reply?: object, state?: object } | { ok: false, code: string, detail?: object } }}
 */
export function normalizeHelloPolicy(policy) {
  if (policy && typeof policy.check === 'function') return policy;
  const expected = policy ?? {};
  return {
    check(frame) {
      for (const field of ['nonce', 'pluginDigest', 'protocol']) {
        if (typeof expected[field] !== 'string' || frame?.[field] !== expected[field]) {
          return { ok: false, code: BROKER_CODES.helloRefused, detail: { reason: `hello ${field} mismatch` } };
        }
      }
      return { ok: true };
    },
  };
}

/**
 * @param {{ engine: { decideTool: Function, hooks?: { postToolUse: Function } }, kill: () => void,
 *   onIncident: (incident: object) => void, askMember?: (card: object) => Promise<string>,
 *   helloPolicy: object, log?: (entry: object) => void, callIdReuse?: 'afterSettle'|'never',
 *   requireHash?: boolean, strictFailures?: boolean, fatalIncidents?: Iterable<string> }} deps
 */
export function createParityBroker({ engine, kill, onIncident, askMember = async () => 'reject', helloPolicy, log = () => {},
  callIdReuse = 'afterSettle', requireHash = false, strictFailures = false, fatalIncidents = [] }) {
  const policy = normalizeHelloPolicy(helloPolicy);
  const fatal = new Set(fatalIncidents);
  const state = { hello: false, refusal: null, calls: new Map(), bodyRan: new Set(), killed: false };
  let onHello;
  /** Settles true on an accepted handshake, false on a refusal or kill. */
  const handshake = new Promise((resolve) => { onHello = () => resolve(true); state.failHandshake = () => resolve(false); });
  const incident = (code, extra = {}) => onIncident({ code, ...extra });
  const killFor = (code, extra) => {
    incident(code, extra);
    state.killed = true;
    state.killCode ??= code;
    state.failHandshake();
    kill();
  };

  function hello(frame) {
    if (state.hello || state.refusal) {
      state.refusal = BROKER_CODES.helloRefused;
      killFor(BROKER_CODES.helloRefused, { reason: 'second hello' });
      return { ok: false, code: BROKER_CODES.helloRefused };
    }
    const result = policy.check(frame);
    if (!result.ok) {
      state.refusal = result.code;
      killFor(result.code, result.detail ?? {});
      return { ok: false, code: result.code };
    }
    state.hello = true;
    Object.assign(state, result.state ?? {});
    onHello();
    return { ok: true, ...(result.reply ?? {}) };
  }

  /** The records of one key (in arrival order). */
  const recordsOf = (key) => {
    if (!state.calls.has(key)) state.calls.set(key, []);
    return state.calls.get(key);
  };

  /** Whether `key` may be decided now; logs the incident when not. */
  function admits(key, callId, sessionID) {
    const records = recordsOf(key);
    const blocked = callIdReuse === 'never' ? records.length > 0 : records.some((record) => !record.settled);
    if (blocked) incident(BROKER_CODES.replayedCall, { callId, sessionID: sessionID ?? null });
    return !blocked;
  }

  async function pre(frame) {
    const callId = frame.callID ?? frame.callId;
    const { sessionID, tool, args, hash, agent } = frame;
    if (!state.hello) return { decision: 'deny', reason: BROKER_CODES.beforeHello };
    if (typeof callId !== 'string' || callId === '') {
      incident(BROKER_CODES.replayedCall, { callId: callId ?? null });
      return { decision: 'deny', reason: 'Nassaj: missing call id.' };
    }
    const key = callKey(sessionID, callId);
    if (!admits(key, callId, sessionID)) return { decision: 'deny', reason: 'Nassaj: duplicate call id.' };
    const own = argumentHash(args);
    const record = { hash: own, decision: 'deny', settled: true };
    recordsOf(key).push(record);
    if (own === null || ((hash !== undefined || requireHash) && own !== hash)) {
      return { decision: 'deny', reason: 'Nassaj: argument hash mismatch.' };
    }
    record.settled = false;
    const verdict = await engine.decideTool({ callId, sessionID, tool, args, agent: agent?.id ? agent : undefined });
    let decision = verdict.decision === 'allow' ? 'allow' : 'deny';
    if (verdict.decision === 'ask') {
      const answer = await askMember({ callId, sessionID, tool, args, claude: verdict.claude, claudeCalls: verdict.claudeCalls,
        reason: verdict.reason, agent });
      decision = answer === 'approve' ? 'allow' : 'deny';
    }
    Object.assign(record, { decision, claude: verdict.claude, claudeCalls: verdict.claudeCalls, settled: decision !== 'allow' });
    log({ callId, sessionID: sessionID ?? null, tool, hash: own, decision, engine: verdict.decision, agent: agent?.id ?? null });
    return { decision, reason: decision === 'allow' ? undefined : (verdict.reason || 'Nassaj: not approved.') };
  }

  /**
   * Kills the harness when a result has no recorded allow for the same key and hash
   * (`hash` undefined: not compared). A failure whose body never ran needs no allow.
   * @returns {boolean} whether a recorded allow covers the result
   */
  function checkResult(key, hash, { isError, bodyRan }) {
    const records = state.calls.get(key) ?? [];
    const decided = records.some((record) => record.decision === 'allow' && (hash === undefined || record.hash === hash));
    const excused = isError && !bodyRan && (!strictFailures || records.length > 0);
    if (!decided && !excused) killFor(BROKER_CODES.undecidedResult, { key: key.replace('\u0000', ' ') });
    return decided;
  }

  /**
   * The harness result stream: `{ sessionID, callID|callId, input, status }` (completed|error|failed).
   * A result also settles its call: OpenCode fires no `tool.execute.after` when the body throws.
   */
  function toolResult({ sessionID, callID, callId, input, status }) {
    if (!['completed', 'error', 'failed'].includes(status)) return true;
    const key = callKey(sessionID, callID ?? callId);
    const hash = input === undefined ? undefined : argumentHash(input);
    const decided = checkResult(key, hash, { isError: status !== 'completed', bodyRan: state.bodyRan.has(key) });
    const record = (state.calls.get(key) ?? []).find((entry) => !entry.settled && (hash === undefined || entry.hash === hash));
    if (record) record.settled = true;
    return decided;
  }

  /** PostToolUse hooks for every Claude call of the decision. */
  async function postHooks(record, frame) {
    const calls = record.claudeCalls ?? (record.claude ? [record.claude] : []);
    const results = await Promise.all(calls.map((claude) => engine.hooks.postToolUse({ tool_name: claude.tool_name,
      tool_input: claude.tool_input, tool_use_id: frame.callID ?? frame.callId, agent: frame.agent?.id ? frame.agent : undefined,
      tool_response: { output: frame.output ?? '' } })));
    const blocking = results.find((result) => result.block);
    return { block: Boolean(blocking), reason: blocking?.reason, additionalContext: results.flatMap((result) => result.additionalContext ?? []) };
  }

  async function post(frame) {
    const key = callKey(frame.sessionID, frame.callID ?? frame.callId);
    if (frame.bodyRan) state.bodyRan.add(key);
    const hash = frame.hash ?? (requireHash ? null : undefined);
    const decided = checkResult(key, hash, { isError: frame.isError, bodyRan: frame.bodyRan });
    const record = (state.calls.get(key) ?? []).findLast((entry) => entry.decision === 'allow' && (hash === undefined || entry.hash === hash));
    if (record) record.settled = true;
    if (!decided || !record || !engine.hooks?.postToolUse) return { block: false, additionalContext: [] };
    return postHooks(record, frame);
  }

  /** One inbound frame → its reply (null for notifications). */
  async function receive(frame) {
    if (!frame || typeof frame !== 'object') return null;
    const reply = (body) => ({ id: frame.id, ...body });
    switch (frame.type) {
      case 'hello': return reply(hello(frame));
      case 'pre': return reply(await pre(frame));
      case 'post': return reply(await post(frame));
      case 'incident': {
        const code = typeof frame.code === 'string' ? frame.code : 'parity_unknown_incident';
        if (fatal.has(code)) killFor(code, { callId: frame.callID ?? frame.callId ?? null, tool: frame.tool ?? null });
        else incident(code, { callId: frame.callID ?? frame.callId ?? null });
        return null;
      }
      default: return null;
    }
  }

  /** Newline-delimited JSON over the harness child's fd 3. */
  function attach(stream) {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let frame = null;
        try { frame = JSON.parse(line); } catch { frame = null; }
        receive(frame).then((out) => { if (out && !state.killed) stream.write(`${JSON.stringify(out)}\n`); }, () => kill());
      }
    });
    stream.on('error', () => {});
  }

  return { receive, attach, checkResult, toolResult, state, handshake };
}
