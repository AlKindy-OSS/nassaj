// T-2089 S0 probe-only dsh plugin: node: imports and ctx only.
import fs from 'node:fs';

export const name = 'nassaj-parity-probe';
export const inject = ['tools'];
const LOG = new URL('./probe.log', import.meta.url);
const log = (kind, data) => fs.appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), kind, ...data })}\n`);
const EVENTS = ['tools/pre-execute', 'tools/execute', 'tools/post-execute', 'tools/result'];

function owner(hook) {
  const c = hook.ctx;
  const f = c?.fiber;
  return {
    entryId: f?.entry?.options?.id ?? null,
    entryName: f?.entry?.options?.name ?? null,
    runtimeName: f?.runtime?.name ?? f?.runtime?.plugin?.name ?? null,
    scope: c ? Object.getOwnPropertySymbols(c).map(String).filter((s) => /scope/i.test(s)) : [],
    prepend: !!hook.prepend, global: !!hook.global,
  };
}
function inventory(ctx, when) {
  const hooks = ctx.events?._hooks ?? ctx.root?.events?._hooks;
  const out = {};
  for (const e of EVENTS) out[e] = (hooks?.[e] ?? []).map(owner);
  log('inventory', { when, readable: !!hooks, out });
}
const agentInfo = (a) => (a ? { id: a.id ?? null, keys: Object.keys(a).slice(0, 25), parent: a.parent?.id ?? null,
  depth: a.depth ?? null, kind: a.kind ?? null } : null);
const execInfo = (exec) => ({ callId: exec.callId, rootCallId: exec.rootCallId ?? null, name: exec.name,
  arguments: exec.arguments, argType: Array.isArray(exec.arguments) ? 'array' : typeof exec.arguments,
  keys: Object.keys(exec), hasParent: exec.parent !== undefined, agent: agentInfo(exec.agent) });

export function apply(ctx, config) {
  let fds = [];
  try { fds = fs.readdirSync('/proc/self/fd').map((fd) => [fd, (() => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return '?'; } })()]); } catch {}
  log('apply', { pid: process.pid, ppid: process.ppid, config: config ?? null, url: import.meta.url, fds });
  inventory(ctx, 'apply');
  setTimeout(() => inventory(ctx, 'apply+2s'), 2000).unref?.();
  ctx.on('tools/pre-execute', async (exec, next) => {
    log('pre-execute', execInfo(exec));
    inventory(ctx, 'first-pre-execute');
    return next();
  }, { prepend: true, global: true });
  ctx.on('tools/execute', async (exec, next) => {
    log('execute', execInfo(exec));
    const r = await next();
    log('execute-done', { callId: exec.callId, isError: r?.isError ?? null });
    return r;
  }, { prepend: true, global: true });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    log('post-execute', { ...execInfo(exec), isError: result?.isError ?? null, error: result?.error?.message ?? null });
    return next();
  }, { prepend: true, global: true });
  ctx.on('tools/result', (exec, result) => {
    log('result', { callId: exec.callId, name: exec.name, isError: result?.isError ?? null, error: result?.error?.message ?? null });
  }, { global: true });
}
