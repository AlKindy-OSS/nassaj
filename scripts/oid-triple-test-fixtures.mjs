/** Test-only PM2 transport double; never used as actual supervisor/admission evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureOidTriplePm2Authority } from './oid-control-capsule.mjs';
import { hashDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

/** Persist synthetic jlist/dump files while exercising the real controller's executable and process guards. */
export function oidTriplePm2TransportFixture(root, child, transaction) {
    const pm2Home=path.join(root,'pm2-home'), packageRoot=path.join(root,'pm2-package');
    fs.mkdirSync(pm2Home,{mode:0o700});fs.mkdirSync(packageRoot,{mode:0o700});
    const file=path.join(packageRoot,'pm2.mjs');
    fs.writeFileSync(file,`import fs from 'node:fs';import path from 'node:path';const base=process.env.PM2_HOME;const command=process.argv[2];fs.appendFileSync(path.join(base,'commands'),command+'\\n');const rows=JSON.parse(fs.readFileSync(path.join(base,'slots.json')));if(command==='jlist')process.stdout.write(JSON.stringify(rows));else if(command==='save'){if(fs.existsSync(path.join(base,'fail-save')))process.exit(9);const dump=rows.map(row=>{const env={...row.pm2_env,name:row.name};delete env.pm_id;return env;});fs.writeFileSync(path.join(base,'dump.pm2'),JSON.stringify(dump),{mode:0o600});}else process.exit(98);`,{mode:0o600});
    const environment={NASSAJ_UPDATE_MODE:'local-main',NASSAJ_PREVIEW_TRANSACTION_NONCE:transaction.transactionNonce,NASSAJ_PREVIEW_BOOT_NONCE:transaction.bootNonce};
    const slot={name:'test',pm_id:4,pid:child.pid,pm2_env:{name:'test',namespace:'default',autorestart:true,watch:false,exec_interpreter:process.execPath,exec_mode:'fork_mode',status:'online',pm_exec_path:path.join(root,'dist-server/server/index.js'),pm_cwd:root,treekill:false,kill_timeout:86400000,...environment,env:environment}};
    fs.writeFileSync(path.join(pm2Home,'slots.json'),JSON.stringify([slot]),{mode:0o600});
    const executable=filepath=>({path:fs.realpathSync(filepath),sha256:sha(fs.readFileSync(filepath)),mode:fs.statSync(filepath).mode&0o777,size:fs.statSync(filepath).size});
    const daemon={pid:process.pid,startTime:fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19],bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
    return {node:executable(process.execPath),pm2:executable(file),pm2Home,authority:captureOidTriplePm2Authority(pm2Home),pm2PackageRoot:packageRoot,pm2TreeSha256:hashDependencyTreeV2(packageRoot).sha256,daemon,daemonExecutableSha256:sha(fs.readFileSync('/proc/self/exe')),
        root,name:'test',pmId:4,pid:child.pid,startTime:child.startTime,environmentSha256:sha(canonical(environment)),stableEnvironmentSha256:sha(canonical({NASSAJ_UPDATE_MODE:'local-main'}))};
}

/** Start a separate, existing AF_UNIX read-only daemon for capsule integration tests. */
export async function attachOidTripleSocketFixture(supervisor) {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { capturePm2PeerCredentialReader } = await import('./lib/pm2-existing-transport.mjs');
    const { inspectForwardChildIdentity } = await import('./lib/release-runtime-forward-child-protocol.mjs');
    const { serviceOwnerSlotControls } = await import('./lib/pm2-service-owner.mjs');
    const { makeShortSocketDir } = await import('./lib/short-socket-dir.mjs');
    const directory = makeShortSocketDir('triple-rpc-', 'rpc.sock'), socketPath = path.join(directory, 'rpc.sock');
    const codec = new URL('./vendor/pm2-codec/amp-message/index.js', import.meta.url).href;
    const program = `import fs from 'node:fs';import net from 'node:net';import Message from ${JSON.stringify(codec)};
const server=net.createServer(socket=>{socket.on('error',()=>{});socket.on('data',data=>{const [request,id]=new Message(data).args;
if(request.method!=='getMonitorData')return socket.destroy();const rows=JSON.parse(fs.readFileSync(process.argv[2]));
socket.write(new Message([{args:[rows]},id]).toBuffer());});});server.listen(process.argv[1],()=>process.stdout.write('ready\\n'));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, socketPath, path.join(supervisor.pm2Home, 'slots.json')], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout, 'data');
    const identity = inspectForwardChildIdentity(child.pid), stat = fs.lstatSync(socketPath, { bigint: true });
    const row = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').map(line => line.trim().split(/\s+/)).find(value => value[7] === socketPath && value[3] === '00010000');
    supervisor.daemon = { pid: child.pid, startTime: identity.startTicks, bootId: identity.bootId };
    supervisor.observer = { socketPath, daemon: { pid: child.pid, startTicks: identity.startTicks, bootId: identity.bootId,
        uid: process.getuid(), exeSha256: sha(fs.readFileSync(process.execPath)) }, socketIdentity: { device: String(stat.dev), inode: String(stat.ino), uid: process.getuid(), listenerInode: row[6], networkNamespace: fs.readlinkSync('/proc/self/ns/net') },
        ss: { path: '/usr/bin/ss', sha256: sha(fs.readFileSync('/usr/bin/ss')) }, peerCredentialReader: capturePm2PeerCredentialReader() };
    const slot = JSON.parse(fs.readFileSync(path.join(supervisor.pm2Home, 'slots.json')))[0];
    supervisor.controlsSha256 = sha(canonical(serviceOwnerSlotControls(slot)));
    const bytes = Buffer.from(JSON.stringify([{ ...slot.pm2_env, name: slot.name }]));
    fs.writeFileSync(path.join(supervisor.pm2Home, 'dump.pm2'), bytes, { mode: 0o600 });
    supervisor.dumpSha256 = sha(bytes);
    return async () => { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; fs.rmSync(directory, { recursive: true, force: true }); };
}
