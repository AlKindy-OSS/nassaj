"""Real service-owner capture with a private PM2 fixture and an owned-child guardian.

No user namespace, metadata adapters, host PM2 socket or host service operation.
This proves capture semantics, separately from the root helper's isolation tests.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SELF = Path(__file__).resolve()
ARTIFACTS = ROOT / '.artifacts'

WORKER_PREFIX = """
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const lab=process.argv[2], mode=process.argv[3];
assert.equal(process.getuid(),1000);
assert.equal(process.env.PM2_HOME,path.join(lab,'home/.pm2'));
assert.equal(fs.realpathSync(process.env.PM2_HOME),process.env.PM2_HOME);
assert.deepEqual(fs.readdirSync(process.env.PM2_HOME),[]);
assert.equal(fs.statSync('/usr/bin/python3.13').uid,0);
// Observational counters delegate every call unchanged to the actual runtime.
const calls={credentialChildren:0,credentialCompleted:0,ssCalls:0,ssCompleted:0};
const realSpawn=childProcess.spawn,realExecFile=childProcess.execFile;
childProcess.spawn=function(file,args,options){
    const child=realSpawn.apply(this,arguments);
    if(file==='/usr/bin/python3.13'&&options?.stdio?.[3]>=0){
        calls.credentialChildren++;
        child.once('close',code=>{if(code===0)calls.credentialCompleted++;});
    }
    return child;
};
childProcess.execFile=function(file,args){
    const child=realExecFile.apply(this,arguments);
    if(file==='/usr/bin/ss'){
        assert.deepEqual(args,['-xnpH']);calls.ssCalls++;
        child.once('close',code=>{if(code===0)calls.ssCompleted++;});
    }
    return child;
};
syncBuiltinESMExports();
"""

WORKER_CAPTURE = """
if(mode!=='title-truncation'){
    // Node's Linux title space is bounded by argv. The private fixture path is longer
    // than /home/operator/.pm2, so reserve space without overriding PM2's own title.
    const daemon=childProcess.spawn('/usr/bin/node',['/usr/lib/node_modules/pm2/lib/Daemon.js',
        'private-fixture-identity-padding-'+ 'x'.repeat(128)],
        {env:process.env,stdio:['ignore','ignore','inherit','ipc']});
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('private_daemon_readiness_timeout')),5000);
        daemon.once('error',error=>{clearTimeout(timer);reject(error);});
        daemon.once('exit',()=>{clearTimeout(timer);reject(Error('private_daemon_early_exit'));});
        daemon.once('message',message=>{
            clearTimeout(timer);
            try{assert.equal(message.online,true);assert.equal(message.pid,daemon.pid);resolve();}
            catch(error){reject(error);}
        });
    });
    daemon.disconnect();daemon.unref();
}
pm2(['start',ecosystem]);
if(mode==='after-start-failure')process.exit(24); // No pm2.pid read; guardian must adopt/reap.
pm2(['save']);
const rows=JSON.parse(pm2(['jlist']));
assert.equal(rows.length,1);
const slot=rows[0];assert.equal(slot.name,name);assert.ok(slot.pid>1);
const identity=pid=>{
    const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');
    const uids=status.match(/^Uid:\\s+(.+)$/m)[1].trim().split(/\\s+/).map(Number);
    assert.deepEqual(uids,[1000,1000,1000,1000]);
    const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    return {pid,startTicks:raw.slice(raw.lastIndexOf(')')+2).trim().split(/\\s+/)[19],
        parentPid:Number(status.match(/^PPid:\\s+(\\d+)/m)[1])};
};
const appIdentity=identity(slot.pid);
const daemonPid=Number(fs.readFileSync(path.join(process.env.PM2_HOME,'pm2.pid'),'utf8').trim());
const daemonIdentity=identity(daemonPid);
assert.equal(appIdentity.parentPid,daemonPid);
const command=fs.readFileSync(`/proc/${daemonPid}/cmdline`,'utf8').replaceAll('\\0',' ').trim();
assert.match(command,/^PM2 v[0-9.]+: God Daemon /);
if(mode==='title-truncation'){
    const version=JSON.parse(fs.readFileSync('/usr/lib/node_modules/pm2/package.json','utf8')).version;
    const expected=`PM2 v${version}: God Daemon (${process.env.PM2_HOME})`;
    assert.ok(expected.startsWith(command));assert.ok(command.length<expected.length);
    fs.writeFileSync(path.join(lab,'capture-result.json'),JSON.stringify({mode,state:'title_truncation_reproduced',
        expectedLength:expected.length,observedLength:command.length,prefixMatch:true,
        pythonOwnerUid:fs.statSync('/usr/bin/python3.13').uid}),{mode:0o600,flag:'wx'});
    process.exit(0);
}
assert.ok(command.endsWith(`(${process.env.PM2_HOME})`));
assert.equal(fs.realpathSync(`/proc/${slot.pid}/exe`),'/usr/bin/node');
assert.equal(fs.realpathSync(`/proc/${daemonPid}/exe`),'/usr/bin/node');
const capsule=await import('./capsule.mjs');
process.env.PROC_NAME=name;
const evidence={schema:'nassaj-private-pm2-capture/v1',mode,serviceUid:process.getuid(),
    pythonOwnerUid:fs.statSync('/usr/bin/python3.13').uid,watchType:typeof slot.pm2_env.watch,
    autorestartType:typeof slot.pm2_env.autorestart,appIdentity,daemonIdentity,pm2Home:process.env.PM2_HOME,
    captureScope:'real-runtime-private-pm2-no-root-namespace-claim',calls};
evidence.daemonLaunch='official-root-owned-Daemon.js-with-inert-argv-padding';
if(mode==='missing-watch'){
    await assert.rejects(capsule.captureOidTripleSupervisor(app,{oldPid:slot.pid,oldStartTicks:appIdentity.startTicks}),
        {message:'pm2_observation_unknown:entry_invalid'});
    assert.equal(typeof slot.pm2_env.watch,'undefined');
    evidence.state='missing_watch_reproduced';
}else{
    const supervisor=await capsule.captureOidTripleSupervisor(app,{oldPid:slot.pid,oldStartTicks:appIdentity.startTicks});
    assert.equal(slot.pm2_env.watch,false);
    capsule.validateOidTriplePm2Slot(rows,{root:app,name,pid:slot.pid});
    capsule.validateOidTriplePm2Dump(JSON.parse(fs.readFileSync(path.join(process.env.PM2_HOME,'dump.pm2'),'utf8')),slot);
    assert.equal(supervisor.startTime,appIdentity.startTicks);
    assert.equal(supervisor.observer.daemon.uid,1000);
    for(const key of ['controlsSha256','dumpSha256','environmentSha256','stableEnvironmentSha256','pm2TreeSha256']){
        assert.match(supervisor[key],/^[a-f0-9]{64}$/);evidence[key]=supervisor[key];
    }
    assert.equal(supervisor.observer.peerCredentialReader.runtime.schema,'nassaj-pm2-python-runtime/v1');
    assert.ok(calls.credentialCompleted>=2);assert.ok(calls.ssCompleted>=1);
    evidence.state='capture_verified';evidence.dumpVerified=true;evidence.startTicksVerified=true;
}
fs.writeFileSync(path.join(lab,'capture-result.json'),JSON.stringify(evidence,null,2),{mode:0o600,flag:'wx'});
"""


def child_identity(pid):
    """Require an actual direct child with this guardian's credentials."""
    status = Path(f'/proc/{pid}/status').read_text().splitlines()
    fields = dict(line.split(':', 1) for line in status if ':' in line)
    assert int(fields['PPid']) == os.getpid(), 'foreign parent'
    assert list(map(int, fields['Uid'].split())) == [os.getuid()] * 4, 'foreign UID'
    raw = Path(f'/proc/{pid}/stat').read_text()
    return raw[raw.rfind(')') + 2:].split()[19]


def reap_owned_children():
    """Pin and terminate only guardian children, including adopted orphan grandchildren."""
    deadline, killed = time.monotonic() + 5, []
    while time.monotonic() < deadline:
        children = Path(f'/proc/self/task/{os.getpid()}/children').read_text().split()
        for value in children:
            pid = int(value)
            try:
                before = child_identity(pid)
                fd = os.pidfd_open(pid)
                try:
                    assert child_identity(pid) == before, 'child identity changed'
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                    killed.append({'pid': pid, 'startTicks': before})
                finally:
                    os.close(fd)
            except (FileNotFoundError, ProcessLookupError):
                pass
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return killed
        time.sleep(0.01)
    raise RuntimeError('guardian children not fully reaped')


def guardian(run, mode):
    """Run one fixed fixture worker with isolated PM2 paths and always reap descendants."""
    assert run.parent == ARTIFACTS and run.name.startswith('pm2-cap-')
    assert run.resolve() == run and run.stat().st_uid == os.getuid() == 1000
    assert (run.stat().st_mode & 0o777) == 0o700
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.prctl(36, 1, 0, 0, 0) == 0  # PR_SET_CHILD_SUBREAPER, this process only
    environment = {'PATH':'/usr/bin:/usr/sbin', 'LANG':'C.UTF-8', 'HOME':str(run / 'home'),
                   'PM2_HOME':str(run / 'home/.pm2'), 'TMPDIR':str(run / 'tmp')}
    for name in ('home', 'home/.pm2', 'tmp'):
        directory = run / name
        assert directory.resolve() == directory
        assert directory.stat().st_uid == os.getuid()
        assert sorted(path.name for path in directory.iterdir()) == (['.pm2'] if name == 'home' else [])
        assert (directory.stat().st_mode & 0o777) == 0o700
    # home contains only the checked, empty PM2 directory after these individual checks.
    result = {'schema':'nassaj-private-pm2-guardian/v1', 'mode':mode, 'workerExit':None}
    for binary in ('/usr/bin/node', '/usr/bin/python3.13', '/usr/lib/node_modules/pm2/bin/pm2',
                   '/usr/lib/node_modules/pm2/lib/Daemon.js'):
        metadata = Path(binary).stat()
        assert metadata.st_uid == 0 and not metadata.st_mode & 0o022
    try:
        command = ['/usr/bin/python3.13', '-I', '-S', '-B', str(SELF), '--idle-worker', mode]
        if mode in ('title-truncation', 'missing-watch', 'complete', 'after-start-failure'):
            command = ['/usr/bin/node', str(run / 'worker.mjs'), str(run), mode]
        with (run / 'worker.stdout').open('w') as stdout, (run / 'worker.stderr').open('w') as stderr:
            child = subprocess.Popen(command, env=environment, cwd=run, stdout=stdout, stderr=stderr)
            fd = os.pidfd_open(child.pid)
            try:
                child_identity(child.pid)
                try:
                    result['workerExit'] = child.wait(timeout=0.2 if mode == 'idle-timeout' else 45)
                except subprocess.TimeoutExpired:
                    result['workerTimeout'] = True
            finally:
                os.close(fd)
    finally:
        result['terminated'] = reap_owned_children()
        result['allChildrenReaped'] = True
        (run / 'guardian-result.json').write_text(json.dumps(result, indent=2))


def idle_worker(mode):
    """Create an orphan grandchild before any PM2 pidfile exists, then fail or time out."""
    read_fd, write_fd = os.pipe()
    middle = os.fork()
    if middle == 0:
        os.close(read_fd)
        grandchild = os.fork()
        if grandchild == 0:
            os.setsid()
            os.write(write_fd, b'ready')
            while True:
                signal.pause()
        os._exit(0)
    os.close(write_fd)
    assert os.read(read_fd, 5) == b'ready'
    os.waitpid(middle, 0)
    if mode == 'idle-failure':
        sys.exit(23)
    while True:
        signal.pause()


class GuardianTests(unittest.TestCase):
    def test_start_failure_and_timeout_reap_orphans_without_pidfile(self):
        for mode in ('idle-failure', 'idle-timeout'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='pm2-cap-', dir=ARTIFACTS) as directory:
                run = Path(directory)
                for name in ('home', 'home/.pm2', 'tmp'):
                    (run / name).mkdir(mode=0o700)
                result = subprocess.run(['/usr/bin/python3.13', '-I', '-S', '-B', str(SELF),
                                         '--guardian', str(run), mode], capture_output=True, text=True, timeout=12)
                self.assertEqual(result.returncode, 0, result.stderr)
                evidence = json.loads((run / 'guardian-result.json').read_text())
                self.assertTrue(evidence['allChildrenReaped'])
                self.assertGreaterEqual(len(evidence['terminated']), 1)
                self.assertFalse((run / 'home/.pm2/pm2.pid').exists())
                if mode == 'idle-failure':
                    self.assertEqual(evidence['workerExit'], 23)
                else:
                    self.assertTrue(evidence['workerTimeout'])


class RuntimeTests(unittest.TestCase):
    def test_actual_pm2_missing_watch_then_full_capture_and_early_failure_cleanup(self):
        source=(ROOT/'scripts/update-lab/service-owner-probe.mjs').read_text()
        setup=source[source.index('const app='):source.index('let report=')]
        # The fixture definition is copied verbatim; only its idle-file location differs.
        setup=setup.replace("'/reviewed-harness/idle.mjs'","path.join(lab,'idle.mjs')")
        for mode in ('title-truncation','missing-watch','complete','after-start-failure'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='pm2-cap-',dir=ARTIFACTS) as directory:
                run=Path(directory)
                for name in ('home','home/.pm2','tmp'):(run/name).mkdir(mode=0o700)
                (run/'idle.mjs').write_text('setInterval(() => {}, 1000);\n')
                capsule=(ROOT/'scripts/oid-control-capsule.mjs').read_bytes()
                (run/'capsule.mjs').write_bytes(capsule)
                body=setup.replace('watch:false,','') if mode=='missing-watch' else setup
                (run/'worker.mjs').write_text(WORKER_PREFIX+body+WORKER_CAPTURE)
                result=subprocess.run(['/usr/bin/python3.13','-I','-S','-B',str(SELF),'--guardian',str(run),mode],
                                      capture_output=True,text=True,timeout=60)
                self.assertEqual(result.returncode,0,result.stderr)
                guard=json.loads((run/'guardian-result.json').read_text())
                self.assertTrue(guard['allChildrenReaped'])
                self.assertEqual(guard['workerExit'],24 if mode=='after-start-failure' else 0,
                                 (run/'worker.stderr').read_text())
                self.assertGreaterEqual(len(guard['terminated']),2)
                evidence_dir=ARTIFACTS/'t1772-current-readiness-20260919/repair-20260920'
                if mode=='after-start-failure' and evidence_dir.is_dir():
                    (evidence_dir/'probe-runtime-early-failure-guardian.json').write_text(json.dumps(guard,indent=2)+'\n')
                if mode!='after-start-failure':
                    evidence=json.loads((run/'capture-result.json').read_text())
                    expected={'title-truncation':'title_truncation_reproduced','missing-watch':'missing_watch_reproduced',
                              'complete':'capture_verified'}
                    self.assertEqual(evidence['state'],expected[mode])
                    self.assertEqual(evidence['pythonOwnerUid'],0)
                    evidence['capsuleSha256']=hashlib.sha256(capsule).hexdigest()
                    evidence['probeSourceSha256']=hashlib.sha256(source.encode()).hexdigest()
                    evidence['fixtureSetupSha256']=hashlib.sha256(body.encode()).hexdigest()
                    evidence['guardian']=guard
                    # Optional evidence output is constrained to the project review directory.
                    if evidence_dir.is_dir():
                        (evidence_dir/f'probe-runtime-{mode}.json').write_text(json.dumps(evidence,indent=2)+'\n')


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--guardian':
        guardian(Path(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == '--idle-worker':
        idle_worker(sys.argv[2])
    else:
        unittest.main()
