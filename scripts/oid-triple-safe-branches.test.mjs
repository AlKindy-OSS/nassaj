/** Executes actual Bash decision bodies; PM2/Node/native effects are explicit doubles, not activation proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const script=fs.readFileSync(new URL('./safe-restart.sh',import.meta.url),'utf8');
const options=script.slice(script.indexOf('if [ "$OID_TRIPLE_PHASE" = "stop" ]; then',script.indexOf('# ADR-160: local-main')),script.indexOf('if [ "$DO_EXEC" -eq 1 ] && [ "$OID_TRIPLE_PHASE" != "stop" ]; then'));
const native=script.slice(script.indexOf('_preflight_native_runtime() {'),script.indexOf('\n# A restart is not successful'));
const run=body=>spawnSync('/usr/bin/bash',['-c',body],{encoding:'utf8',timeout:5000});
for(const [field,value] of [['DO_EXEC',0],['FORCE',1],['KILL_SESSIONS',1]])test('actual options refusal '+field,()=>{
    const r=run(`OID_TRIPLE_PHASE=stop; DO_EXEC=1; FORCE=0; KILL_SESSIONS=0; ${field}=${value}; _oid_triple_phase(){ echo UNEXPECTED_STOP; };\n${options}\necho UNEXPECTED_STOP`);
    assert.equal(r.status,7);assert.equal(r.stdout,'');assert.equal(r.stderr,'OID_TRIPLE_STOP_STAGE:options_invalid\n');
});
test('actual validate-stop branch retains exit7 and does not proceed to stop',()=>{
    const r=run(`OID_TRIPLE_PHASE=stop; DO_EXEC=1; FORCE=0; KILL_SESSIONS=0; _oid_triple_phase(){ echo oid_pair_counterpart_mismatch >&2; return 1; };\n${options}\necho UNEXPECTED_STOP`);
    assert.equal(r.status,7);assert.equal(r.stdout,'');assert.match(r.stderr,/oid_pair_counterpart_mismatch\nOID_TRIPLE_STOP_STAGE:validate_stop_failed/);
});
for(const [stage,runtime,managed,node] of [['native_runtime_invalid','relative','',''],['native_interpreter_mismatch','/usr/bin/node','fixture','/different'],['native_open_failed','/usr/bin/false','','']]) {
    for(const phase of ['stop',''])test(`actual native failure ${stage} phase=${phase||'ordinary'}`,()=>{
        const r=run(`OID_TRIPLE_PHASE='${phase}'; MANAGED_OPERATION_ID='${managed}'; MANAGED_NODE='${node}'; REPO_DIR=/; emit(){ :; }; _pm2_runtime_node(){ echo '${runtime}'; };\n${native}\n_preflight_native_runtime || exit $?\necho UNEXPECTED_STOP`);
        assert.equal(r.status,7);assert.equal(r.stdout,'');assert.equal(r.stderr,phase?`OID_TRIPLE_STOP_STAGE:${stage}\n`:'');
    });
}
test('actual Node catch suppresses stacks and preserves failure with known/unknown doubles',()=>{
    const catchBody=script.slice(script.indexOf('} catch (error) {',script.indexOf('_oid_triple_phase()')),script.indexOf("\n'\n}",script.indexOf('_oid_triple_phase()')));
    for(const phase of ['validate-stop','start-target','start-previous'])for(const [message,expected] of [['oid_pair_counterpart_mismatch','oid_pair_counterpart_mismatch'],['private-value\n'+ 'x'.repeat(9000),'unknown']]){
        const code=`import * as capsule from ${JSON.stringify(pathToFileURL(new URL('./oid-control-capsule.mjs',import.meta.url).pathname).href)};process.env.NASSAJ_OID_TRIPLE_PHASE=${JSON.stringify(phase)};try {throw Error(${JSON.stringify(message)});${catchBody}`;
        const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
        assert.equal(r.status,1);assert.equal(r.stderr,expected+'\n');assert.equal(r.stdout,'');
    }
});

test('triple read shim traps every CLI binary and accepts only exact read arguments', () => {
    const root=fs.mkdtempSync(new URL('../.artifacts/pm2-cli-trap-',import.meta.url));
    try {
        fs.writeFileSync(`${root}/pm2`,'#!/bin/sh\necho REAL_PM2_CLI >&2\nexit 99\n',{mode:0o700});
        const begin=script.indexOf('# Triple preflight never invokes'),end=script.indexOf('# Fixed first-forward stages remain',begin);
        const shim=script.slice(begin,end);
        const setup=`PATH='${root}:/usr/bin:/bin';OID_TRIPLE_PHASE=stop;PROC_NAME=fixture;_oid_triple_phase(){ printf '[]'; };\n`;
        const calls=`command -v pm2 >/dev/null; for n in 1 2 3 4 5 6 7 8; do pm2 jlist | /usr/bin/node -e 'JSON.parse(require("node:fs").readFileSync(0))' || exit 2; done; pm2 describe fixture --silent || exit 3;`;
        const success=run(setup+shim+calls+'pm2 restart fixture && exit 4; pm2 jlist extra && exit 5; pm2 describe other --silent && exit 6; exit 0');
        assert.equal(success.status,0,success.stderr);assert.equal(success.stdout,'');assert.equal(success.stderr,'');
        const unknown=run(setup.replace("printf '[]'",'return 7')+shim+'echo UNEXPECTED_CONTINUE');
        assert.equal(unknown.status,7);assert.equal(unknown.stdout,'');assert.equal(unknown.stderr,'');
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});
