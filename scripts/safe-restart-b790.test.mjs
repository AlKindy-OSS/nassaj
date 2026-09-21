#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'safe-restart.sh');
let passed = 0;

function assert(name, condition) {
  if (!condition) throw new Error(name);
  passed += 1;
}

function runCase({
  nativeOk,
  healthCode,
  interpreter = 'absolute',
  runtimeExists = true,
  dryRun = false,
  recovery = false,
  cwdMatches = true,
  managed = false, managedClaim = true, managedReady = true, managedProof = true, managedArgs = [], managedBusy = false, managedDuplicate = false, managedId = 7, managedNamespace = 'default', managedDriftAfterClaim = false,
}) {
  const root = mkdtempSync('/var/tmp/sr-b790-');
  try {
    const bin = join(root, 'bin');
    const workflows = join(root, 'workflows');
    const mutationLog = join(root, 'mutations.log');
    const nativeLog = join(root, 'native.log');
    const managedLog = join(root, 'managed.log');
    const curlLog = join(root, 'curl.log');
    const healthCount = join(root, 'health-count');
    const runtimeNode = join(bin, interpreter === 'saved-path' ? 'node' : 'production-node');
    let scriptUnderTest = script;
    mkdirSync(bin);
    mkdirSync(workflows);
    if (managedBusy) {
      const wf=join(workflows,'session','subagents','workflows','wf_fixture');mkdirSync(wf,{recursive:true});
      writeFileSync(join(wf,'journal.jsonl'),'{}\n'+JSON.stringify({type:'started'})+'\n');
      writeFileSync(join(wf,'agent-fixture.jsonl'),'{}\n');
    }
    if (runtimeExists) writeFileSync(runtimeNode, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${nativeLog}"
if [[ "$*" == *'deepseek|glm|qwen'* ]]; then exit 0; fi
if [[ "$*" == *'better-sqlite3'* ]]; then
  [ "${nativeOk ? '1' : '0'}" = 1 ] || exit 42
fi
exec "${process.execPath}" "$@"
`);
    const pathNode = join(bin, 'node');
    if (runtimeNode !== pathNode) {
      writeFileSync(pathNode, `#!/usr/bin/env bash
if [[ "$*" == *'deepseek|glm|qwen'* ]]; then exit 0; fi
exec "${process.execPath}" "$@"
`);
      chmodSync(pathNode, 0o755);
    }
    if (recovery) {
      const buildId = 'b'.repeat(64);
      const candidateScripts = join(root, '.nassaj-local-preview', 'server-candidates', buildId, 'scripts');
      const liveScripts = join(root, 'dist-server', 'scripts');
      mkdirSync(candidateScripts, { recursive: true });
      mkdirSync(liveScripts, { recursive: true });
      scriptUnderTest = join(candidateScripts, 'safe-restart.sh');
      copyFileSync(script, scriptUnderTest);
      chmodSync(scriptUnderTest, 0o755);
      writeFileSync(join(liveScripts, 'local-preview-server-activation.mjs'), 'process.exit(0);\n');
      symlinkSync(join(dirname(scriptsDir), 'node_modules'), join(root, 'node_modules'), 'dir');
    }
    if (managed) {
      const managedScripts = join(root, 'release', 'scripts'); mkdirSync(managedScripts, { recursive: true });
      scriptUnderTest = join(managedScripts, 'safe-restart.sh'); copyFileSync(script, scriptUnderTest);
      symlinkSync(join(dirname(scriptsDir), 'node_modules'), join(root, 'release', 'node_modules'), 'dir');
      // The root-client transport is a fixture seam; the safe-restart branch itself is unmodified.
      writeFileSync(join(managedScripts, 'managed-safe-restart-client.mjs'), `
        import fs from 'node:fs';
        import {parseManagedRestartArguments} from ${JSON.stringify(new URL('./managed-safe-restart-client.mjs', import.meta.url).href)};
        const args=process.argv.slice(2); const log=${JSON.stringify(managedLog)};
        if(args[0]==='claim'||args[0]==='ready') {
          fs.appendFileSync(log,args[0]+'\\n');
          process.exit(args[0]==='claim'?${managedClaim ? 0 : 7}:${managedReady ? 0 : 7});
        }
        try {parseManagedRestartArguments(args);} catch {process.exit(7);}
        fs.appendFileSync(log,'inspect\\n'); process.exit(${managedProof && cwdMatches && !managedDuplicate && managedId===7 && managedNamespace==='default' ? 0 : 7});
      `);
    }
    const savedInterpreter = interpreter === 'saved-path'
      ? 'node'
      : interpreter === 'missing'
        ? join(root, 'missing-node')
        : runtimeNode;
    const pmCwd = managed ? (cwdMatches ? root : workflows) : cwdMatches ? (recovery ? root : dirname(scriptsDir)) : root;
    const pm2Entry={name:'nassaj-dev',pm_id:managedId,pid:process.pid,pm2_env:{namespace:managedNamespace,
      status:recovery?'errored':'online',pm_cwd:pmCwd,exec_interpreter:savedInterpreter,treekill:false,kill_timeout:86400000,env:{PATH:bin}}};
    const pm2Rows=[pm2Entry,...(managedDuplicate?[{...pm2Entry,pm_id:managedId+1}]:[])];
    writeFileSync(join(bin, 'pm2'), `#!/usr/bin/env bash
if [ '${managed ? '1' : '0'}' = 1 ]; then printf '%s\n' "CLI $*" >> "${mutationLog}"; exit 99; fi
case "$1" in
  describe) exit 0 ;;
  jlist)
    if [ '${managedDriftAfterClaim ? '1' : '0'}' = 1 ] && [ -f '${managedLog}' ] && /usr/bin/grep -q claim '${managedLog}'; then
      printf '%s' '${JSON.stringify([{...pm2Entry,pm_id:managedId+1}])}'
    else printf '%s' '${JSON.stringify(pm2Rows)}'; fi ;;
  restart|save) printf '%s\n' "$*" >> "${mutationLog}" ;;
esac
`);
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
printf '%s\n' "$*" >> '${curlLog}'
case "$*" in
  *http_code*)
    n=0; [ -f '${healthCount}' ] && n="$(cat '${healthCount}')"; n=$((n+1)); printf '%s' "$n" > '${healthCount}'
    IFS=',' read -r -a codes <<< '${healthCode}'; i=$((n-1)); [ "$i" -ge "${'${#codes[@]}'}" ] && i=$((${'${#codes[@]}'}-1)); printf '%s' "${'${codes[$i]}'}" ;;
  *) printf '%s' '{}' ;;
esac
`);
    for (const file of [join(bin, 'pm2'), join(bin, 'curl')]) chmodSync(file, 0o755);
    if (runtimeExists) chmodSync(runtimeNode, 0o755);

    let code = 0, stderr = '';
    try {
      const args = [scriptUnderTest, ...(managed ? ['--managed-operation','approved-operation-0001','--managed-child',...managedArgs] : []),
        ...(dryRun ? [] : [...(recovery ? ['--rollback-recovery'] : []), '--exec'])];
      execFileSync('bash', args, {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          WF_BASE: workflows,
          WORKFLOW_SUPERVISOR: '',
          ...(managed ? {MANAGED_NODE: runtimeNode, MANAGED_SERVER_PID:String(process.pid), MANAGED_ATTEMPT_ID:'a'.repeat(64), MANAGED_PM2_ID: '7', MANAGED_PM2_NAMESPACE: 'default', MANAGED_PM2: join(bin,'pm2'), MANAGED_EXPECTED_PM2_CWD: root, MANAGED_GENERATION_ROOT: join(root,'release')} : {}),
          POST_RESTART_HEALTH_ATTEMPTS: String(String(healthCode).split(',').length),
          POST_RESTART_HEALTH_INTERVAL_S: '0',
          WARM_READY_TIMEOUT_S: '0',
        },
        stdio: 'pipe',
      });
    } catch (error) {
      code = error.status;
      stderr = String(error.stderr || '');
    }
    return {
      code,
      mutations: existsSync(mutationLog) ? readFileSync(mutationLog, 'utf8') : '',
      nativeCommand: existsSync(nativeLog) ? readFileSync(nativeLog, 'utf8') : '',
      stderr,
      managedCalls: existsSync(managedLog) ? readFileSync(managedLog,'utf8') : '',
      curlCalls: existsSync(curlLog) ? readFileSync(curlLog,'utf8') : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const abiFailure = runCase({ nativeOk: false, healthCode: '200' });
assert('ABI failure exits 7', abiFailure.code === 7);
assert('ABI failure blocks every PM2 mutation', abiFailure.mutations === '');
assert('preflight instantiates Database', abiFailure.nativeCommand.includes('new Database'));

const health000 = runCase({ nativeOk: true, healthCode: '000' });
assert('health 000 exits 7', health000.code === 7);
assert('health 000 is checked only after restart', health000.mutations.includes('restart nassaj-dev'));

const transientHealth = runCase({ nativeOk: true, healthCode: '000,500,200' });
assert('health retries 000 and 500 until 200', transientHealth.code === 0);

const exhaustedHealth = runCase({ nativeOk: true, healthCode: '500,500' });
assert('health 500 exhaustion exits 7', exhaustedHealth.code === 7);

const healthy = runCase({ nativeOk: true, healthCode: '200' });
assert('health 200 succeeds', healthy.code === 0);
assert('healthy path restarts and saves', /restart nassaj-dev[\s\S]*save/.test(healthy.mutations));

const savedPath = runCase({ nativeOk: true, healthCode: '200', interpreter: 'saved-path' });
assert('bare node resolves from PM2 saved PATH', savedPath.code === 0 && savedPath.nativeCommand.includes('better-sqlite3'));

const missingInterpreter = runCase({ nativeOk: true, healthCode: '200', interpreter: 'missing', runtimeExists: false });
assert('missing production interpreter fails closed', missingInterpreter.code === 7);
assert('missing production interpreter blocks mutation', missingInterpreter.mutations === '');

const cwdMismatch = runCase({ nativeOk: true, healthCode: '200', cwdMatches: false });
assert('PM2 pm_cwd mismatch fails closed', cwdMismatch.code === 7 && cwdMismatch.mutations === '');

const recovery = runCase({ nativeOk: true, healthCode: '200', recovery: true });
assert('rollback recovery performs native preflight and health verification',
  recovery.code === 0 && recovery.nativeCommand.includes('better-sqlite3'));
assert('rollback recovery mutation remains restart then save', /restart nassaj-dev[\s\S]*save/.test(recovery.mutations));

const dryRun = runCase({ nativeOk: false, healthCode: '000', dryRun: true });
assert('dry-run does not execute native preflight', dryRun.nativeCommand === '');
assert('dry-run performs no PM2 mutation', dryRun.mutations === '');

console.log(`safe-restart B-790: ${passed}/17 passed`);


const managedHealthy = runCase({nativeOk:true,healthCode:'000',managed:true});
assert('managed actual branch returns drained without any PM2 mutation', managedHealthy.code===0 && managedHealthy.mutations==='');
assert('managed drain never claims execution or private readiness', !managedHealthy.managedCalls.includes('claim') && !managedHealthy.managedCalls.includes('ready'));
assert('managed drain never warms public cache', !managedHealthy.curlCalls.includes('/assets/'));
for(const managedArgs of [['--force'],['--set','X=Y'],['--rollback-recovery'],['--unknown'],['--managed-operation','approved-operation-0001']]) {
  const invalid=runCase({nativeOk:true,healthCode:'200',managed:true,managedArgs});
  assert('managed invalid flags rejected before proof/native/PM2',invalid.code===7 && invalid.mutations==='' && invalid.nativeCommand==='' && invalid.managedCalls==='');
}
for(const options of [{managedProof:false},{cwdMatches:false},{managedDuplicate:true},{managedId:8},{managedNamespace:'other'}]) {
  const result=runCase({nativeOk:true,healthCode:'200',managed:true,...options});
  assert('managed root proof denial rejects before drain effects',result.code===7 && result.mutations==='' && result.nativeCommand==='');
}
const managedDry=runCase({nativeOk:true,healthCode:'200',managed:true,dryRun:true});
assert('managed readonly drain never claims execution',managedDry.code===0 && managedDry.mutations==='' && !managedDry.managedCalls.includes('claim'));
const managedBusy=runCase({nativeOk:true,healthCode:'200',managed:true,managedBusy:true});
assert('managed live workflow remains typed exit75 without mutation',managedBusy.code===75 && managedBusy.mutations==='' && !managedBusy.managedCalls.includes('claim') && !managedBusy.nativeCommand.includes('new Database'));
console.log(`safe-restart managed drain regression: ${passed} assertions passed`);
