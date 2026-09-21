/** Real /proc ancestry and isolated PM2-boundary tests; no live supervisor or database access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleUrl = new URL('./local-source-recovery-mode.mjs', import.meta.url).href;

function runFixture(t, scenario) {
    const base = new URL('../../.artifacts/', import.meta.url); fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base.pathname, 'mode-process-')); t.after(() => fs.rmSync(root, { recursive: true }));
    const artifact = path.join(root, 'dist-server'), scripts = path.join(artifact, 'scripts'), helper = path.join(scripts, 'lib/local-source-recovery-mode.mjs');
    fs.mkdirSync(path.dirname(helper), { recursive: true }); fs.mkdirSync(path.join(root, 'bin')); fs.mkdirSync(path.join(root, 'pm2'));
    const write = (file, value, mode = 0o600) => fs.writeFileSync(file, value, { mode });
    const script = (scenario === 'replaced-open-script' ? '#!/bin/bash\ncp -- \"$0\" \"$0.replacement\"; mv -- \"$0.replacement\" \"$0\"\n' : '') + '#!/bin/bash\nnode "$PWD/dist-server/scripts/lib/local-source-recovery-mode.mjs" apply "$PWD" "$PWD/dist-server" "${FIXTURE_TARGET:-nassaj-dev}"\nstatus=$?\nexit "$status"\n';
    write(path.join(scripts, 'safe-restart.sh'), script, 0o555);
    write(path.join(artifact, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify({ buildId: 'fixture-build', inputs: [{ path: 'scripts/safe-restart.sh', mode: 0o775, sha256: sha(script) }] }));
    write(path.join(artifact, 'OID_CONTROL_MANIFEST.json'), JSON.stringify({ serverBuildId: 'fixture-build', safeRestartSha256: sha(script), safeRestartMode: 0o555 }));
    write(helper, `import fs from 'node:fs';
import { assertLocalRecoveryCaller, assertLocalRecoverySupervisor } from ${JSON.stringify(moduleUrl)};
try {
 const binding=JSON.parse(fs.readFileSync('binding.json','utf8'));
 const caller=assertLocalRecoveryCaller(binding,process.argv[5]);
 assertLocalRecoverySupervisor(binding,process.argv[5],caller);
 process.stdout.write('accepted');
} catch(error) { process.stdout.write(error.message); process.exitCode=2; }
`);
    write(path.join(root, 'bin/pm2'), '#!/bin/bash\n[ "$#" = 1 ] && [ "$1" = jlist ] || exit 3\ncat "$PWD/pm2/rows.json"\n', 0o755);
    write(path.join(root, 'provider.mjs'), `import {spawnSync} from 'node:child_process';const r=spawnSync('bash',['dist-server/scripts/safe-restart.sh','--exec'],{stdio:'inherit'});process.exitCode=r.status;`);
    const driver = `import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const root=process.cwd(), scenario=${JSON.stringify(scenario)}, stat=fs.readFileSync('/proc/self/stat','utf8');
const ticks=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[19];
fs.writeFileSync('binding.json',JSON.stringify({root,previousRuntime:{pid:process.pid,startTicks:scenario==='stale-ticks'?'1':ticks}}));
const env={name:'nassaj-dev',namespace:'default',status:'online',pm_cwd:root,pm_exec_path:root+'/runtime.mjs',exec_interpreter:process.execPath,exec_mode:'fork_mode',args:[],node_args:[],env:{PATH:process.env.PATH}};
if(scenario==='pm2-shape'){env.exec_interpreter='node';env.args=['--port','3004'];process.title='node '+root+'/runtime.mjs';}
const rows=[{name:'nassaj-dev',pid:process.pid,pm_id:7,pm2_env:env}], saved=[structuredClone(env)];
if(scenario==='duplicate-slot')rows.push({...rows[0],pid:process.pid+1,pm_id:8});
if(scenario==='wrong-pid')rows[0].pid=process.pid+1;
if(scenario==='duplicate-saved')saved.push(structuredClone(env));
if(scenario==='saved-mode')saved[0].env.NASSAJ_UPDATE_MODE='release';
if(scenario==='saved-interpreter')saved[0].exec_interpreter='/bin/bash';
if(scenario==='saved-entry')saved[0].pm_exec_path=root+'/provider.mjs';
if(scenario==='live-interpreter')env.exec_interpreter='/bin/bash';
if(scenario==='saved-args')saved[0].args=['--other'];
if(scenario==='saved-node-args')saved[0].node_args=['--inspect'];
if(scenario==='saved-namespace')saved[0].namespace='other';
fs.writeFileSync('pm2/rows.json',JSON.stringify(rows));fs.writeFileSync('pm2/dump.pm2',JSON.stringify(saved));
if(scenario==='changed-script'){fs.chmodSync('dist-server/scripts/safe-restart.sh',0o755);fs.appendFileSync('dist-server/scripts/safe-restart.sh','\\n# changed\\n');fs.chmodSync('dist-server/scripts/safe-restart.sh',0o555);}
let command='bash',args=['dist-server/scripts/safe-restart.sh','--exec'];
const helper=root+'/dist-server/scripts/lib/local-source-recovery-mode.mjs';
if(scenario==='provider'){command=process.execPath;args=['provider.mjs'];}
if(scenario==='extra-shell'){args=['-c','bash dist-server/scripts/safe-restart.sh --exec; result=$?; exit "$result"'];}
if(scenario==='direct-apply'){command=process.execPath;args=[helper,'apply',root,root+'/dist-server','nassaj-dev'];}
if(scenario==='wrong-script-args')args.push('--force');
const result=spawnSync(command,args,{encoding:'utf8',env:{...process.env,...(scenario==='wrong-name'?{FIXTURE_TARGET:'other'}:{})}});
process.stdout.write(JSON.stringify({code:result.status,output:result.stdout,error:result.stderr}));
`;
    write(path.join(root, 'runtime.mjs'), driver);
    const output = execFileSync(process.execPath, [path.join(root, 'runtime.mjs')], { cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, PM2_HOME: path.join(root, 'pm2'), pm_exec_path: path.join(root, 'runtime.mjs') } });
    return JSON.parse(output);
}
test('actual direct old Node → exact bash script → helper chain and unique PM2 slot pass', t => {
    const value = runFixture(t, 'accepted'); assert.equal(value.code, 0, JSON.stringify(value)); assert.equal(value.output, 'accepted');
});
test('actual PM2 title, node interpreter via saved PATH and args match the observed host shape', t => {
    const value = runFixture(t, 'pm2-shape'); assert.equal(value.code, 0, JSON.stringify(value)); assert.equal(value.output, 'accepted');
});
for (const scenario of ['provider', 'extra-shell', 'direct-apply', 'wrong-script-args']) test(`actual ${scenario} process chain is rejected`, t => {
    const value = runFixture(t, scenario); assert.equal(value.code, 2, JSON.stringify(value)); assert.match(value.output, /caller_chain_invalid/);
});
for (const [scenario, code] of [
    ['replaced-open-script', 'caller_script_not_open'], ['stale-ticks', 'old_process_changed'], ['changed-script', 'caller_script_changed'],
    ['wrong-name', 'supervisor_changed'], ['duplicate-slot', 'supervisor_changed'], ['wrong-pid', 'supervisor_changed'],
    ['duplicate-saved', 'supervisor_mode_override'], ['saved-mode', 'supervisor_mode_override'],
    ['saved-interpreter', 'supervisor_slot_changed'], ['saved-entry', 'supervisor_slot_changed'],
    ['live-interpreter', 'supervisor_slot_changed'], ['saved-args', 'supervisor_slot_changed'],
    ['saved-node-args', 'supervisor_slot_changed'], ['saved-namespace', 'supervisor_slot_changed'],
]) test(`actual process evidence refuses ${scenario}`, t => {
    const value = runFixture(t, scenario); assert.equal(value.code, 2, JSON.stringify(value)); assert.match(value.output, new RegExp(code));
});
