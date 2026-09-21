import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const project = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(project, 'scripts/lib/release-runtime-forward-initialization.mjs'), 'utf8');
const functions = source.slice(source.indexOf('function readDomainIncarnation('), source.indexOf('\nfunction inspectUnitPreflight('));
function fixture({ memberships = ['0::/outside\n'], ticks = ['100'], states = ['S'], failure, absent, identityFailure,
    identities = [{ pid: 42, startTicks: '100', bootId: 'boot' }], statBytes } = {}) {
    let stats = 0; let groups = 0; let full = 0; let existence = 0;
    const pick = (values, index) => values[Math.min(index, values.length - 1)];
    const context = {
        fs: { readdirSync: () => ['42'], readFileSync: file => {
            if (failure) throw Object.assign(Error(failure), { code: failure });
            if (file.endsWith('/cgroup')) return pick(memberships, groups++);
            if (statBytes !== undefined) return statBytes;
            const fields = Array(20).fill('0'); fields[0] = pick(states, stats); fields[19] = pick(ticks, stats++);
            return `42 (worker) ${fields.join(' ')}`;
        }, statSync: () => { existence++; if (absent) throw Object.assign(Error(absent), { code: absent }); return {}; } },
        inspectForwardChildIdentity: () => {
            const actual = pick(identities, full++); if (identityFailure) throw Error(identityFailure);
            return actual;
        }, check: (ok, code) => { if (!ok) throw Error(`forward_initialization_${code}`); }
    };
    const scan = vm.runInNewContext(`${functions}\ndomainMembers`, context);
    return { run: () => scan({ cgroupPath: '/target' }, {}), calls: () => ({ stats, groups, full, existence }) };
}
for (const membership of ['0::/target\n', '0::/target/child\n', '1:cpu,cpuacct:/target\n0::/outside\n']) {
    test(`inside exact/descendant membership keeps both full observations: ${membership.trim()}`, () => {
        const f = fixture({ memberships: [membership] }); assert.equal(f.run().length, 1);
        assert.equal(f.calls().full, 2); assert.equal(f.calls().groups, 2);
    });
}
for (const state of ['S', 'Z', 'X']) test(`outside sibling with state ${state} never invokes full identity`, () => {
    const f = fixture({ memberships: ['0::/target-sibling\n'], states: [state], identityFailure: 'must_not_run' });
    assert.equal(f.run().length, 0); assert.deepEqual(f.calls(), { stats: 2, groups: 2, full: 0, existence: 0 });
});
for (const membership of ['', '\n', 'garbage', '0:relative', '0::relative\n', '0::/ok\n\n',
    '0::/ok\nmalformed\n', '0::/ok\n0::/other\n', '1:cpu,,memory:/target\n', '1::/outside\n',
    '0:cpu:/target\n', '1:cpu,cpu:/target\n', '0::/bad\u0000\n']) {
    test(`malformed whole membership refuses ${JSON.stringify(membership)}`, () => {
        assert.throws(() => fixture({ memberships: [membership] }).run(), /domain_membership_invalid/);
    });
}
for (const memberships of [['0::/outside\n', '0::/target\n'], ['0::/target\n', '0::/outside\n'],
    ['0::/outside\n', '0::/elsewhere\n'], ['1:cpu:/outside\n0::/target\n', '1:cpu:/changed\n0::/target\n']]) {
    test(`whole membership drift refuses ${JSON.stringify(memberships)}`, () => {
        assert.throws(() => fixture({ memberships }).run(), /domain_scan_unstable/);
    });
}
test('outside PID reuse refuses without full identity', () => {
    const f = fixture({ ticks: ['100', '101'] }); assert.throws(f.run, /domain_scan_unstable/); assert.equal(f.calls().full, 0);
});
test('inside zombie full identity denial is preserved', () => {
    assert.throws(() => fixture({ memberships: ['0::/target\n'], identityFailure: 'forward_child_process_changed' }).run(), /forward_child_process_changed/);
});
for (const identities of [[{ startTicks: '101', bootId: 'boot' }],
    [{ startTicks: '100', bootId: 'boot' }, { startTicks: '101', bootId: 'boot' }],
    [{ startTicks: '100', bootId: 'boot' }, { startTicks: '100', bootId: 'reboot' }]]) {
    test(`inside light/full or full/full incarnation drift refuses ${JSON.stringify(identities)}`, () => {
        assert.throws(() => fixture({ memberships: ['0::/target\n'], identities }).run(), /domain_scan_unstable/);
    });
}
for (const statBytes of ['', '43 (foreign) S', '42 malformed S', '42 (worker) S 0',
    `42 (worker) S ${Array(18).fill('0').join(' ')} invalid`]) {
    test(`malformed lightweight stat refuses ${JSON.stringify(statBytes)}`, () => {
        assert.throws(() => fixture({ statBytes }).run(), /domain_stat_invalid/);
    });
}
for (const code of ['EACCES', 'EPERM', 'EIO']) test(`inaccessible observation ${code} never treated as absence`, () => {
    const f = fixture({ failure: code, absent: 'ENOENT' }); assert.throws(f.run, new RegExp(code)); assert.equal(f.calls().existence, 0);
});
for (const failure of ['ENOENT', 'ESRCH']) {
    test(`${failure} only skips with explicit absent proc directory`, () => {
        const f = fixture({ failure, absent: 'ENOENT' }); assert.equal(f.run().length, 0); assert.equal(f.calls().existence, 1);
        assert.throws(() => fixture({ failure }).run(), new RegExp(failure));
        assert.throws(() => fixture({ failure, absent: 'EACCES' }).run(), /EACCES/);
    });
}
test('B942 unrelated normal exit and zombie do not reject domain preflight under B899', t => {
    const root = fs.mkdtempSync(path.join(project, '.artifacts', 'forward-domain-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [source, output] of [['cold-startup-mount-isolation.c', 'isolate'], ['forward-domain-zombie.c', 'zombie']]) {
        const built = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror',
            path.join(project, 'scripts/fixtures', source), '-o', path.join(root, output)],
        { encoding: 'utf8', env: { ...process.env, TMPDIR: root } });
        assert.equal(built.status, 0, built.stderr);
    }
    const entry = path.join(root, 'entry.mjs');
    fs.writeFileSync(entry, `
import fs from 'node:fs'; import assert from 'node:assert/strict'; import vm from 'node:vm';
import {spawn} from 'node:child_process'; import {once} from 'node:events'; import {createInterface} from 'node:readline';
import {inspectForwardChildIdentity} from ${JSON.stringify(new URL('./lib/release-runtime-forward-child-protocol.mjs', import.meta.url).href)};
assert.equal(process.pid,1);
assert.notEqual(fs.readlinkSync('/proc/self/ns/mnt'),${JSON.stringify(fs.readlinkSync('/proc/self/ns/mnt'))});
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),${JSON.stringify(fs.readlinkSync('/proc/self/ns/net'))});
for(const line of fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n')){
 const f=line.split(' ');assert.equal(f[5].split(',').includes('rw'),f[4]===${JSON.stringify(root)});
}
// Run the exact private production function. Only exposing it is a test seam;
// procfs enumeration, credentials, cgroups, identity reads and process lifecycle are real.
const source=fs.readFileSync(${JSON.stringify(path.join(project, 'scripts/lib/release-runtime-forward-initialization.mjs'))},'utf8');
const start=source.indexOf('function readDomainIncarnation(');
const end=source.indexOf('\\nfunction inspectUnitPreflight(',start);
assert.ok(start>=0 && end>start);
const scan=vm.runInNewContext(source.slice(start,end)+'\\ndomainMembers',{
 fs,inspectForwardChildIdentity,check:(ok,code)=>{if(!ok)throw Error('forward_initialization_'+code);}
});
const target={cgroupPath:'/nassaj-absent-diagnostic-domain-'+process.pid};
assert.equal(scan(target,{}).length,0);
const holder=spawn(${JSON.stringify(path.join(root, 'zombie'))},[],{stdio:['pipe','pipe','pipe']});
const closed=once(holder,'exit');
const lines=createInterface({input:holder.stdout})[Symbol.asyncIterator]();
const pid=Number((await lines.next()).value);assert.ok(pid>1);
const before=inspectForwardChildIdentity(pid);
const cgroup=fs.readFileSync('/proc/'+pid+'/cgroup','utf8');
assert.equal(cgroup.split('\\n').some(line=>line.endsWith(':'+target.cgroupPath)||line.includes(':'+target.cgroupPath+'/')),false);
assert.equal(scan(target,{}).length,0);
holder.stdin.write('x');assert.equal((await lines.next()).value,'zombie');
const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
assert.equal(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0],'Z');
assert.throws(()=>inspectForwardChildIdentity(pid),/forward_child_process_changed/);
assert.equal(scan(target,{}).length,0);
// The actual unit-preflight branch uses the same scan. Only systemctl facts are
// supplied by a fixture; it has no executable or journal-writing dependency.
const unitEnd=source.indexOf('/** Validate prepared configuration',end);
const facts={Id:'fixture.service',LoadState:'loaded',ActiveState:'inactive',ControlGroup:''};
const preflight=vm.runInNewContext(source.slice(start,unitEnd)+'\\ninspectUnitPreflight',{
 fs,inspectForwardChildIdentity,unitFacts:()=>facts,digest:()=> 'facts-hash',
 check:(ok,code)=>{if(!ok)throw Error('forward_initialization_'+code);}
});
assert.equal(preflight({}, {...target,unit:'fixture.service',configurationSha256:'facts-hash'},{}),facts);
assert.equal(fs.readFileSync('/proc/'+pid+'/cgroup','utf8'),cgroup);
holder.stdin.end('x');assert.deepEqual(await closed,[0,null]);
assert.equal(fs.existsSync('/proc/'+pid),false);
assert.equal(scan(target,{}).length,0);
console.log(JSON.stringify({normalExitOutsideDomain:true,scanPassesWhileZombie:true,unitPreflightPasses:true,scanPassesAfterReap:true,
 pid,startTicks:before.startTicks,scope:'exact private domainMembers + real B899 procfs; not historical incident attribution'}));
`);
    const env = { ...process.env, TMPDIR: root }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync('/usr/bin/unshare', ['--user', '--map-current-user', '--mount', '--net', '--pid',
        '--keep-caps', '--fork', '--kill-child', path.join(root, 'isolate'), fs.readlinkSync('/proc/self/ns/mnt'),
        root, process.execPath, entry], { encoding: 'utf8', timeout: 15000, env });
    fs.writeFileSync(path.join(project, '.artifacts', 'forward-domain-scan-diagnostic.log'), result.stdout + '\n' + result.stderr);
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
});
