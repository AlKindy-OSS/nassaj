import fs from 'node:fs';
export const name='t2091-eng-rc';
export function apply(){ fs.appendFileSync(new URL('../../probe.log', import.meta.url), JSON.stringify({k:'engines-loaded',pkg:'rc'})+'\n'); }
