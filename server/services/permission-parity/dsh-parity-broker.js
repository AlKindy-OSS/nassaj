/**
 * dsh-parity-broker — the Nassaj side of the fd-3 policy channel to
 * server/governance/dsh-policy-plugin/index.mjs (T-2089, T-2091, ADR-225). Newline-delimited
 * JSON; requests carry `id`, replies echo it. No HMAC (dropped by qa): the channel is a
 * private socketpair, and the measured residual (an approved full-access tool child can
 * take fd 3 on a ptrace_scope=0 host) is the accepted risk of an unsandboxed body.
 *
 *  - hello (protocol 2, T-2091): the plugin's capability probes decide the launch: P1 public
 *    tools API missing → dsh_cap_tools_api, P2 gate probe failed → dsh_cap_gate (both refuse
 *    + kill; a missing or legacy hello is dsh_cap_channel at the runtime); P3 restrict is
 *    non-fatal. Tools are compared with dsh-tool-map.json: a new tool, a mapped tool whose
 *    field changed, or one with a schema keyword the plugin cannot validate is hidden and
 *    denied; the session goes on. A call before a good hello is denied.
 *  - incidents: dsh_gate_bypassed (a call reached the guard without its permit) and
 *    dsh_post_hook_skipped end the turn (kill); others are logged.
 *  - pre: one decision per callId (a duplicate is denied and logged as an incident); the
 *    engine decides (hooks + rules + mode); ask goes to the member (askMember) and only
 *    `approve` allows. Every decision is logged with the argument hash.
 *  - post: PostToolUse hooks run; a result with no recorded allow for the same callId and
 *    hash kills dsh, unless it failed without its body running.
 *  - acpToolUpdate: the same rule for the ACP view (tool_call_update), exempting calls
 *    aborted before prepare (no plugin event at all).
 * Since ADR-226 the channel mechanics live in the shared parity-broker.js; this file is the
 * dsh hello policy (protocol 2 probes + tool map) and the dsh options (a callId is decided
 * once, the argument hash is mandatory, two fatal incidents).
 */
import { argumentHash, BROKER_CODES as CORE_CODES, callKey, createParityBroker as createCoreBroker } from './parity-broker.js';
import { allowedDshTools, compareToolSchemas, loadDshToolMap } from './dsh-tool-map.js';

export { argumentHash, canonicalJson } from './parity-broker.js';

export const BROKER_CODES = Object.freeze({
  ...CORE_CODES,
  capToolsApi: 'dsh_cap_tools_api',
  capGate: 'dsh_cap_gate',
  capChannel: 'dsh_cap_channel',
  gateBypassed: 'dsh_gate_bypassed',
  postHookSkipped: 'dsh_post_hook_skipped',
});

/** Incidents that end the turn: the gate was bypassed, or a permitted call skipped post-execute. */
const FATAL_INCIDENTS = Object.freeze([BROKER_CODES.gateBypassed, BROKER_CODES.postHookSkipped]);

/** The refusal code of a hello frame, or null when the launch may go on. */
export function helloRefusal(hello) {
  if (!hello || hello.protocol !== 2 || !hello.probes) return BROKER_CODES.capChannel;
  if (hello.probes.P1?.ok !== true) return BROKER_CODES.capToolsApi;
  if (hello.probes.P2?.ok !== true) return BROKER_CODES.capGate;
  return null;
}

/** The tools a launch allows and hides, from the hello's declared tools and the map. */
export function helloTools(hello, map = loadDshToolMap()) {
  const declared = (Array.isArray(hello?.tools) ? hello.tools : []).map((tool) => ({ name: tool.name, schema: tool.schema ?? {} }));
  const unsupported = new Set((hello?.tools ?? []).filter((tool) => (tool.schemaIssues ?? []).length > 0).map((tool) => tool.name));
  const allowedTools = allowedDshTools(map, declared).filter((name) => !unsupported.has(name));
  const hiddenTools = declared.map((tool) => tool.name).filter((name) => !allowedTools.includes(name)).sort();
  return { allowedTools, hiddenTools, comparison: compareToolSchemas(map, declared) };
}

/** The dsh hello policy: probes decide the launch; tool drift is logged, never fatal. */
function dshHelloPolicy(onIncident) {
  return {
    check(frame) {
      const refusal = helloRefusal(frame);
      if (refusal) return { ok: false, code: refusal, detail: { probes: frame?.probes ?? null } };
      const { allowedTools, hiddenTools, comparison } = helloTools(frame);
      if (comparison.changed.length || comparison.newTools.length) onIncident({ code: 'dsh_tool_map_drift', comparison });
      return { ok: true, reply: { allowedTools, hiddenTools }, state: { tools: { allowedTools, hiddenTools, comparison } } };
    },
  };
}

/**
 * @param {{ engine: { decideTool: Function, hooks?: { postToolUse: Function } }, kill: () => void,
 *   onIncident: (incident: object) => void, askMember: (card: object) => Promise<string>,
 *   log?: (entry: object) => void }} deps
 */
export function createParityBroker({ engine, kill, onIncident, askMember, log = () => {} }) {
  const broker = createCoreBroker({ engine, kill, onIncident, askMember, log, helloPolicy: dshHelloPolicy(onIncident),
    callIdReuse: 'never', requireHash: true, fatalIncidents: FATAL_INCIDENTS });

  /** The ACP view: a completed tool_call_update needs a recorded allow for its callId and rawInput. */
  function acpToolUpdate({ callId, status, rawInput }) {
    if (status !== 'completed' && status !== 'failed') return;
    const key = callKey(undefined, callId);
    const hash = rawInput === undefined ? undefined : argumentHash(rawInput);
    // A failure whose body never ran (aborted before prepare, refused) needs no decision.
    broker.checkResult(key, hash, { isError: status === 'failed', bodyRan: broker.state.bodyRan.has(key) });
  }

  return { ...broker, acpToolUpdate };
}
