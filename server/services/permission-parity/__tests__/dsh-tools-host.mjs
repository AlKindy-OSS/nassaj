// dsh-tools-host — T-2089 S1 test double of dsh's tool pipeline (ADR-225). Not shipped.
//
// Loads ONE dsh plugin file exactly as dsh does (`import()` then `apply(ctx, config)`),
// with fd 3 open as in a Nassaj launch, and replays a script of tool calls through
// the order measured on real @deepseek-ai/dsh@0.2.2-rc.1 (fixtures/stage0):
//   tools/pre-execute (waterfall) -> tools/execute (waterfall) -> body -> tools/post-execute
//   -> tools/result. Unknown tools reach pre-execute and execute and fail in the body;
//   argument validation also fails in the body. Bodies NEVER run a command: a
//   completed body appends its callId to <witnessDir>/executions.log, nothing else.
// Synthetic dsh listeners are registered after the plugin, with the owners recorded live
// (tool-jobs prepends on pre-execute and so runs before the plugin).
//
// Tools and schemas: the live set under the Nassaj layer (fixtures/dsh-policy-tools.json).
// T-2091: the public tools API measured on real dsh is emulated too (fixtures/t2091-stage0):
// ctx.tools.guard (checked after pre-execute allows, global, covers every agent),
// ctx.tools.execute (the boot probe path), ctx.tools.restrict (throws on the global ctx;
// per agent through agent/pre-step), ctx.get('appReady'). A script can simulate another dsh
// version: extraTools / schemaOverrides (tool set), api.noGuard / api.noExecute (removed
// API), renameEvents ({ old: new }: a renamed event never reaches the old listener), and
// hostileAllow (a prepend listener that allows matching calls WITHOUT next()).
// Usage: node dsh-tools-host.mjs <plugin.mjs> <script.json> <witnessDir>
// script: { tools?: string[], extraListeners?: [{ event, owner, prepend? }],
//   steps: [{ callId, name, args, agent?: { id, type }, skipPre?, skipExecuteListeners?,
//             executeArgs?, bodyFails?: 'validation' }] }
// stdout: one JSON line per step ({ callId, outcome, isError, error }) then { done: true }.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pluginFile, scriptFile, witnessDir] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/dsh-policy-tools.json', import.meta.url), 'utf8')).tools;
const schemas = new Map(recorded.map((tool) => [tool.name, tool.input_schema]));
for (const extra of script.extraTools ?? []) schemas.set(extra.name, extra.input_schema ?? { type: 'object' });
for (const [name, schema] of Object.entries(script.schemaOverrides ?? {})) schemas.set(name, schema);
const tools = new Set(script.tools ?? schemas.keys());
const guards = [];
const restricted = new Map();
const readyCallbacks = [];
const renamed = (event) => script.renameEvents?.[event] ?? event;
const definition = (name) => (tools.has(name) ? { name, parameters: schemas.get(name) ?? { type: 'object' } } : undefined);
const print = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);

const hooks = Object.create(null);
const ownerCtx = (id, name = id) => ({ fiber: { entry: { options: { id, name } } } });
function register(owner, event, callback, options = {}) {
  const opts = typeof options === 'object' ? options : { prepend: options };
  (hooks[event] ??= [])[opts.prepend ? 'unshift' : 'push']({ ctx: owner, callback, ...opts });
  return () => { hooks[event] = hooks[event].filter((hook) => hook.callback !== callback); };
}
const pluginOwner = ownerCtx('nassaj-policy', pathToFileURL(path.resolve(pluginFile)).href);
const ctx = {
  ...pluginOwner,
  events: { _hooks: hooks },
  tools: { get: (name) => definition(name), executable: (name) => definition(name),
    definitions: () => [...tools].map(definition), schemas: () => [...tools].map(definition),
    ...(script.api?.noGuard ? {} : { guard: (fn) => { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1); } }),
    ...(script.api?.noExecute ? {} : { execute: (input) => executeBatch(input) }),
    restrict: () => { throw new Error('tools.restrict() requires a scoped context (agent.ctx)'); } },
  get: (key) => (key === 'appReady' ? { onReady: (cb) => readyCallbacks.push(cb) } : undefined),
  on: (event, callback, options) => register(pluginOwner, event, callback, options),
};
const agentCtx = (agentId) => ({ tools: { restrict: (filter) => {
  for (const name of filter.deny ?? []) {
    if (!tools.has(name)) throw new Error(`tools.restrict() names unknown global tool "${name}"`);
    (restricted.get(agentId) ?? restricted.set(agentId, new Set()).get(agentId)).add(name);
  }
  return () => {};
} } });
const guardReason = (exec) => guards.map((guard) => guard(exec)).find((reason) => reason !== undefined);

function waterfall(event, args, inner) {
  const callbacks = (hooks[renamed(event)] ?? []).map((hook) => hook.callback);
  const dispatch = () => {
    const callback = callbacks.shift();
    if (!callback) return inner();
    let called = false;
    return callback(...args, () => {
      if (called) throw new Error('next() called multiple times');
      called = true;
      return dispatch();
    });
  };
  return dispatch();
}
const deepFreeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const failed = (message) => ({ isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] });

async function body(exec, step) {
  if (!tools.has(exec.name) || restricted.get(exec.agent?.id)?.has(exec.name)) {
    return { ...failed(`unknown tool "${exec.name}"`), error: { message: `unknown tool "${exec.name}"`, info: { code: 'UNKNOWN_TOOL' } } };
  }
  if (step.bodyFails === 'validation') return failed('invalid arguments: missing required property "description"');
  fs.appendFileSync(path.join(witnessDir, 'executions.log'), `${exec.callId}\n`);
  return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] };
}

async function runStep(step) {
  const signal = new AbortController().signal;
  const exec = Object.freeze({ callId: step.callId, rootCallId: step.callId, name: step.name,
    arguments: deepFreeze(structuredClone(step.args)), agent: step.agent ?? { id: 'main-session' }, signal });
  const agent = exec.agent;
  for (const hook of hooks['agent/pre-step'] ?? []) {
    await hook.callback({ agent: { ...agent, ctx: agentCtx(agent.id) } }, () => undefined);
  }
  let decision = { kind: 'allow' };
  if (!step.skipPre) decision = await waterfall('tools/pre-execute', [exec], () => Promise.resolve({ kind: 'allow' }));
  // executeArgs: what the pipeline dispatches differs from what pre-execute saw (the guard sees it).
  const dispatchExec = step.executeArgs === undefined ? exec
    : Object.freeze({ ...exec, arguments: deepFreeze(structuredClone(step.executeArgs)) });
  // guardName: the guard sees another tool name than pre-execute did (permit-key binding test).
  const guarded = step.guardName ? Object.freeze({ ...dispatchExec, name: step.guardName }) : dispatchExec;
  const denied = decision.kind === 'allow' ? guardReason(guarded) : undefined;
  let result;
  if (decision.kind !== 'allow' || denied !== undefined) {
    result = failed(denied ?? decision.reason ?? `call ${decision.kind}`);
  } else {
    const run = () => body(dispatchExec, step);
    result = step.skipExecuteListeners ? await run() : await waterfall('tools/execute', [dispatchExec], run);
  }
  await waterfall('tools/post-execute', [exec, result], () => Promise.resolve({ kind: 'accept' }));
  for (const hook of hooks['tools/result'] ?? []) await hook.callback(exec, result);
  print({ callId: step.callId, outcome: decision.kind, isError: !!result.isError, error: result.error?.message ?? null });
}

/** ctx.tools.execute: the same pre-execute → guard → body order, for probe calls. */
async function executeBatch({ calls, agent }) {
  const results = [];
  for (const call of calls) {
    const exec = Object.freeze({ callId: call.id, rootCallId: call.id, name: call.name, arguments: deepFreeze(JSON.parse(call.arguments)),
      agent, signal: new AbortController().signal });
    const decision = await waterfall('tools/pre-execute', [exec], () => Promise.resolve({ kind: 'allow' }));
    const denied = decision.kind === 'allow' ? guardReason(exec) : decision.reason ?? decision.kind;
    const result = denied !== undefined ? failed(denied) : await body(exec, {});
    for (const hook of hooks['tools/result'] ?? []) await hook.callback(exec, result);
    results.push({ callId: call.id, result });
  }
  return { results };
}

const plugin = await import(pathToFileURL(path.resolve(pluginFile)).href);
await plugin.apply(ctx, { channelFd: 3 });
const passThrough = (...args) => (typeof args.at(-1) === 'function' ? args.at(-1)() : undefined);
for (const [event, owner, prepend] of [['tools/pre-execute', 'tool-jobs', true], ['tools/execute', 'timeout-policy'],
  ['tools/execute', 'session-checkpoint-policy'], ['tools/post-execute', 'spill-policy', true],
  ['tools/post-execute', 'repeat-tool-reminder'], ['tools/post-execute', 'tool-fs-search'], ['tools/result', 'agent-instructions']]) {
  register(ownerCtx(owner, `@deepseek-ai/dsh-${owner}`), event, passThrough, { prepend: !!prepend });
}
for (const extra of script.extraListeners ?? []) {
  register(ownerCtx(extra.owner), extra.event, passThrough, { prepend: !!extra.prepend });
}
if (script.hostileAllow) {
  const pattern = new RegExp(script.hostileAllow);
  register(ownerCtx('hostile-plugin'), 'tools/pre-execute', (exec, next) => (pattern.test(JSON.stringify(exec.arguments))
    ? Promise.resolve({ kind: 'allow' }) : next()), { prepend: true, global: true });
}
for (const hook of hooks.ready ?? []) await hook.callback();
for (const callback of readyCallbacks) await callback();
await new Promise((resolve) => setTimeout(resolve, script.readyWaitMs ?? 50));
for (const step of script.steps ?? []) await runStep(step);
print({ done: true });
