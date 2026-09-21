/** B899-only composition. The PM2 address alone is mapped to private-netns TCP.
 * kernelSnapshot/peerProof retain real daemon PID/start/boot, but Unix socket inode/ss
 * correlation is covered by pm2-readonly-observer.test.mjs, not this composition.
 * Host credential/systemd/routing metadata is simulated; root CAS, FD channels,
 * retirement writers, compiled A, allocated slot and startup admission are real.
 * The target is a small context/health process, not the compiled full application;
 * full application security/SQL behavior remains covered by the cold startup suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { createHash, sign } from 'node:crypto';
import { build } from 'esbuild';
import { prepareProducedFacade } from './fixtures/forward-facade-producer.mjs';
import { stageFixtureInstalledSupport, attestFixtureInstalledConfig, FIXTURE_DISPATCHER } from './fixtures/installed-config-authority.mjs';
import { createBootstrapContextHarness } from './fixtures/bootstrap-context-harness.mjs';
import { collectForwardExecutableClosure } from './build-release-asset.mjs';
import { inspectForwardChildIdentity, forwardValueSha256 as sha, canonicalForwardValue } from './lib/release-runtime-forward-child-protocol.mjs';
const project = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => ({ path: fs.realpathSync(file), sha256: hash(fs.readFileSync(file)) });
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const sealForwardFixtureFile = (file, mode = 0o644) => fs.chmodSync(file, mode);
async function waitFile(file, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file)); await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error(`fixture deadline: ${path.basename(file)}`);
}
const ownedChildren = new WeakMap();
async function stopOwnedChildren(t) {
    for (const { child, closed } of [...(ownedChildren.get(t) || [])].reverse()) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        try { await closed; } finally { clearTimeout(timer); }
    }
}
async function child(t, file, args = [], options = {}) {
    const processChild = spawn(process.execPath, [file, ...args], { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    const closed = once(processChild, 'close');
    if (!ownedChildren.has(t)) ownedChildren.set(t, []);
    ownedChildren.get(t).push({ child: processChild, closed });
    let output = '', errors = '';
    processChild.stdout.on('data', bytes => output += bytes); processChild.stderr.on('data', bytes => errors += bytes);
    return { process: processChild, output: () => output, errors: () => errors };
}
async function setup(t, options = {}) {
    assert.ok(process.env.NASSAJ_TEST_TMP, 'run inside the B899 launcher');
    const outer = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP, 'facade-'));
    t.after(async () => { await stopOwnedChildren(t); fs.rmSync(outer, { recursive: true, force: true }); });
    const databaseRoot = path.join(outer, 'database'); fs.mkdirSync(databaseRoot, { mode: 0o700 });
    // Bundled backend imports still require a server directory as their root anchor.
    const seedRoot = path.join(outer, 'server'); fs.mkdirSync(seedRoot);
    const seed = path.join(seedRoot, 'seed.mjs');
    const seedSource = fs.readFileSync(path.join(project, 'server/scripts/fixtures/compatible-forward-child.test.ts'), 'utf8')
        .replace("if (scenario !== 'crash-after-commit') initialize();", "if (scenario !== 'crash-after-commit') initialize(); if (scenario === 'facade-seed') return;");
    await build({ stdin: { contents: seedSource, resolveDir: path.join(project, 'server/scripts/fixtures'), loader: 'ts' }, outfile: seed,
        bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: path.join(project, 'server/tsconfig.json'), logLevel: 'silent' });
    // Import the bundle from a distinct entrypoint so imported CLI guards stay inactive.
    const seedRunner = path.join(outer, 'seed-runner.mjs');
    fs.writeFileSync(seedRunner, "await import('./server/seed.mjs');\n");
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(outer, 'node_modules'));
    fs.copyFileSync(path.join(project, 'server/scripts/fixtures/compatible-forward-schema-v1.json'), path.join(seedRoot, 'compatible-forward-schema-v1.json'));
    const seeded = spawnSync(process.execPath, [seedRunner, 'facade-seed', databaseRoot], { encoding: 'utf8', timeout: 20000 });
    assert.equal(seeded.status, 0, seeded.stderr);
    const seededMaterial = JSON.parse(fs.readFileSync(path.join(databaseRoot, 'context.json')));
    fs.chmodSync(seededMaterial.request.database.realpath, 0o600);
    const f = createBootstrapContextHarness(t, { localBuild: true, databasePath: seededMaterial.request.database.realpath,
        databaseTarget: seededMaterial.contract.target, childTimeoutMs: 60000 });
    let generation = f.releaseRoot;
    sealForwardFixtureFile(path.join(generation, 'RELEASE_ASSET_MANIFEST.json'));
    if (options.producer) { generation = path.join(f.root, f.identity.generationId); fs.renameSync(f.releaseRoot, generation); f.releaseRoot = generation; }
    for (const file of collectForwardExecutableClosure(project).files) {
        const target = path.join(generation, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(project, file.path), target); sealForwardFixtureFile(target, file.mode);
    }
    const codecFiles = JSON.parse(fs.readFileSync(path.join(project, 'scripts/vendor/pm2-codec/SOURCE_MANIFEST.json'))).files;
    const codecPins = [];
    for (const record of codecFiles) {
        const relative = record.path; const target = path.join(generation, 'node_modules', relative);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(project, 'scripts/vendor/pm2-codec', relative), target);
        sealForwardFixtureFile(target);
        codecPins.push({ path: relative, sha256: hash(fs.readFileSync(target)) });
    }
    codecPins.sort((a, b) => a.path < b.path ? -1 : 1);
    for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) fs.symlinkSync(path.join(project, 'node_modules', name), path.join(generation, 'node_modules', name));
    const packageJson = path.join(generation, 'package.json');
    fs.writeFileSync(packageJson, '{"type":"module","version":"fixture"}'); sealForwardFixtureFile(packageJson);
    const oldApp = path.join(generation, 'old.mjs'); fs.writeFileSync(oldApp, 'setInterval(()=>{},1000);');
    const descriptor = { name: 'facade-fixture', namespace: 'facade', pm_exec_path: oldApp, pm_cwd: generation,
        exec_interpreter: fs.realpathSync(process.execPath), exec_mode: 'fork_mode', uid: process.getuid(), gid: process.getgid(),
        pm_out_log_path: path.join(outer, 'out'), pm_err_log_path: path.join(outer, 'err'), pm_pid_path: path.join(outer, 'pid'),
        status: 'stopped', autostart: true, autorestart: false, watch: false, pmx: false, vizion: false, wait_ready: false,
        restart_time: 0, unstable_restarts: 0, prev_restart_delay: 0, env: {} };
    const socketPath = path.join(process.env.NASSAJ_TEST_TMP, 'facade.rpc');
    const daemonInput = { codecEntry: path.join(generation, 'node_modules/amp-message/index.js'), oldDescriptor: descriptor,
        socketPath, home: outer, version: 'fixture', traceFile: path.join(outer, 'rpc-trace'), childOutput: path.join(outer, 'child-output'), readyFile: path.join(outer, 'daemon-ready') };
    const daemonFile = path.join(outer, 'daemon-input.json'); put(daemonFile, daemonInput);
    const daemon = await child(t, path.join(project, 'scripts/fixtures/forward-facade-pm2.mjs'), [daemonFile]);
    let ready; try { ready = await waitFile(daemonInput.readyFile); } catch (error) { throw Error(`${error.message}: ${daemon.errors()}`); }
    const identity = inspectForwardChildIdentity(ready.daemonPid);
    const observer = { socketPath, daemon: { pid: identity.pid, startTicks: identity.startTicks, bootId: identity.bootId,
        uid: process.getuid(), exeSha256: pin(process.execPath).sha256 }, socketIdentity: { transport: 'fixture-loopback', port: ready.port },
        codec: { root: path.join(generation, 'node_modules'), files: codecPins }, codecClosureSha256: sha(codecPins), ss: pin('/usr/bin/ss') };
    return { f, outer, generation, databaseRoot, seededMaterial, daemon, ready, observer, descriptor };
}

async function wire(t, fixture, options = {}) {
    const { f, generation, outer, databaseRoot, seededMaterial, ready, observer, descriptor } = fixture;
    const parent = path.join(generation, 'scripts/release-runtime-forward-parent.mjs');
    const wrapper = path.join(generation, 'scripts/release-runtime-forward-child.mjs');
    for (const name of ['root-hook', 'transport', 'contention']) {
        const target = path.join(generation, `fixture-${name}.mjs`);
        fs.copyFileSync(path.join(project, `scripts/fixtures/forward-facade-${name}.mjs`), target); sealForwardFixtureFile(target);
    }
    for (const file of [parent, wrapper]) { fs.writeFileSync(file, "import '../fixture-root-hook.mjs';\n" + fs.readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, '')); sealForwardFixtureFile(file); }
    // Only the approved fixture transport dependency seam changes this copied module.
    // Its codec, parser, execution-intent/ACK/result algorithms remain the source implementation.
    let parentBytes = "import '../fixture-contention.mjs';\n" + fs.readFileSync(parent, 'utf8').replace('${error.message}', '${error.stack}');
    for (const [stage, anchor] of Object.entries({ target_verified: 'await persistVerifiedForwardTargetDefinitions(config);',
        gate: 'await openForwardGate(config, operationId);', finalization: 'finalizeCommittedStartupAdmission(config);' })) {
        assert.equal(parentBytes.split(anchor).length, 2);
        parentBytes = parentBytes.replace(anchor, `await globalThis.fixtureContentionBarrier('${stage}'); ` + anchor);
    }
    fs.writeFileSync(parent, parentBytes.replaceAll("catch { return { schema: 'nassaj-forward-lock-reconciliation/v1'",
        "catch (error) { process.stderr.write(String(error.message) + '\\n'); return { schema: 'nassaj-forward-lock-reconciliation/v1'")); sealForwardFixtureFile(parent);
    const observerFile = path.join(generation, 'scripts/lib/pm2-readonly-observer.mjs');
    const observerSource = fs.readFileSync(observerFile, 'utf8');
    const anchor = 'async function observeSession(settings, deps = {}, mutation = null) {';
    assert.equal(observerSource.split(anchor).length, 2);
    fs.writeFileSync(observerFile, "import {fixturePm2Dependencies} from '../../fixture-transport.mjs';\n" + observerSource.replace(anchor, anchor + '\n deps = {...fixturePm2Dependencies(settings), ...deps};').replace("} catch { throw Error('pm2_mutation_unknown:effect_unproven'); }", "} catch (error) { process.stderr.write(String(error.message) + '\\n'); throw Error('pm2_mutation_unknown:effect_unproven'); }")); sealForwardFixtureFile(observerFile);
    const entry = path.join(generation, 'dist-server/server/scripts/release-database-migration.js'); fs.mkdirSync(path.dirname(entry), { recursive: true });
    await build({ entryPoints: [path.join(project, 'server/scripts/release-database-migration.ts')], outfile: entry,
        bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: path.join(project, 'server/tsconfig.json'), logLevel: 'silent' });
    const unitFile = path.join(outer, 'unit.json');
    const compiledA = fs.readFileSync(entry, 'utf8');
    const migrationFunction = /function runCompatibleForwardMigration\([^)]*\) \{/;
    assert.ok(migrationFunction.test(compiledA));
    fs.writeFileSync(entry, "import * as fixtureAuditFs from 'node:fs';\n" + compiledA.replace(migrationFunction,
        match => match + `fixtureAuditFs.appendFileSync(${JSON.stringify(path.join(outer, 'migration-calls'))}, 'A\\n');`));
    sealForwardFixtureFile(entry);
    const unit = { Id: 'fixture-writer.service', LoadState: 'loaded', ActiveState: 'inactive', UnitFileState: 'enabled',
        ControlGroup: '', FragmentPath: '/fixture/unused.service', DropInPaths: '', ExecStart: '/fixture/unused', ExecStartPre: '' };
    put(unitFile, unit);
    const systemctl = path.join(outer, 'systemctl.mjs');
    fs.writeFileSync(systemctl, `#!/usr/bin/node
import fs from 'node:fs';const file=${JSON.stringify(unitFile)};const unit=JSON.parse(fs.readFileSync(file));const args=process.argv.slice(2);
if(args[0]==='mask'){unit.LoadState='masked';unit.UnitFileState='masked';fs.writeFileSync(file,JSON.stringify(unit));}
else if(args[0]==='stop'){unit.ActiveState='inactive';fs.writeFileSync(file,JSON.stringify(unit));}
else if(args[0]==='show'){const fields=args.find(arg=>arg.startsWith('--property='))?.slice(11).split(',')||Object.keys(unit);process.stdout.write(fields.map(key=>key+'='+unit[key]).join('\\n'));}else process.exit(7);`, { mode: 0o755 });
    const route = path.join(outer, 'routing.json'); put(route, { closed: false });
    const maintenance = (_request, response) => { response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30', 'x-nassaj-maintenance-nonce': 'nassaj-maintenance-v1' });
        response.end(JSON.stringify({ schema: 'nassaj-maintenance/v1', state: 'maintenance', nonce: 'nassaj-maintenance-v1' })); };
    const responder = http.createServer(maintenance);
    let tlsOptions;
    if (options.producer) {
        const key = path.join(outer, 'public-key.pem'), cert = path.join(outer, 'public-cert.pem');
        const generated = spawnSync('/usr/bin/openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1',
            '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert], { encoding:'utf8',timeout:10000 });
        assert.equal(generated.status,0,generated.stderr); tlsOptions={key:fs.readFileSync(key),cert:fs.readFileSync(cert)};
    }
    const publicHandler = async (request, response) => {
        if (JSON.parse(fs.readFileSync(route)).closed) return maintenance(request, response);
        try { const upstream = await fetch('http://127.0.0.1:3312/health'); response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(await upstream.text()); }
        catch { response.writeHead(503); response.end('{}'); }
    };
    const publicServer = options.producer ? https.createServer(tlsOptions, publicHandler) : http.createServer(publicHandler);
    for (const [server, port] of [[responder, 3311], [publicServer, 3313]]) {
        await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    }
    const dispatcher = path.join(generation, 'fixture-dispatcher.mjs');
    fs.writeFileSync(dispatcher, `import ${JSON.stringify(path.join(generation,'fixture-root-hook.mjs'))};import fs from 'node:fs';
import {dispatchReleaseRuntimeHostOperation} from ${JSON.stringify(new URL('./lib/release-runtime-host-operations.mjs', import.meta.url).href)};
import {handleBootstrapStartupAdmission} from ${JSON.stringify(new URL('./lib/release-runtime-startup-admission.mjs', import.meta.url).href)};
import {inspectForwardChildIdentity} from ${JSON.stringify(new URL('./lib/release-runtime-forward-child-protocol.mjs', import.meta.url).href)};
const config=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.root, 'config.json'))}));let text='';for await(const bytes of process.stdin)text+=bytes;
const observe=()=>{const p=inspectForwardChildIdentity(process.ppid);return {uid:p.uids[0],pid:p.pid,startTicks:p.startTicks,bootId:p.bootId};};
const deps={attestMaintenancePrerequisites:()=>({fixtureHostMetadata:true}),exec:(_file,args)=>{if(JSON.stringify(args)!==JSON.stringify(['start','fixture-maintenance.service']))throw Error('fixture unexpected host command');return '';},
installMaintenanceGate:()=>fs.writeFileSync(${JSON.stringify(route)},JSON.stringify({closed:true})),removeMaintenanceGate:()=>fs.writeFileSync(${JSON.stringify(route)},JSON.stringify({closed:false}))};
try{const request=JSON.parse(text);const result=process.argv[2]==='claimBootstrapStartup'
?handleBootstrapStartupAdmission(config,request,observe,{ownerUid:0,readRootFile:file=>fs.readFileSync(file),inspectProcess:inspectForwardChildIdentity})
:await dispatchReleaseRuntimeHostOperation(config,process.argv[2],request,deps);
if(result.decision==='busy')fs.appendFileSync(${JSON.stringify(path.join(f.root,'serving-busy-evidence'))},JSON.stringify(result)+'\\n');
process.stdout.write(JSON.stringify(result));}catch(error){fs.appendFileSync(${JSON.stringify(path.join(outer, 'gate-errors'))},String(error.message)+'\\n');process.stderr.write(error.stack);process.exitCode=78;}`);
    sealForwardFixtureFile(dispatcher);
    const target = path.join(generation, 'target.mjs');
    fs.writeFileSync(target, `import ${JSON.stringify(path.join(f.root, 'fixture-hook.mjs'))};import http from 'node:http';
import https from 'node:https';
import {establishStartupAdmission,admitSecurityStartup,confirmStartupServing,readVerifiedStartupContext} from './dist-server/server/bootstrap-startup-context.js';
await establishStartupAdmission();await admitSecurityStartup();
const server=http.createServer((_request,response)=>{const c=readVerifiedStartupContext();response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify({status:'ok',privateSecurityReady:true,normalAdmissionReady:false,startupPhase:'security_startup_authorized',
claimId:c.claimId,generationEpoch:c.generationEpoch,pid:process.pid,startTicks:c.process.startTicks,bootId:c.process.bootId,releaseIdentitySha256:c.releaseIdentitySha256,generationId:c.generationId,serverBuildId:c.serverBuildId,clientBuildId:${JSON.stringify(f.manifest.build?.clientBuildId ?? f.manifest.clientBuildId)}}));});
await new Promise(resolve=>server.listen(3312,'127.0.0.1',resolve));await confirmStartupServing();`);
    const targetDescriptor = { ...descriptor, pm_exec_path: target };
    const saved = path.join(outer, 'dump.json'); put(saved, [ready.old.pm2_env]);
    const oldIdentity = inspectForwardChildIdentity(ready.old.pid);
    const config = f.config;
    config.stateLock = { schema: 'nassaj-cutover-state-lock/v2', flock: pin('/usr/bin/flock') };
    config.databaseFile = seededMaterial.request.database.realpath;
    config.oldProcess = { uid: process.getuid(), pid: oldIdentity.pid, startTicks: oldIdentity.startTicks, bootId: oldIdentity.bootId };
    const plan = { slot: { pm2Id: 4, name: descriptor.name, namespace: descriptor.namespace }, pm2: { observer },
        sources: [{ sourceId: 'dump', path: saved, format: 'pm2-dump-json', beforeSha256: pin(saved).sha256, writerSourceIds: ['writer'] }],
        mutation: { oldSlot: { pmId: 4, baseline: ready.old.pm2_env, entrySha256: sha(ready.old.pm2_env), process: config.oldProcess },
            targetDescriptor, metadata: { entryPath: target, packageJson: pin(path.join(generation, 'package.json')), node: pin(process.execPath) } } };
    const mutatorPlan = { systemctl: pin(systemctl), sources: [{ sourceId: 'writer', scope: 'system', unit: unit.Id, cgroupPath: '/fixture-unused', configurationSha256: sha(unit) }],
        inventory: [{ kind: 'file', path: systemctl, sha256: pin(systemctl).sha256 }] };
    config.forwardActivation = { supervisorPlan: plan, mutatorPlan, safeRestart: pin(path.join(generation, 'scripts/safe-restart.sh')), bash: pin('/bin/bash'), dispatcher: pin(dispatcher) };
    const probe = path.join(outer, 'probe'); fs.writeFileSync(probe, `#!/bin/sh\nprintf '%s' '{"liveSessions":0,"workflows":0,"admittedTurns":0}'\n`, { mode: 0o755 });
    if (options.crashPhase === 'supervisor_stop_deferred') {
        fs.writeFileSync(probe, `#!/usr/bin/node\nimport fs from 'node:fs';let journal;try{journal=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.root, 'first-cutover.json'))}));}catch{}
const busy=journal?.phase==='supervisor_stop_authorized'&&journal.forwardSupervisorAttempts?.length===1;process.stdout.write(JSON.stringify({liveSessions:busy?1:0,workflows:0,admittedTurns:0}));\n`);
    }
    config.zeroWorkProbe = { file: probe, sha256: pin(probe).sha256, args: [], timeoutMs: 1000 };
    Object.assign(f.manifest.databaseContract, { source: seededMaterial.contract.source, target: seededMaterial.contract.target });
    const contract = f.manifest.databaseContract; const request = { ...seededMaterial.request, transactionId: 'fixture-transaction-0001',
        releaseIdentitySha256: f.identity.releaseIdentitySha256, databaseContractSha256: sha(contract) };
    const requestFile = path.join(f.root, 'request.json'), contractFile = path.join(f.root, 'contract.json'); put(requestFile, request); put(contractFile, contract);
    Object.assign(f.identity, { databaseContractSha256: sha(contract) });
    Object.assign(config.expected, { databaseContractSha256: sha(contract), targetSchemaDigest: contract.target.schemaDigest,
        supervisorPlanSha256: sha(plan), mutatorPlanSha256: sha(mutatorPlan) });
    f.write('manifest.json', f.manifest); put(path.join(generation, 'RELEASE_ASSET_MANIFEST.json'), f.manifest);
    config.bootstrapClaim.releaseManifestSha256 = hash(JSON.stringify(f.manifest));
    const artifact = config.expected.localArtifact;
    Object.assign(artifact, { manifestSha256: hash(JSON.stringify(f.manifest)), manifestSize: Buffer.byteLength(JSON.stringify(f.manifest)), databaseContractSha256: sha(contract) });
    Object.assign(f.descriptor.artifact, artifact); f.descriptor.databaseContractSha256 = sha(contract);
    // Simulated root endpoint derives the CURRENT real operator identity from the producer journal.
    const endpoint = path.join(f.root, 'dispatcher.mjs'); const endpointText = fs.readFileSync(endpoint, 'utf8');
    fs.writeFileSync(endpoint, `import ${JSON.stringify(path.join(generation, 'fixture-root-hook.mjs'))};\n` + endpointText.replace('const operator=null;', `const operator=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.root, 'first-cutover.json'))})).operator;`).replace('const actual=inspectForwardChildIdentity(pid);', 'const actual=inspectForwardChildIdentity(pid);actual.supplementaryGids=[...new Set(actual.supplementaryGids)].sort((a,b)=>a-b);').replace('process.stdout.write(JSON.stringify(result));', "if(result.decision==='busy')fs.appendFileSync(root+'/serving-busy-evidence',JSON.stringify(result)+'\\n');process.stdout.write(JSON.stringify(result));").replace('process.stderr.write(error.message);', "fs.appendFileSync(root+'/endpoint-errors',String(error.message)+'\\n');process.stderr.write(error.message);"));
    f.descriptor.dispatcher.sha256 = pin(endpoint).sha256; f.write('descriptor.json', f.descriptor);
    const closure = path.join(f.root, 'forward-closure.json');
    const closureFiles = [...collectForwardExecutableClosure(project).files.map(file => path.join(generation, file.path)),
        path.join(generation, 'fixture-root-hook.mjs'), path.join(generation, 'fixture-transport.mjs'), path.join(generation, 'fixture-contention.mjs'), dispatcher, entry];
    assert.deepEqual(closureFiles.filter(file => fs.statSync(file).mode & 0o022), [], 'forward closure files must not be group- or world-writable');
    put(closure, { schema: 'nassaj-forward-child-closure/v1', files: closureFiles.sort().map(pin) });
    config.expected.forwardExecutableClosureSha256 = pin(closure).sha256;
    config.forwardMigration = { node: pin(process.execPath), parent: pin(parent), wrapper: pin(wrapper), entry: pin(entry), closure: pin(closure), request: pin(requestFile), contract: pin(contractFile),
        serviceIdentity: { uid: process.getuid(), gid: process.getgid(), supplementaryGids: [...new Set(process.getgroups())].sort((a, b) => a - b) } };
    config.bootstrapClaim.applicationUid = process.getuid(); config.bootstrapClaim.nodeExecutable = fs.realpathSync(process.execPath);
    config.maintenance = { nonce: 'nassaj-maintenance-v1', retryAfterSeconds: 30, responderUnit: 'fixture-maintenance.service', responderPort: 3311,
        cloudflared: { uid: process.getuid(), originPort: 3312 }, nft: { binary: systemctl, sha256: pin(systemctl).sha256 }, conntrack: { binary: systemctl, sha256: pin(systemctl).sha256 } };
    config.health = { privateUrl: 'http://127.0.0.1:3312/health', publicUrl: `${options.producer ? 'https' : 'http'}://127.0.0.1:3313/health` };
    const support = options.producer ? null : stageFixtureInstalledSupport(f.root, dispatcher);
    if (support) {
        config.forwardActivation.dispatcher = support.dispatcher;
        Object.assign(config.bootstrapClaim, { dispatcherExecutable: FIXTURE_DISPATCHER, dispatcherSha256: support.dispatcher.sha256 });
        f.descriptor.dispatcher = support.dispatcher; f.write('descriptor.json', f.descriptor); fs.chmodSync(path.join(f.root,'descriptor.json'),0o644);
        const hookFile = path.join(f.root,'fixture-hook.mjs');
        fs.writeFileSync(hookFile,fs.readFileSync(hookFile,'utf8').replaceAll(path.join(f.root,'dispatcher.mjs'),FIXTURE_DISPATCHER));
    }
    const approval = f.read('approval.json'); delete approval.signature;
    Object.assign(approval, { expectedSha256: sha(config.expected), startupAdmission: f.identity, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 299000 });
    f.write('approval.json', { ...approval, signature: sign(null, Buffer.from(canonicalForwardValue(approval)), f.keys.privateKey).toString('base64url') });
    f.write('config.json', config);
    if (support) attestFixtureInstalledConfig(f.root,support,path.join(f.root,'config.json'),path.join(f.root,'descriptor.json'));
    put(path.join(generation, 'facade-map.json'), { configFile: path.join(f.root, 'config.json'), control: f.root, databaseRoot, parent, pm2SocketLocator: observer.socketPath, pm2Port: ready.port, childDiagnostics: path.join(outer, 'worker-errors'), crashPhase: options.crashPhase ?? null, contentionStage: options.contentionStage ?? null, contentionWaiterDelayMs: options.contentionStage === 'target_verified' ? 3000 : 0, contentionEvidence: path.join(outer, 'contention-evidence'), installedOperatorRoot: support?.directory });
    for (const file of ['first-cutover.json', 'startup-admission.json', 'host-dispatch-state.json', 'first-cutover.lock']) fs.unlinkSync(path.join(f.root, file));
    return { parent, config, saved, systemctl, dispatcher, target, unit, route };
}

test('fresh facade keeps its forward closure sealed under umask 0002', async t => {
    const originalUmask = process.umask(0o002);
    let fixture, wired;
    try { fixture = await setup(t); wired = await wire(t, fixture); }
    finally { process.umask(originalUmask); }
    const operator = await child(t, wired.parent); operator.process.stdin.end(JSON.stringify({ schema: 'nassaj-forward-activation-operation/v1', operationId: 'fixture-transaction-0001' }) + '\n');
    const timer = setTimeout(() => operator.process.kill('SIGKILL'), 60000);
    const [code] = await once(operator.process, 'close'); clearTimeout(timer);
    const journalFile = path.join(fixture.f.root, 'first-cutover.json');
    const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile)) : null;
    const evidence = { migrationResultRecorded: Boolean(journal?.forwardMigrationResult), retirementRecorded: Boolean(journal?.forwardRetirement), initialProcessRecorded: Boolean(journal?.initialTargetProcess), allocatedPmId: journal?.targetSlotBinding?.allocatedPmId, endpointErrors: fs.existsSync(path.join(fixture.f.root,'endpoint-errors')) ? fs.readFileSync(path.join(fixture.f.root,'endpoint-errors'),'utf8') : '', code, phase: journal?.phase, workerErrors: fs.existsSync(path.join(fixture.outer,'worker-errors')) ? fs.readFileSync(path.join(fixture.outer,'worker-errors'),'utf8') : '', childOutput: fs.existsSync(path.join(fixture.outer,'child-output')) ? fs.readFileSync(path.join(fixture.outer,'child-output'),'utf8') : '', operatorError: operator.errors(), result: operator.output(),
        rpc: fs.existsSync(path.join(fixture.outer, 'rpc-trace')) ? fs.readFileSync(path.join(fixture.outer, 'rpc-trace'), 'utf8') : '' };
    fs.writeFileSync(path.join(process.env.NASSAJ_TEST_TMP, 'forward-facade-composition-last.json'), JSON.stringify(evidence, null, 2));
    assert.equal(code, 0, JSON.stringify(evidence)); assert.equal(journal?.phase, 'committed');
    assert.equal(fixture.f.read('startup-admission.json').state, 'active');
});


for (const crashPhase of ['supervisor_stop_deferred', 'retirement_verified', 'migration_observed']) test(`${crashPhase} crash reconciles and resumes without replaying A`, async t => {
    const fixture = await setup(t); const wired = await wire(t, fixture, { crashPhase });
    const locator = JSON.stringify({ schema: 'nassaj-forward-activation-operation/v1', operationId: 'fixture-transaction-0001' }) + '\n';
    const invoke = async args => { const operator = await child(t, wired.parent, args); operator.process.stdin.end(locator);
        const timer = setTimeout(() => operator.process.kill('SIGKILL'), 60000);
        const [code, signal] = await once(operator.process, 'close'); clearTimeout(timer);
        return { code, signal, output: operator.output(), error: operator.errors() }; };
    const crashed = await invoke([]); assert.equal(crashed.signal, 'SIGKILL', JSON.stringify(crashed));
    const prior = fixture.f.read('first-cutover.json'); assert.equal(prior.phase, crashPhase);
    const migrationSha = prior.forwardMigrationResult ? sha(prior.forwardMigrationResult) : null; const acceptedAt = prior.approvalAcceptedAt;
    const reconciled = await invoke(['--reconcile-forward']);
    reconciled.childError = fs.existsSync(path.join(fixture.outer, 'worker-errors')) ? fs.readFileSync(path.join(fixture.outer, 'worker-errors'), 'utf8') : '';
    assert.equal(reconciled.code, 0, JSON.stringify(reconciled));
    assert.equal(JSON.parse(reconciled.output).decision, 'reconciled', JSON.stringify(reconciled));
    const resumed = await invoke(['--resume-forward']);
    const afterResume = fixture.f.read('first-cutover.json');
    const resumeEvidence = { reconciled, resumed, phase: afterResume.phase, approvalAcceptedAtUnchanged: afterResume.approvalAcceptedAt === acceptedAt,
        migrationResultUnchanged: migrationSha === null || sha(afterResume.forwardMigrationResult) === migrationSha,
        migrationCalls: fs.readFileSync(path.join(fixture.outer, 'migration-calls'), 'utf8'),
        childErrors: fs.existsSync(path.join(fixture.outer, 'worker-errors')) ? fs.readFileSync(path.join(fixture.outer, 'worker-errors'), 'utf8') : '' };
    fs.writeFileSync(path.join(process.env.NASSAJ_TEST_TMP, 'forward-facade-resume-last.json'), JSON.stringify(resumeEvidence, null, 2));
    assert.equal(resumed.code, 0, JSON.stringify(resumeEvidence));
    const terminal = fixture.f.read('first-cutover.json'); assert.equal(terminal.phase, 'committed');
    assert.equal(terminal.approvalAcceptedAt, acceptedAt); if (migrationSha !== null) assert.equal(sha(terminal.forwardMigrationResult), migrationSha);
    assert.equal(fs.readFileSync(path.join(fixture.outer, 'migration-calls'), 'utf8'), 'A\n');
});

for (const stage of ['target_verified', 'gate', 'finalization']) test(`real IPC mutex contention at ${stage} cannot execute a callback after the acquisition deadline${stage === 'target_verified' ? ' (3 s fixture helper-start delay)' : ''}`, async t => {
    const fixture = await setup(t); const wired = await wire(t, fixture, { contentionStage: stage });
    const operator = await child(t, wired.parent);
    operator.process.stdin.end(JSON.stringify({ schema: 'nassaj-forward-activation-operation/v1', operationId: 'fixture-transaction-0001' }) + '\n');
    const timer = setTimeout(() => operator.process.kill('SIGKILL'), 60000);
    const [code] = await once(operator.process, 'close'); clearTimeout(timer);
    assert.ok(fs.existsSync(path.join(fixture.f.root, 'first-cutover.json')), JSON.stringify({code,error:operator.errors(),output:operator.output()}));
    const journal = fixture.f.read('first-cutover.json');
    await waitFile(path.join(fixture.outer, 'contention-evidence'));
    assert.ok(fs.existsSync(path.join(fixture.outer,'contention-evidence')), JSON.stringify({code,phase:journal.phase,error:operator.errors(),workerErrors:fs.existsSync(path.join(fixture.outer,'worker-errors'))?fs.readFileSync(path.join(fixture.outer,'worker-errors'),'utf8'):''}));
    const evidence = { stage, code, phase: journal.phase, error: operator.errors(),
        gateErrors: fs.existsSync(path.join(fixture.outer,'gate-errors')) ? fs.readFileSync(path.join(fixture.outer,'gate-errors'),'utf8') : '',
        servingBusyReplies: fs.existsSync(path.join(fixture.f.root,'serving-busy-evidence')) ? fs.readFileSync(path.join(fixture.f.root,'serving-busy-evidence'),'utf8').trim().split('\n').map(line=>JSON.parse(line)) : [],
        childErrors: fs.existsSync(path.join(fixture.outer, 'worker-errors')) ? fs.readFileSync(path.join(fixture.outer, 'worker-errors'), 'utf8') : '',
        waiter: stage === 'target_verified' ? JSON.parse(fs.readFileSync(path.join(fixture.outer, 'contention-evidence.waiter-done'))) : null,
        holder: JSON.parse(fs.readFileSync(path.join(fixture.outer, 'contention-evidence'), 'utf8').trim()) };
    fs.writeFileSync(path.join(process.env.NASSAJ_TEST_TMP, `forward-facade-contention-${stage}.json`), JSON.stringify(evidence, null, 2));
    assert.equal(code, 78, JSON.stringify(evidence));
    assert.equal(journal.phase, stage === 'finalization' ? 'public_verified' : 'target_verified');
    assert.ok(BigInt(evidence.holder.heldNs) >= 2_000_000_000n);
    if (stage === 'gate' || stage === 'target_verified') {
        assert.equal(evidence.holder.waiter.status, 75); assert.equal(evidence.holder.waiter.signal, null);
        assert.equal(evidence.holder.waiter.error, undefined);
        assert.ok(BigInt(evidence.holder.waiter.finishedNs) - BigInt(evidence.holder.waiter.startedNs) >= 2_000_000_000n,
            'the selected helper itself waited for the fixed acquisition deadline');
    }
    if (stage === 'target_verified') {
        const waiter = evidence.holder.waiter;
        assert.match(evidence.error, /cutover_state_busy/);
        assert.equal(journal.forwardTargetDefinitions, undefined, 'blocked callback never writes target definitions');
        assert.deepEqual(waiter, evidence.waiter);
        assert.ok(BigInt(waiter.startedNs) - BigInt(waiter.beforeDelayNs) >= 3_000_000_000n, 'fixture stresses delayed waiter startup');
        assert.ok(BigInt(evidence.holder.acquiredNs) < BigInt(waiter.startedNs));
        assert.ok(BigInt(evidence.holder.releasedNs) >= BigInt(waiter.finishedNs), 'holder must outlive the actual waiter');
    }
    assert.equal(inspectForwardChildIdentity(journal.startupClaim.pid).startTicks, journal.startupClaim.startTicks, 'busy confirmation cannot terminate the admitted target');
    assert.ok(fs.existsSync(path.join(fixture.f.root, 'first-cutover.lock')), 'uncertain root operation retains its evidence lock');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.outer, 'routing.json'))).closed, stage !== 'finalization', 'routing reflects only effects completed before the blocked callback');
    assert.equal(fixture.f.read('startup-admission.json').state, 'switching', 'no terminal serving grant after failed acquisition');
    const mutationCalls = fs.readFileSync(path.join(fixture.outer, 'rpc-trace'), 'utf8').trim().split('\n').map(line=>JSON.parse(line).method).filter(method=>method!=='getMonitorData');
    assert.deepEqual(mutationCalls, ['stopProcessId','deleteProcessId','prepare','startProcessId'], 'no PM2 effect retry');
    assert.equal(fs.readFileSync(path.join(fixture.outer, 'migration-calls'), 'utf8'), 'A\n');
});


test('actual local producer and signer feed a fresh facade through committed', async t => {
    const fixture=await setup(t,{producer:true});const wired=await wire(t,fixture,{producer:true});
    const prepared=await prepareProducedFacade(fixture,wired);assert.equal(prepared.report.complete,true);
    const configSha=hash(fs.readFileSync(path.join(fixture.f.root,'config.json')));
    const approvalSha=hash(fs.readFileSync(prepared.config.bootstrapClaim.approvalFile));
    const manifestMode=fs.statSync(prepared.config.bootstrapClaim.releaseManifestFile).mode&0o777;
    assert.equal(manifestMode,0o600,'producer private manifest remains private');
    const publicManifest=path.join(fixture.generation,'RELEASE_ASSET_MANIFEST.json');
    assert.equal(fs.statSync(publicManifest).mode&0o777,0o644,'public release manifest retains normalized permissions');
    assert.deepEqual(fs.readFileSync(prepared.config.bootstrapClaim.releaseManifestFile),fs.readFileSync(publicManifest));
    const operator=await child(t,wired.parent);operator.process.stdin.end(JSON.stringify({schema:'nassaj-forward-activation-operation/v1',operationId:'fixture-transaction-0001'})+'\n');
    const timer=setTimeout(()=>operator.process.kill('SIGKILL'),60000);const [code]=await once(operator.process,'close');clearTimeout(timer);
    const evidence={code,phase:fixture.f.read('first-cutover.json').phase,childOutput:fs.existsSync(path.join(fixture.outer,'child-output'))?fs.readFileSync(path.join(fixture.outer,'child-output'),'utf8'):'',workerErrors:fs.existsSync(path.join(fixture.outer,'worker-errors'))?fs.readFileSync(path.join(fixture.outer,'worker-errors'),'utf8'):'',error:operator.errors(),output:operator.output(),dispatchErrors:fs.existsSync(path.join(fixture.outer,'producer-dispatch-errors'))?fs.readFileSync(path.join(fixture.outer,'producer-dispatch-errors'),'utf8'):''};
    put(path.join(process.env.NASSAJ_TEST_TMP,'forward-facade-producer-last.json'),{
        code,phase:evidence.phase,manifestMode,producerComplete:prepared.report.complete,
        configUnchanged:configSha===hash(fs.readFileSync(path.join(fixture.f.root,'config.json'))),
        approvalUnchanged:approvalSha===hash(fs.readFileSync(prepared.config.bootstrapClaim.approvalFile)),
        migrationCalls:fs.existsSync(path.join(fixture.outer,'migration-calls'))?fs.readFileSync(path.join(fixture.outer,'migration-calls'),'utf8').trim().split('\n').length:0,
        diagnostics:evidence,
        limitations:['simulated root and systemd/routing metadata','private-netns TCP PM2 transport; Unix peer proof separate','tiny context target; full application cold test separate']});
    assert.equal(configSha,hash(fs.readFileSync(path.join(fixture.f.root,'config.json'))));
    assert.equal(approvalSha,hash(fs.readFileSync(prepared.config.bootstrapClaim.approvalFile)));
    assert.equal(code,0,JSON.stringify(evidence));assert.equal(fixture.f.read('first-cutover.json').phase,'committed');
    assert.equal(fs.readFileSync(path.join(fixture.outer,'migration-calls'),'utf8'),'A\n');
});
