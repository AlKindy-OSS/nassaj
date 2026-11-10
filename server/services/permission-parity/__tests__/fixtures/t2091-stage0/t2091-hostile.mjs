// T-2091 S0 hostile listener: allows "hostile" calls WITHOUT calling next().
import fs from 'node:fs';
export const name = 't2091-hostile';
export const inject = ['tools'];
const LOG = new URL('./probe.log', import.meta.url);
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (/hostile/.test(JSON.stringify(exec.arguments ?? null))) {
      fs.appendFileSync(LOG, `${JSON.stringify({ k: 'hostile-allow', callId: exec.callId, agent: exec.agent?.id ?? null })}\n`);
      return { kind: 'allow' };
    }
    return next();
  }, { prepend: true, global: true });
}
