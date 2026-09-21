/** Actual subprocess transport with the original guard; synthetic scripts never invoke PM2 or application code. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createOidTripleSafeDiagnostic} from './oid-control-capsule.mjs';
const source=fs.readFileSync(new URL('./oid-control-capsule.source.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('function runSafe('),source.indexOf('\nfunction parseProcessStartTicks('));
const guard=source.slice(source.indexOf('function tripleRefuseWriterDescendants('),source.indexOf('\nasync function triplePm2Command('));
// Extract the exact private function rather than exporting command execution as a production API.
const transport=(spawnProcess=spawn)=>new Function('spawn','createOidTripleSafeDiagnostic',`return (${body});`)(spawnProcess,createOidTripleSafeDiagnostic);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const record={repoRoot:process.cwd(),artifactRoot:path.join(process.cwd(),'dist-server'),capsuleModeAbi:'nassaj-capsule-roots/v1',pair:{sequence:1,targetDigest:'a'.repeat(64),ownerId:'1'}};
const inspect=`import {readFileSync,readdirSync} from 'node:fs';${guard}
const allowed=new Set();let pid=process.pid;while(pid>1&&!allowed.has(pid)){allowed.add(pid);if(pid===${process.pid})break;pid=Number(readFileSync('/proc/'+pid+'/status','utf8').match(/^PPid:\\s+(\\d+)/m)[1]);}
let reason='accepted';try{tripleRefuseWriterDescendants(${process.pid},allowed);}catch(error){reason=error.message;}
console.log(JSON.stringify({reason}));`;
const fixture=large=>Buffer.from('# preamble\n'.repeat(large?1500:1)+`/usr/bin/node --input-type=module -e ${quote(inspect)}\n`+'# unread tail\n'.repeat(large?7000:1));
for(const large of [false,true])test(`V2 transport original writer guard accepts ${large?'large':'small'} script without sibling writer`,async()=>{
    const result=await transport()(fixture(large),['--oid-triple-phase','validate-stop'],record);
    assert.equal(result.status,0);assert.equal(result.pipeError,null);assert.equal(JSON.parse(result.stdout).reason,'accepted');
});
test('unchanged legacy pipeline with large script reproduces self-writer rejection',async()=>{
    const result=await transport()(fixture(true),[],{...record,pair:null});
    assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).reason,'oid_triple_writer_descendant_present');
});
test('V2 still refuses an actual unrelated writer descendant',async()=>{
    const foreign=spawn('/usr/bin/sleep',['30'],{stdio:'ignore'});await new Promise((resolve,reject)=>{foreign.once('spawn',resolve);foreign.once('error',reject);});
    try{const result=await transport()(fixture(true),['--oid-triple-phase','validate-stop'],record);assert.equal(JSON.parse(result.stdout).reason,'oid_triple_writer_descendant_present');}
    finally{const closed=new Promise(resolve=>foreign.once('close',resolve));foreign.kill('SIGKILL');await closed;}
});
test('V1/V2 preserve argv, roots, trailing newline and exact nonzero exit',async()=>{
    const script=Buffer.from(`printf '%s\\n' "$0" "$@" "$NASSAJ_CAPSULE_MODE_ABI" "$NASSAJ_CAPSULE_REPO_ROOT" "$NASSAJ_CAPSULE_ARTIFACT_ROOT"\nprintf 'tail\\n'\nexit 23\n\n`);
    const args=['--oid-triple-phase','validate-stop','two words','$literal'];
    const legacy=await transport()(script,args,{...record,pair:null});const triple=await transport()(script,args,record);
    assert.equal(legacy.status,23);assert.equal(triple.status,23);assert.equal(triple.stdout,legacy.stdout);assert.equal(triple.stderr,legacy.stderr);
    assert.ok(triple.stdout.endsWith('tail\n'));assert.ok(triple.stdout.includes('two words\n$literal\n'));
});
test('FD3 must reach EOF before first effect, including V2 here-string',async()=>{
    let beforeEof='',observed=false;
    const delayed=(program,args,options)=>{const child=spawn(program,args,options),input=child.stdio[3],end=input.end.bind(input);child.stdout.on('data',b=>beforeEof+=b);
        input.end=bytes=>{input.write(bytes);setTimeout(()=>{assert.equal(beforeEof,'');observed=true;end();},100);return input;};return child;};
    const result=await transport(delayed)(Buffer.from('printf effect\\n\n'),['--oid-triple-phase','validate-stop'],record);
    assert.equal(observed,true);assert.equal(result.status,0);assert.ok(result.stdout.startsWith('effect'));
});
for(const failure of ['preload','exec','redirection'])test(`actual Bash ${failure} failure remains nonzero and never retries`,async()=>{
    let calls=0;const failing=(program,args,options)=>{calls++;args=[...args];
        if(failure==='preload')args[1]=args[1].replace('/usr/bin/cat','/usr/bin/false');
        if(failure==='exec')args[1]=args[1].replace('exec /usr/bin/bash','exec /nonexistent-oid-transport-command');
        if(failure==='redirection')args[1]=args[1].replace('exec /usr/bin/bash','ulimit -n 4; exec /usr/bin/bash');
        return spawn(program,args,options);};
    const result=await transport(failing)(fixture(true),['--oid-triple-phase','validate-stop'],record);
    assert.notEqual(result.status,0);if(failure==='preload')assert.equal(result.status,97);assert.equal(result.stdout,'');assert.equal(calls,1);
});
test('FD3 transport error remains visible with no implicit retry',async()=>{
    let calls=0;const closed=(program,args,options)=>{calls++;return spawn(program,['-c','exec 3<&-; /usr/bin/sleep 0.1'],options);};
    const result=await transport(closed)(Buffer.alloc(2*1024*1024),['--oid-triple-phase','validate-stop'],record);
    assert.ok(result.pipeError);assert.equal(calls,1);
});
test('large here-string leaves no temporary file or leaked FD in parent',async()=>{
    const directory=fs.mkdtempSync(path.resolve('.artifacts/oid-transport-temp-'));const before=fs.readdirSync('/proc/self/fd').length;
    try{const isolated=(program,args,options)=>spawn(program,args,{...options,env:{...options.env,TMPDIR:directory}});
        const result=await transport(isolated)(fixture(true),['--oid-triple-phase','validate-stop'],record);assert.equal(result.status,0);assert.deepEqual(fs.readdirSync(directory),[]);
        await new Promise(resolve=>setTimeout(resolve,20));assert.ok(fs.readdirSync('/proc/self/fd').length<=before);
    }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
