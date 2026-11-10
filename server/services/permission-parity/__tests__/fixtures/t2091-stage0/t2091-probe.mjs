// T-2091 S0 probe plugin (recording only): public tools API, guard coverage, restrict, P2 probe.
import fs from 'node:fs';
export const name = 't2091-probe';
export const inject = ['tools'];
const LOG = new URL('./probe.log', import.meta.url);
const log = (k, d = {}) => fs.appendFileSync(LOG, `${JSON.stringify({ k, ...d })}\n`);
export function apply(ctx) {
  const t = ctx.tools;
  log('P1', Object.fromEntries(['guard', 'execute', 'restrict', 'definitions', 'get', 'executable', 'schemas', 'register']
    .map((f) => [f, typeof t?.[f]])));
  const permits = new Set();
  ctx.on('tools/pre-execute', async (exec, next) => {
    log('pre', { callId: exec.callId, name: exec.name, agent: exec.agent?.id ?? null, parent: exec.parent !== undefined });
    if (exec.callId.startsWith('permit-') || /allowed/.test(JSON.stringify(exec.arguments ?? null))) permits.add(exec.callId);
    return next();
  }, { prepend: true, global: true });
  t.guard((exec) => {
    const ok = permits.has(exec.callId);
    log('guard', { callId: exec.callId, name: exec.name, agent: exec.agent?.id ?? null, ok });
    return ok ? undefined : 't2091: no permit';
  });
  ctx.on('tools/result', (exec, result) => log('result', { callId: exec.callId, name: exec.name, isError: !!result?.isError,
    error: result?.error?.message ?? null }), { global: true });
  try { t.restrict({ deny: ['web_search'] }); log('restrict-global', { ok: true }); }
  catch (e) { log('restrict-global', { ok: false, err: String(e.message).slice(0, 200) }); }
  const done = new WeakSet();
  ctx.on('agent/pre-step', (payload, next) => {
    const a = payload?.agent;
    if (a && !done.has(a)) {
      done.add(a);
      try { a.ctx.tools.restrict({ deny: ['web_search'] }); log('restrict-agent', { ok: true, agent: a.id }); }
      catch (e) { log('restrict-agent', { ok: false, agent: a?.id ?? null, err: String(e.message).slice(0, 200) }); }
    }
    return next();
  });
  const probe = async () => {
    for (const callId of ['probe-nopermit', 'permit-probe']) {
      try {
        const r = await t.execute({ calls: [{ type: 'tool-call', id: callId, name: '__nassaj_probe__', arguments: '{}' }],
          signal: new AbortController().signal });
        log('P2', { callId, result: JSON.stringify(r).slice(0, 700) });
      } catch (e) { log('P2', { callId, err: String(e?.message ?? e).slice(0, 300) }); }
    }
  };
  const ready = ctx.get?.('appReady');
  log('appReady', { present: !!ready?.onReady });
  if (ready?.onReady) ready.onReady(() => { void probe(); });
}
