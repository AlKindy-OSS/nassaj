import { installCodexImageOnlyTestFixture } from './lib/codex-image-only-test-fixture.mjs';
import {installFixedStateMutexAuthority} from './fixtures/fixed-state-mutex-authority.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { forwardBuildInput, forwardSha256, canonicalForward, FORWARD_PROFILE_MODULE,
    FORWARD_PROFILE_ID } from './lib/compatible-forward-release-profile.mjs';
import { collectMigrationClosure } from './lib/release-database-migration-closure.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('forward identity is domain-separated and binds full source, reviewed fixture and generated module bytes', () => {
    const input = forwardBuildInput(ROOT, 'a'.repeat(64));
    assert.equal(input.material.profileId, FORWARD_PROFILE_ID);
    assert.equal(input.buildId, forwardSha256(canonicalForward(input.material)));
    assert.notEqual(input.buildId, 'a'.repeat(64));
    assert.notEqual(input.buildId, forwardBuildInput(ROOT, 'b'.repeat(64)).buildId);
    assert.equal(input.material.profileModuleSha256, forwardSha256(FORWARD_PROFILE_MODULE));
    assert.equal(input.material.profileGeneratorSha256,
        forwardSha256(readFileSync(path.join(ROOT, 'scripts/lib/compatible-forward-release-profile.mjs'))));
    assert.throws(() => forwardBuildInput(ROOT, 'invalid'), /source_fingerprint/);
});

import { chmodSync, cpSync, readdirSync, symlinkSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { collectForwardStartupMaterial, verifyForwardStartupMaterial, observeForwardProfile,
    STARTUP_ROOTS, STARTUP_MODE_POLICY } from './lib/compatible-forward-release-profile.mjs';
import { installUpdateRuntimeBundle, FORWARD_EXECUTABLE_ENTRIES } from './lib/update-runtime-bundle.mjs';
import { buildReleaseAsset, collectForwardExecutableClosure } from './build-release-asset.mjs';
import { currentReleaseRuntimeTarget, extractTarGzExact, verifyExtractedReleaseAsset, validateReleaseAssetManifest,
    FORWARD_EXECUTABLE_MANIFEST_PATH, verifyForwardExecutableManifest } from './lib/update-release-asset.mjs';
import { inspectSealedRelease } from './nassaj-release-launcher.mjs';
import { prepareInitialReleaseRuntime } from './bootstrap-release-runtime.mjs';
const HOST = { platform: 'linux', arch: 'x64', libc: '2.41', nodeMajor: 24, nodeModules: 137 };
const temp = () => mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP || path.join(ROOT, '.artifacts'), 'forward-profile-'));
const H = char => char.repeat(64);
const FIXTURE_FILE_MODE = 0o644;
const FIXTURE_DIRECTORY_MODE = 0o755;
function writeFixtureFile(file, contents) {
    writeFileSync(file, contents, { mode: FIXTURE_FILE_MODE });
    chmodSync(file, FIXTURE_FILE_MODE);
}
function normalizeFixtureTree(root) {
    const pending = [root];
    while (pending.length) {
        const current = pending.pop(); const info = lstatSync(current);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
            chmodSync(current, FIXTURE_DIRECTORY_MODE);
            for (const name of readdirSync(current)) pending.push(path.join(current, name));
            continue;
        }
        if (info.isFile()) chmodSync(current, info.mode & 0o111 ? 0o755 : FIXTURE_FILE_MODE);
    }
}
function miniFixture(root) {
    const source = path.join(root, 'source'); const runtime = path.join(source, 'dist-server');
    mkdirSync(runtime, { recursive: true }); mkdirSync(path.join(source, 'dist'));
    for (const entry of STARTUP_ROOTS) {
        const file = path.join(runtime, entry); mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, entry === 'server/bootstrap-release-profile.js' ? FORWARD_PROFILE_MODULE : 'export const ready = true;\n');
    }
    mkdirSync(path.join(source, 'server/bin'), {recursive:true});
    cpSync(path.join(ROOT, 'server/bin/claude'), path.join(source, 'server/bin/claude'));
    mkdirSync(path.join(runtime, 'server/services/isolation'), {recursive:true});
    writeFileSync(path.join(runtime, 'server/services/isolation/managed-claude-launcher.js'), 'export const ready=true;\n');
    writeFileSync(path.join(runtime, 'server/bootstrap.js'), "import 'runtime-fixture'; export const ready=true;\n");
    mkdirSync(path.join(runtime, 'server/scripts'));
    writeFileSync(path.join(runtime, 'server/scripts/release-database-migration.js'), 'export const migrate=true;\n');
    installCodexImageOnlyTestFixture(source);
    const pkg = path.join(source, 'node_modules/runtime-fixture'); mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', main: 'index.js' }));
    writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 42;\n'); chmodSync(path.join(pkg, 'index.js'), 0o444);
    writeFileSync(path.join(pkg, 'run.sh'), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(pkg, 'run.sh'), 0o555);
    writeFileSync(path.join(source, 'package.json'), JSON.stringify({type:'module'}));
    writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({lockfileVersion:3,packages:{'':{},
        'node_modules/@openai/codex-sdk': { version: '0.153.2', integrity: 'sha512-YQ==' }, 'node_modules/runtime-fixture':{version:'1.0.0',integrity:'sha512-YQ=='}}}));
    for(const entry of FORWARD_EXECUTABLE_ENTRIES) {
        const target=path.join(source,entry);mkdirSync(path.dirname(target),{recursive:true});
        writeFileSync(target,entry==='scripts/safe-restart.sh'?readFileSync(path.join(ROOT,entry)):entry==='scripts/release-runtime-forward-child.mjs'
            ? "import './lib/release-runtime-forward-child-protocol.mjs'; export const load=()=>import('../dist-server/server/scripts/release-database-migration.js');\n"
            : entry==='scripts/lib/release-runtime-forward-receipts.mjs' ? "export {fixture} from './root-nested-fixture.mjs';\n" : 'export const fixture=true;\n');
    }
    writeFileSync(path.join(source,'scripts/lib/root-nested-fixture.mjs'),'export const fixture=true;\n');
    cpSync(path.join(ROOT,'scripts/vendor/pm2-codec'),path.join(source,'scripts/vendor/pm2-codec'),{recursive:true});
    installUpdateRuntimeBundle(ROOT, runtime);
    const provenance = {version:'1.47.0.3',commit:'b'.repeat(40),buildId:H('d')};
    for (const directory of [runtime,path.join(source,'dist')]) writeFileSync(path.join(directory,'BUILD_PROVENANCE.json'),JSON.stringify(provenance));
    writeFileSync(path.join(source,'dist/index.html'),'<!doctype html>');
    normalizeFixtureTree(source);
    chmodSync(path.join(pkg, 'index.js'), 0o444);
    chmodSync(path.join(pkg, 'run.sh'), 0o555);
    const startup = collectForwardStartupMaterial(runtime,{packageLockFile:path.join(source,'package-lock.json')});
    writeFixtureFile(path.join(runtime,'STARTUP_CLOSURE.json'),JSON.stringify(startup.material));
    return {source,runtime,pkg,startup,provenance};
}

test('forward startup pins exact sharp native bytes without widening generic migration or caller admission', () => {
    const root = temp();
    try {
        const runtime = path.join(root, 'dist-server');
        for (const entry of STARTUP_ROOTS) {
            const file = path.join(runtime, entry);
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, entry === 'server/bootstrap-release-profile.js' ? FORWARD_PROFILE_MODULE : 'export const ready = true;\n');
        }
        const nativeName = '@img/sharp-linux-x64', libraryName = '@img/sharp-libvips-linux-x64';
        const lock = { lockfileVersion: 3, packages: { '': {} } };
        for (const name of [nativeName, libraryName, 'unreviewed-native']) {
            const directory = path.join(root, 'node_modules', name);
            mkdirSync(directory, { recursive: true });
            const manifest = { name, version: '1.0.0', main: 'index.js' };
            if (name === nativeName) manifest.optionalDependencies = { [libraryName]: '1.0.0' };
            writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
            writeFileSync(path.join(directory, 'index.js'), 'module.exports = {};\n');
            writeFileSync(path.join(directory, name === libraryName ? 'libvips.so.1' : 'binding.node'), 'native fixture bytes');
            lock.packages[`node_modules/${name}`] = { version: '1.0.0' };
        }
        const packageLockFile = path.join(root, 'package-lock.json');
        writeFileSync(packageLockFile, JSON.stringify(lock));
        const entry = path.join(runtime, 'server/bootstrap.js');
        writeFileSync(entry, `import '${nativeName}';\n`);
        assert.throws(() => collectMigrationClosure(runtime, 'server/bootstrap.js', { packageLockFile }),
            /migration_closure_native_package_blocked:@img\/sharp-linux-x64/);
        normalizeFixtureTree(root);
        const startup = collectForwardStartupMaterial(runtime, { packageLockFile });
        writeFixtureFile(path.join(runtime, 'STARTUP_CLOSURE.json'), JSON.stringify(startup.material));
        verifyForwardStartupMaterial(root, startup.sha256);
        for (const relative of [`node_modules/${nativeName}/binding.node`, `node_modules/${libraryName}/libvips.so.1`]) {
            assert.ok(startup.material.files.some(file => file.path === relative));
            const file = path.join(root, relative), bytes = readFileSync(file);
            writeFileSync(file, Buffer.from(bytes).fill(0));
            assert.throws(() => verifyForwardStartupMaterial(root, startup.sha256), /forward_startup_bytes_changed/);
            writeFileSync(file, bytes);
        }
        writeFileSync(entry, "import 'unreviewed-native';\n");
        assert.throws(() => collectMigrationClosure(runtime, 'server/bootstrap.js', { packageLockFile }),
            /migration_closure_native_package_blocked:unreviewed-native/);
        assert.throws(() => collectForwardStartupMaterial(runtime, { packageLockFile,
            nativePackageAllowlist: ['unreviewed-native'] }), /migration_closure_native_package_blocked:unreviewed-native/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mode policy is explicit and tar extraction matches projected modes without modifying source', () => {
    const root=temp();
    try {
        const fixture=miniFixture(root);
        assert.equal(fixture.startup.material.modePolicy,STARTUP_MODE_POLICY);
        const archive=path.join(root,'test.tar.gz');
        const tar=spawnSync('tar',['-czf',archive,'-C',fixture.source,'dist-server','node_modules'],{encoding:'utf8'});
        assert.equal(tar.status,0,tar.stderr); const extracted=path.join(root,'extracted'); mkdirSync(extracted,{mode:0o700});
        extractTarGzExact(readFileSync(archive),extracted);
        verifyForwardStartupMaterial(extracted,fixture.startup.sha256);
        for(const [name,original,normalized] of [['index.js',0o444,0o644],['run.sh',0o555,0o755]]) {
            assert.equal(lstatSync(path.join(fixture.pkg,name)).mode&0o777,original);
            const copied=path.join(extracted,'node_modules/runtime-fixture',name);
            assert.equal(lstatSync(copied).mode&0o777,normalized);
            assert.deepEqual(readFileSync(copied),readFileSync(path.join(fixture.pkg,name)));
            chmodSync(copied,original);
            assert.throws(()=>verifyForwardStartupMaterial(extracted,fixture.startup.sha256),/bytes_changed/);
            chmodSync(copied,normalized);
        }
        const materialFile=path.join(extracted,'dist-server/STARTUP_CLOSURE.json');
        for(const transform of [m=>{delete m.modePolicy;},m=>{m.modePolicy='unreviewed';},m=>{m.files.pop();},
            m=>{m.files[0].size++;},m=>{m.files[0].sha256=H('f');},m=>{m.files.push({...m.files.at(-1),path:'node_modules/zz'});}]) {
            const changed=structuredClone(fixture.startup.material); transform(changed); writeFileSync(materialFile,JSON.stringify(changed));
            assert.throws(()=>verifyForwardStartupMaterial(extracted,fixture.startup.sha256),/material_mismatch/);
            if(changed.modePolicy!==STARTUP_MODE_POLICY) assert.throws(()=>verifyForwardStartupMaterial(extracted,forwardSha256(canonicalForward(changed))),/material_mismatch/);
        }
        assert.throws(()=>collectForwardStartupMaterial(fixture.runtime,{packageLockFile:path.join(fixture.source,'package-lock.json'),
            testHooks:{afterScan:()=>chmodSync(path.join(fixture.pkg,'index.js'),0o644)}}),/source_raced/);
        chmodSync(path.join(fixture.pkg,'index.js'),0o555);
        assert.notEqual(collectForwardStartupMaterial(fixture.runtime,{packageLockFile:path.join(fixture.source,'package-lock.json')}).sha256,fixture.startup.sha256);
    } finally {rmSync(root,{recursive:true,force:true});}
});

test('fixed factory runs the actual compiled permission/receipt migration on reviewed schema in an isolated child', () => {
    const root=temp();
    try {
        const runtime=path.join(root,'dist-server'); const module=path.join(runtime,'server/scripts/release-database-migration.js');
        mkdirSync(path.dirname(module),{recursive:true});
        // Bundle only the accepted production observer/migration, never initializeDatabase.
        buildSync({stdin:{contents:`export {observeCompatibleForwardDatabase} from './server/scripts/release-database-migration.ts';\nexport {migrateCompatibleForwardPermissionReceipt} from './server/modules/database/compatible-forward-permission-receipt.migration.ts';`,resolveDir:ROOT},
            outfile:module,bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',tsconfig:path.join(ROOT,'server/tsconfig.json')});
        mkdirSync(path.join(runtime,'server/modules/database'),{recursive:true});
        writeFileSync(path.join(runtime,'server/modules/database/compatible-forward-permission-receipt.migration.js'),"export {migrateCompatibleForwardPermissionReceipt} from '../../scripts/release-database-migration.js';\n");
        const observation=observeForwardProfile({sourceRoot:ROOT,runtimeRoot:runtime,packageLockFile:path.join(ROOT,'package-lock.json')});
        assert.equal(observation.source.schemaDigest,'9dd61e321dee9789d48d1f30b7fe3c828ceb87a45242d0f1d3e67905f60d11de');
        assert.notEqual(observation.source.schemaDigest,observation.target.schemaDigest);
        assert.notEqual(observation.source.migrationStateDigest,observation.target.migrationStateDigest);
        const deltaProxy=path.join(runtime,'server/modules/database/compatible-forward-permission-receipt.migration.js');
        const mutations=[
            'ALTER TABLE pending_server_actions DROP COLUMN execution_attempt_nonce',
            ...['effect_footprint','effect_child_pid','effect_child_boot_id','effect_child_start_ticks']
                .map(column=>'ALTER TABLE permission_admission_leases DROP COLUMN '+column),
            'ALTER TABLE message_coordination_ingress DROP COLUMN accepted_at',
            'DROP TABLE permission_effect_fences',
            'CREATE INDEX unreviewed_delta_index ON app_config(key)',
        ];
        for(const sql of mutations) {
            writeFileSync(deltaProxy,"import {migrateCompatibleForwardPermissionReceipt as migrate} from '../../scripts/release-database-migration.js';\n"
                + 'export function migrateCompatibleForwardPermissionReceipt(db){migrate(db);db.exec('+JSON.stringify(sql)+');}\n');
            assert.throws(()=>observeForwardProfile({sourceRoot:ROOT,runtimeRoot:runtime,packageLockFile:path.join(ROOT,'package-lock.json')}),
                /forward_fixture_extra_schema_effect/,sql);
        }

    } finally {rmSync(root,{recursive:true,force:true});}
});

test('forward archive roundtrip retains exact manifest bytes and pins bootstrap generation without aliasing v1', () => {
    const root=temp();
    try {
        const fixture=miniFixture(root); const target=currentReleaseRuntimeTarget(); let smokeCount=0;
        const output=path.join(root,'output');
        const built=buildReleaseAsset({sourceRoot:fixture.source,outputDirectory:output,temporaryRoot:root,
            version:fixture.provenance.version,commit:fixture.provenance.commit,repo:'AlKindy-OSS/nassaj',releaseId:41,profile:FORWARD_PROFILE_ID},
        {runtimeHost:HOST,buildTarget:target,runtimeTarget:target,runtimeRoots:()=>['@openai/codex-sdk','runtime-fixture'],
            observeForwardProfile:()=>({source:{schemaDigest:H('1'),compatibilityShapeDigest:H('2'),migrationStateDigest:H('3')},
                target:{schemaDigest:H('4'),compatibilityShapeDigest:H('5'),migrationStateDigest:H('6')}}),
            runtimeSmoke:directory=>{const child=spawnSync(process.execPath,['--input-type=commonjs','-e',"if(require('./node_modules/runtime-fixture')!==42 || typeof require('./node_modules/amp-message')!=='function') process.exit(1)"],{cwd:directory,encoding:'utf8'});
                assert.equal(child.status,0,child.stderr);
                const wrapper=spawnSync(process.execPath,['--input-type=module','-e',"const {load}=await import('./scripts/release-runtime-forward-child.mjs'); if((await load()).migrate!==true)process.exit(2);"],{cwd:directory,encoding:'utf8'});
                assert.equal(wrapper.status,0,wrapper.stderr);
                const nested=path.join(directory,'scripts/lib/root-nested-fixture.mjs');const original=readFileSync(nested);
                const verify=()=>verifyExtractedReleaseAsset(directory,{repo:'AlKindy-OSS/nassaj',releaseId:41,tag:'v1.47.0.3',
                    version:fixture.provenance.version,commit:fixture.provenance.commit},{runtimeTarget:target,expectedStartupClosureSha256:fixture.startup.sha256});
                for(const mutate of [()=>writeFileSync(nested,'tampered'),()=>rmSync(nested),()=>writeFileSync(path.join(directory,'scripts/extra.mjs'),'extra')]) {
                    mutate();assert.throws(verify,/tree does not match/);writeFixtureFile(nested,original);
                    rmSync(path.join(directory,'scripts/extra.mjs'),{force:true});
                }
                const verified=verify();
                const executableMaterial=verifyForwardExecutableManifest(directory,verified.manifest);
                assert.deepEqual(executableMaterial.roots,[...FORWARD_EXECUTABLE_ENTRIES].sort());
                assert.ok(executableMaterial.files.some(record=>record.path==='scripts/lib/root-nested-fixture.mjs'));
                assert.ok(verified.manifest.files.some(record=>record.path===FORWARD_EXECUTABLE_MANIFEST_PATH));
                smokeCount++;}});
        assert.equal(smokeCount,1);
        assert.ok(built.forwardExecutableFiles.some(file=>file.path==='scripts/lib/root-nested-fixture.mjs'));
        for(const record of built.forwardExecutableFiles) assert.deepEqual(record,built.manifest.files.find(file=>file.path===record.path));
        assert.equal(path.basename(built.publishedManifest),'RELEASE_ASSET_MANIFEST.forward.json');
        assert.equal(built.assetName,'nassaj-runtime-forward-v1.47.0.3.tar.gz');
        const bytes=readFileSync(built.publishedManifest);
        const expected={repo:'AlKindy-OSS/nassaj',releaseId:41,assetId:73,tag:'v1.47.0.3',version:'1.47.0.3',commit:fixture.provenance.commit,
            assetSize:built.size,assetSha256:built.assetSha256,profile:'forward',assetName:built.assetName,
            detachedManifestName:path.basename(built.publishedManifest),detachedManifestId:74,detachedManifestSize:bytes.length,
            detachedManifestSha256:forwardSha256(bytes),databaseContractSha256:forwardSha256(canonicalForward(built.manifest.databaseContract)),
            expectedStartupClosureSha256:fixture.startup.sha256};
        assert.throws(()=>validateReleaseAssetManifest(built.manifest,expected),/database_release_contract_invalid/);
        const deploy=path.join(root,'deploy'); const options={deployRoot:deploy,profile:'forward',assetFile:built.asset,
            manifestFile:built.publishedManifest,nodeInstanceId:'fixture-node',runtimeHost:HOST,expected};
        for(const bad of [{expectedStartupClosureSha256:H('e')},{detachedManifestId:73},{assetName:'nassaj-runtime-v1.47.0.3.tar.gz'},
            {detachedManifestName:'RELEASE_ASSET_MANIFEST.json'},{detachedManifestSha256:H('c')},{databaseContractSha256:H('c')}]) {
            assert.throws(()=>prepareInitialReleaseRuntime({...options,expected:{...expected,...bad}})); assert.equal(existsSync(deploy),false);
        }
        const prepared=prepareInitialReleaseRuntime(options);
        assert.equal(prepared.generationId,`1.47.0.3-${'b'.repeat(12)}-forward-${built.assetSha256}`);
        assert.notEqual(prepared.generationId,`1.47.0.3-${'b'.repeat(12)}`);
        assert.deepEqual(readFileSync(path.join(deploy,'releases',prepared.generationId,'RELEASE_ASSET_MANIFEST.json')),bytes);
        assert.equal(prepareInitialReleaseRuntime(options).generationId,prepared.generationId);
        const journal=readFileSync(prepared.journalFile);
        assert.throws(()=>prepareInitialReleaseRuntime({...options,expected:{...expected,detachedManifestId:75}}),/Bootstrap initial selection identity mismatch/);
        assert.deepEqual(readFileSync(prepared.journalFile),journal);
        const changedArchive=Buffer.from(readFileSync(built.asset)); changedArchive[4] ^= 1;
        writeFileSync(built.asset,changedArchive);
        assert.throws(()=>prepareInitialReleaseRuntime({...options,expected:{...expected,assetSha256:forwardSha256(changedArchive)}}),/Bootstrap initial selection identity mismatch/);
        assert.deepEqual(readFileSync(prepared.journalFile),journal);
    } finally {rmSync(root,{recursive:true,force:true});}
});

test('forward name length and missing GitHub identity reject before output creation', () => {
    const root=temp(); const output=path.join(root,'absent');
    try {
        for(const override of [{version:'123456789012.47.0.3'},{releaseId:0}]) assert.throws(()=>buildReleaseAsset({profile:FORWARD_PROFILE_ID,
            version:'1.47.0.3',commit:'b'.repeat(40),repo:'AlKindy-OSS/nassaj',releaseId:41,outputDirectory:output,...override}));
        assert.equal(existsSync(output),false);
    } finally {rmSync(root,{recursive:true,force:true});}
});


test('root-only executable closure rejects missing, misplaced, symlinked and unbound dynamic code',()=>{
    const root=temp();
    try {
        const f=miniFixture(root);const wrapper=path.join(f.source,'scripts/release-runtime-forward-child.mjs');const bytes=readFileSync(wrapper);
        const closure=collectForwardExecutableClosure(f.source);assert.equal(closure.files.length,FORWARD_EXECUTABLE_ENTRIES.length+1);
        assert.equal(closure.files.some(file=>file.path.startsWith('dist-server/')),false);
        rmSync(wrapper);mkdirSync(path.join(f.runtime,'scripts'),{recursive:true});
        writeFileSync(path.join(f.runtime,'scripts/release-runtime-forward-child.mjs'),bytes);
        assert.throws(()=>collectForwardExecutableClosure(f.source),/ENOENT/);
        writeFileSync(wrapper,bytes);
        writeFileSync(wrapper,"export const load=()=>import(process.env.ENTRY);\n");
        assert.throws(()=>collectForwardExecutableClosure(f.source),/dynamic edge/);
        writeFileSync(wrapper,"export const load=()=>import('../server/scripts/release-database-migration.js');\n");
        assert.throws(()=>collectForwardExecutableClosure(f.source),/dynamic edge/);
        writeFileSync(wrapper,bytes);
        const nested=path.join(f.source,'scripts/lib/root-nested-fixture.mjs');rmSync(nested);
        symlinkSync(wrapper,nested);assert.throws(()=>collectForwardExecutableClosure(f.source),/placement/);rmSync(nested);
        assert.throws(()=>collectForwardExecutableClosure(f.source),/ENOENT/);
    }finally{rmSync(root,{recursive:true,force:true});}
});


test('root-only byte changes bind the archive independently of app buildId and stay out of default assets',()=>{
    const root=temp();
    try {
        const f=miniFixture(root);const target=currentReleaseRuntimeTarget();
        const options={sourceRoot:f.source,temporaryRoot:root,version:f.provenance.version,commit:f.provenance.commit,
            repo:'AlKindy-OSS/nassaj',releaseId:41,profile:FORWARD_PROFILE_ID};
        const injections={runtimeHost:HOST,buildTarget:target,runtimeTarget:target,runtimeRoots:()=>['@openai/codex-sdk','runtime-fixture'],runtimeSmoke:()=>{},
            observeForwardProfile:()=>({source:{schemaDigest:H('1'),compatibilityShapeDigest:H('2'),migrationStateDigest:H('3')},
                target:{schemaDigest:H('4'),compatibilityShapeDigest:H('5'),migrationStateDigest:H('6')}})};
        const first=buildReleaseAsset({...options,outputDirectory:path.join(root,'first')},injections);
        const nested=path.join(f.source,'scripts/lib/root-nested-fixture.mjs');
        writeFileSync(nested,'export const fixture=2;\n');
        const second=buildReleaseAsset({...options,outputDirectory:path.join(root,'second')},injections);
        assert.notEqual(first.assetSha256,second.assetSha256);
        assert.notEqual(forwardSha256(canonicalForward(first.forwardExecutableFiles)),forwardSha256(canonicalForward(second.forwardExecutableFiles)));
        assert.equal(JSON.parse(readFileSync(path.join(f.runtime,'BUILD_PROVENANCE.json'))).buildId,f.provenance.buildId);
        assert.throws(()=>buildReleaseAsset({...options,outputDirectory:path.join(root,'raced')},{...injections,copy:(source,destination,settings)=>{
            cpSync(source,destination,settings);if(source===path.join(f.source,'dist'))writeFileSync(nested,'export const fixture=3;\n');
        }}),/source changed/);
        rmSync(path.join(f.runtime,'STARTUP_CLOSURE.json'));
        const normal=buildReleaseAsset({...options,profile:'default',outputDirectory:path.join(root,'default')},{...injections,predecessorMatrix:{targetSchemaDigest:H('e'),acceptedPredecessors:[{schemaDigest:H('f'),compatibilityShapeDigest:H('a'),targetCompatibilityShapeDigest:H('b'),migrationStateDigest:H('c'),targetMigrationStateDigest:H('d')}]},runtimeSmoke:directory=>{
            assert.equal(existsSync(path.join(directory,'scripts')),false);assert.equal(existsSync(path.join(directory,'node_modules/amp-message')),false);
        }});
        assert.equal(normal.forwardExecutableFiles,undefined);
        assert.equal(normal.manifest.files.some(file=>file.path.startsWith('scripts/')),false);
    }finally{rmSync(root,{recursive:true,force:true});}
});


test('forward codec boundary refuses aliases/computed loads and vendor tampering without widening default dependencies',()=>{
    const root=temp();
    try {
        const f=miniFixture(root);const observer=path.join(f.source,'scripts/lib/pm2-readonly-observer.mjs');
        const source=readFileSync(path.join(ROOT,'scripts/lib/pm2-readonly-observer.mjs'),'utf8');writeFileSync(observer,source);
        writeFileSync(path.join(f.source,'scripts/lib/pm2-existing-transport.mjs'),readFileSync(path.join(ROOT,'scripts/lib/pm2-existing-transport.mjs')));
        writeFileSync(path.join(f.source,'scripts/lib/pm2-typed-mutation.mjs'),readFileSync(path.join(ROOT,'scripts/lib/pm2-typed-mutation.mjs')));
        writeFileSync(path.join(f.source,'scripts/lib/root-nested-fixture.mjs'),"export {observePinnedPm2Runtime} from './pm2-readonly-observer.mjs';\n");
        assert.ok(collectForwardExecutableClosure(f.source).files.some(file=>file.path.endsWith('pm2-readonly-observer.mjs')));
        for(const changed of [source.replace("require('../../node_modules/amp-message/index.js')","require(process.env.CODEC)"),
            source.replace("const require = createRequire(import.meta.url)","const require = createRequire('/untrusted')"),
            source.replace("const require = createRequire(import.meta.url)","const require = createRequire('/untrusted'); function decoy() { const require = createRequire(import.meta.url); }"),
            source + "\nfunction shadow(require) { return require('other'); }\n",
            source + "\nfunction shadowFactory(createRequire) { return createRequire('other'); }\n",
            source.replace("const require = createRequire(import.meta.url)","let require = createRequire(import.meta.url)"),
            source.replace("const Message = require('../../node_modules/amp-message/index.js')","const alternate = require; const Message = alternate('../../node_modules/amp-message/index.js')")]) {
            assert.notEqual(changed,source);writeFileSync(observer,changed);assert.throws(()=>collectForwardExecutableClosure(f.source),/codec|dynamic edge/);
        }
        writeFileSync(observer,source);
        const target=currentReleaseRuntimeTarget();let index=0;
        const options={sourceRoot:f.source,temporaryRoot:root,version:f.provenance.version,commit:f.provenance.commit,
            repo:'AlKindy-OSS/nassaj',releaseId:41,profile:FORWARD_PROFILE_ID};
        const vendor=path.join(f.source,'scripts/vendor/pm2-codec');const codec=path.join(vendor,'amp/index.js');const original=readFileSync(codec);
        const lock=readFileSync(path.join(f.source,'package-lock.json'));
        const sourceFiles=JSON.parse(readFileSync(path.join(vendor,'SOURCE_MANIFEST.json'))).files.map(record=>path.join(vendor,record.path));
        sourceFiles.forEach((file,index)=>chmodSync(file,index%2?0o555:0o444));
        const beforeSource=sourceFiles.map(file=>({bytes:readFileSync(file),mode:lstatSync(file).mode,mtime:lstatSync(file,{bigint:true}).mtimeNs,ctime:lstatSync(file,{bigint:true}).ctimeNs}));
        buildReleaseAsset({...options,outputDirectory:path.join(root,'readonly-source')},
            {runtimeHost:HOST,buildTarget:target,runtimeTarget:target,runtimeRoots:()=>['@openai/codex-sdk','runtime-fixture'],runtimeSmoke:()=>{},
                observeForwardProfile:()=>({source:{schemaDigest:H('1'),compatibilityShapeDigest:H('2'),migrationStateDigest:H('3')},
                    target:{schemaDigest:H('4'),compatibilityShapeDigest:H('5'),migrationStateDigest:H('6')}})});
        sourceFiles.forEach((file,index)=>assert.deepEqual({bytes:readFileSync(file),mode:lstatSync(file).mode,mtime:lstatSync(file,{bigint:true}).mtimeNs,ctime:lstatSync(file,{bigint:true}).ctimeNs},beforeSource[index]));
        sourceFiles.forEach(file=>chmodSync(file,0o644));

        for(const mutate of [()=>writeFileSync(codec,'tampered'),()=>rmSync(codec),()=>writeFileSync(path.join(vendor,'extra.js'),'extra')]) {
            mutate();assert.throws(()=>buildReleaseAsset({...options,outputDirectory:path.join(root,`bad-${index++}`)},
                {runtimeHost:HOST,buildTarget:target,runtimeTarget:target,runtimeRoots:()=>['@openai/codex-sdk','runtime-fixture']}),/codec/);
            writeFileSync(codec,original);rmSync(path.join(vendor,'extra.js'),{force:true});
        }
        assert.deepEqual(readFileSync(path.join(f.source,'package-lock.json')),lock);
    }finally{rmSync(root,{recursive:true,force:true});}
});


/** Reuse the exact development codec records introduced by the reviewed PM2 dependency. */
function codecDevelopmentFixture(root) {
    const f = miniFixture(root);
    const actualLock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json')));
    const lockFile = path.join(f.source, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockFile));
    for (const name of ['amp', 'amp-message']) {
        const key = `node_modules/${name}`;
        assert.equal(actualLock.packages[key].dev, true, 'regression must use the real development-only lock record');
        lock.packages[key] = structuredClone(actualLock.packages[key]);
    }
    writeFileSync(lockFile, JSON.stringify(lock));
    return { ...f, lock, lockFile };
}
function buildCodecDevelopmentFixture(f, root, runtimeSmoke = () => {}, runtimeRoots = ['runtime-fixture'], copy = cpSync) {
    const target = currentReleaseRuntimeTarget();
    return buildReleaseAsset({ sourceRoot: f.source, temporaryRoot: root, outputDirectory: path.join(root, 'output'),
        version: f.provenance.version, commit: f.provenance.commit, repo: 'AlKindy-OSS/nassaj', releaseId: 41, profile: FORWARD_PROFILE_ID },
    { runtimeHost: HOST, buildTarget: target, runtimeTarget: target, runtimeRoots: () => ['@openai/codex-sdk', ...runtimeRoots], runtimeSmoke, copy,
        observeForwardProfile: () => ({ source: { schemaDigest: H('1'), compatibilityShapeDigest: H('2'), migrationStateDigest: H('3') },
            target: { schemaDigest: H('4'), compatibilityShapeDigest: H('5'), migrationStateDigest: H('6') } }) });
}

test('forward codec accepts exact real development-only lock records without importing the development installation', () => {
    const root = temp();
    try {
        const f = codecDevelopmentFixture(root); const before = readFileSync(f.lockFile);
        const vendor = path.join(f.source, 'scripts/vendor/pm2-codec');
        const material = JSON.parse(readFileSync(path.join(vendor, 'SOURCE_MANIFEST.json')));
        // Development node_modules is deliberately unusable: only reviewed vendor bytes may enter the archive.
        for (const name of ['amp', 'amp-message']) {
            const directory = path.join(f.source, 'node_modules', name); mkdirSync(directory);
            writeFileSync(path.join(directory, 'package.json'), '{"name":"untrusted-development-copy"}');
            writeFileSync(path.join(directory, 'index.js'), 'throw Error("development codec must not run");');
        }
        let smokeCount = 0;
        const built = buildCodecDevelopmentFixture(f, root, staging => {
            const stagedLock = JSON.parse(readFileSync(path.join(staging, 'package-lock.json')));
            for (const item of material.packages) {
                const manifest = JSON.parse(readFileSync(path.join(vendor, item.name, 'package.json')));
                const dependencies = manifest.dependencies || {};
                assert.deepEqual(stagedLock.packages[`node_modules/${item.name}`], { version: item.version,
                    resolved: item.url, integrity: item.integrity, ...(Object.keys(dependencies).length ? { dependencies } : {}) });
            }
            for (const record of material.files) assert.deepEqual(readFileSync(path.join(staging, 'node_modules', record.path)),
                readFileSync(path.join(vendor, record.path)), record.path);
            assert.equal(existsSync(path.join(staging, 'node_modules/pm2')), false);
            const codec = spawnSync(process.execPath, ['--input-type=commonjs', '-e',
                "const assert=require('node:assert/strict'); const Message=require('./node_modules/amp-message'); const value=['fixture',{count:2}]; assert.deepEqual(new Message(new Message(value).toBuffer()).args,value);"], { cwd: staging, encoding: 'utf8' });
            assert.equal(codec.status, 0, codec.stderr);
            smokeCount++;
        });
        assert.equal(smokeCount, 1); assert.deepEqual(readFileSync(f.lockFile), before);
        assert.deepEqual(built.manifest.runtimeClosure.packages.filter(item => ['amp', 'amp-message'].includes(item.name)).map(item => item.name).sort(), ['amp', 'amp-message']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('forward codec development lock compatibility rejects every identity or dependency widening', async t => {
    const mutations = {
        version: entry => entry.version = '9.9.9',
        resolved: entry => entry.resolved = 'https://registry.example/other.tgz',
        integrity: entry => entry.integrity = 'sha512-YQ==',
        dependencies: entry => entry.dependencies = { amp: '*' },
        emptyDependencies: entry => entry.dependencies = {},
        optional: entry => entry.optional = true,
        numericDev: entry => entry.dev = 1,
        runtime: entry => entry.dev = false,
        missingDev: entry => delete entry.dev,
        license: entry => entry.license = 'Unreviewed',
        extraField: entry => entry.unreviewed = true,
        linked: entry => entry.link = true,
    };
    for (const name of ['amp', 'amp-message']) for (const [label, mutate] of Object.entries(mutations)) await t.test(`${name}: ${label}`, () => {
        const root = temp();
        try {
            const f = codecDevelopmentFixture(root); mutate(f.lock.packages[`node_modules/${name}`]);
            writeFileSync(f.lockFile, JSON.stringify(f.lock)); const before = readFileSync(f.lockFile);
            assert.throws(() => buildCodecDevelopmentFixture(f, root), /Forward codec/);
            assert.deepEqual(readFileSync(f.lockFile), before);
            assert.equal(existsSync(path.join(root, 'output', 'RELEASE_ASSET_MANIFEST.forward.json')), false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

test('forward codec rejects present non-object lock records and occupied staging paths', async t => {
    for (const value of [null, false]) await t.test(`present lock entry: ${value}`, () => {
        const root = temp();
        try {
            const f = codecDevelopmentFixture(root); f.lock.packages['node_modules/amp'] = value;
            writeFileSync(f.lockFile, JSON.stringify(f.lock));
            assert.throws(() => buildCodecDevelopmentFixture(f, root), /Forward codec package collision/);
            assert.equal(existsSync(path.join(root, 'output', 'RELEASE_ASSET_MANIFEST.forward.json')), false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    for (const kind of ['empty-directory', 'dangling-link']) await t.test(`staging collision: ${kind}`, () => {
        const root = temp(); let injected = false;
        try {
            const f = codecDevelopmentFixture(root);
            const copy = (source, destination, options) => {
                cpSync(source, destination, options);
                if (source !== f.lockFile) return;
                const occupied = path.join(path.dirname(destination), 'node_modules/amp');
                if (kind === 'empty-directory') mkdirSync(occupied);
                else symlinkSync(path.join(root, 'absent-codec'), occupied);
                injected = true;
            };
            assert.throws(() => buildCodecDevelopmentFixture(f, root, () => {}, ['runtime-fixture'], copy), /Forward codec package collision/);
            assert.equal(injected, true, 'collision belongs to staging, not the runtime closure');
            assert.equal(existsSync(path.join(root, 'output', 'RELEASE_ASSET_MANIFEST.forward.json')), false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

test('forward codec development lock does not permit a real runtime package collision or changed vendor source', async t => {
    for (const name of ['amp', 'amp-message']) await t.test(`runtime collision: ${name}`, () => {
        const root = temp();
        try {
            const f = codecDevelopmentFixture(root);
            for (const codec of ['amp', 'amp-message']) cpSync(path.join(f.source, 'scripts/vendor/pm2-codec', codec), path.join(f.source, 'node_modules', codec), { recursive: true });
            // The package is in the actual runtime graph even if its source lock incorrectly labels it development-only.
            assert.throws(() => buildCodecDevelopmentFixture(f, root, () => {}, ['runtime-fixture', name]), /collision|EEXIST/);
            assert.equal(existsSync(path.join(root, 'output', 'RELEASE_ASSET_MANIFEST.forward.json')), false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    for (const file of ['SOURCE_MANIFEST.json', 'amp/index.js', 'amp-message/package.json']) await t.test(`vendor mutation: ${file}`, () => {
        const root = temp();
        try {
            const f = codecDevelopmentFixture(root); const source = path.join(f.source, 'scripts/vendor/pm2-codec', file);
            writeFileSync(source, readFileSync(source, 'utf8') + '\n');
            assert.throws(() => buildCodecDevelopmentFixture(f, root), /Forward codec/);
            assert.equal(existsSync(path.join(root, 'output', 'RELEASE_ASSET_MANIFEST.forward.json')), false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});


import { SERVER_BUILD_INPUTS, computeServerBuildFingerprint, createServerInputManifest } from './server-build-atomic.mjs';
test('each pure admission source independently changes server fingerprint and manifest and remains covered by installed bundle',()=>{
    const root=temp();
    try {
        const source=path.join(root,'fingerprint-source');mkdirSync(source);
        for(const entry of SERVER_BUILD_INPUTS) {
            const file=path.join(source,entry);mkdirSync(path.dirname(file),{recursive:true});
            if(entry==='server'||entry==='shared')mkdirSync(file,{recursive:true});else writeFileSync(file,'// fixture\n');
        }
        const baseline=computeServerBuildFingerprint(source);
        const before=createServerInputManifest(source);
        for(const entry of ['scripts/lib/release-runtime-startup-admission.mjs','scripts/lib/release-runtime-managed-admission.mjs','scripts/lib/local-reviewed-build-identity.mjs']) {
            assert.ok(SERVER_BUILD_INPUTS.includes(entry));const file=path.join(source,entry);const original=readFileSync(file);
            writeFileSync(file,'// independently changed\n');const after=createServerInputManifest(source);
            assert.notEqual(computeServerBuildFingerprint(source),baseline);assert.notEqual(after.buildId,before.buildId);
            assert.notEqual(after.inputs.find(item=>item.path===entry).sha256,before.inputs.find(item=>item.path===entry).sha256);
            writeFileSync(file,original);
        }
        mkdirSync(path.join(root,'runtime'));const installed=installUpdateRuntimeBundle(ROOT,path.join(root,'runtime'));
        for(const entry of ['scripts/lib/release-runtime-startup-admission.mjs','scripts/lib/release-runtime-managed-admission.mjs','scripts/lib/local-reviewed-build-identity.mjs'])
            assert.ok(installed.manifest.files.some(file=>file.path===entry));
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('forward tar ships actual safe script and fixed managed/first-forward helper roots without dist-server fallback',()=>{
    const root=temp();
    try {
        const f=miniFixture(root);const target=currentReleaseRuntimeTarget();
        const client=path.join(f.source,'scripts/managed-safe-restart-client.mjs');
        writeFileSync(client,"import {emit} from './lib/managed-boundary-fixture.mjs'; emit('managed');\n");
        writeFileSync(path.join(f.source,'scripts/lib/managed-boundary-fixture.mjs'),"export const emit=lane=>console.log(JSON.stringify({lane,args:process.argv.slice(2)}));\n");
        writeFileSync(path.join(f.source,'scripts/release-runtime-forward-parent.mjs'),"import {emit} from './lib/managed-boundary-fixture.mjs'; emit('forward');\n");
        let smokes=0;
        const built=buildReleaseAsset({sourceRoot:f.source,temporaryRoot:root,version:f.provenance.version,commit:f.provenance.commit,
            repo:'AlKindy-OSS/nassaj',releaseId:41,profile:FORWARD_PROFILE_ID,outputDirectory:path.join(root,'out')},
        {runtimeHost:HOST,buildTarget:target,runtimeTarget:target,runtimeRoots:()=>['@openai/codex-sdk','runtime-fixture'],
            observeForwardProfile:()=>({source:{schemaDigest:H('1'),compatibilityShapeDigest:H('2'),migrationStateDigest:H('3')},
                target:{schemaDigest:H('4'),compatibilityShapeDigest:H('5'),migrationStateDigest:H('6')}}),
            runtimeSmoke:directory=>{
                const script=path.join(directory,'scripts/safe-restart.sh');
                assert.deepEqual(readFileSync(script),readFileSync(path.join(ROOT,'scripts/safe-restart.sh')));
                for(const [args,lane] of [[['--managed-operation','fixture-operation-1234'],'managed'],[['--first-forward-phase','stop','--operation','fixture-operation-1234'],'forward']]) {
                    const child=spawnSync('/bin/bash',[script,...args],{cwd:directory,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
                    assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).lane,lane);smokes++;
                }
                const extractedClient=path.join(directory,'scripts/managed-safe-restart-client.mjs');const bytes=readFileSync(extractedClient);
                rmSync(extractedClient);
                const refused=spawnSync('/bin/bash',[script,'--managed-operation','fixture-operation-1234'],{cwd:directory,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
                assert.notEqual(refused.status,0);writeFileSync(extractedClient,bytes);
            }});
        assert.equal(smokes,2);
        for(const file of ['scripts/safe-restart.sh','scripts/managed-safe-restart-client.mjs','scripts/lib/managed-boundary-fixture.mjs'])
            assert.deepEqual(built.forwardExecutableFiles.find(item=>item.path===file),built.manifest.files.find(item=>item.path===file));
        rmSync(client);assert.throws(()=>collectForwardExecutableClosure(f.source),/ENOENT/);
    } finally {rmSync(root,{recursive:true,force:true});}
});

import { LOCAL_BUILD_KIND, localBuildIdentitySha256, validateLocalBuildCore, validateLocalPreparedArtifact } from './lib/local-reviewed-build-identity.mjs';
import { fixture as admissionFixture } from './fixtures/startup-admission-fixture.mjs';
import { sign } from 'node:crypto';
import { prepareForwardStartupAuthority } from './lib/release-runtime-public-descriptor.mjs';
test('explicit local build and preparation use no GitHub identity or network, and bind exact archive/core',t=>{
    const root=temp(); const fetchBefore=globalThis.fetch; let network=0;
    globalThis.fetch=()=>{network++;throw Error('network forbidden');};
    try {
        const f=miniFixture(root);
        writeFileSync(path.join(f.runtime,'SERVER_INPUT_MANIFEST.json'),JSON.stringify({commit:f.provenance.commit,buildId:f.provenance.buildId}));
        const target=currentReleaseRuntimeTarget();
        const options={kind:LOCAL_BUILD_KIND,projectId:'nassaj-dev',sourceRoot:f.source,temporaryRoot:root,
            version:f.provenance.version,commit:f.provenance.commit,profile:FORWARD_PROFILE_ID,outputDirectory:path.join(root,'local')};
        const localInjections={verifyLocalServerCandidate:()=>{},verifyLocalClientCandidate:()=>{},runtimeHost:HOST,buildTarget:target,runtimeTarget:target,
            runtimeRoots:()=>['@openai/codex-sdk','runtime-fixture'],runtimeSmoke:()=>{},observeForwardProfile:()=>({
                source:{schemaDigest:H('1'),compatibilityShapeDigest:H('2'),migrationStateDigest:H('3')},
                target:{schemaDigest:H('4'),compatibilityShapeDigest:H('5'),migrationStateDigest:H('6')}})};
        const result=buildReleaseAsset(options,localInjections);
        const expected={kind:LOCAL_BUILD_KIND,build:result.manifest.build,artifact:result.preparedArtifact};
        assert.equal(result.manifest.schema,'nassaj-local-build-manifest/v1');
        assert.equal(result.manifest.databaseContract.releaseIdentitySha256,localBuildIdentitySha256(expected.build));
        validateLocalPreparedArtifact(expected.artifact,expected.build);
        for(const key of ['releaseId','repo','tag','assetId','detachedManifestId']) assert.equal(Object.hasOwn(result.manifest,key),false);
        for(const key of ['releaseId','repo','tag','unknown']) assert.throws(()=>validateLocalBuildCore({...expected.build,[key]:1}),/identity/);
        assert.throws(()=>validateReleaseAssetManifest({...result.manifest,releaseId:1},expected,{runtimeTarget:target}),/header/);
        assert.throws(()=>validateReleaseAssetManifest(result.manifest,{},{runtimeTarget:target}),/kind/);
        assert.throws(()=>validateReleaseAssetManifest(result.manifest,{...expected,build:{...expected.build,projectId:'other'}},{runtimeTarget:target}),/header/);
        const bootstrap={kind:LOCAL_BUILD_KIND,profile:'forward',deployRoot:path.join(root,'deploy'),
            assetFile:result.asset,manifestFile:result.publishedManifest,nodeInstanceId:'fixture-local',expected,runtimeHost:HOST};
        const prepared=prepareInitialReleaseRuntime(bootstrap);
        assert.equal(prepared.generationId,`local-forward-${result.assetSha256}`);
        assert.equal(prepareInitialReleaseRuntime(bootstrap).generationId,prepared.generationId);
        assert.equal(inspectSealedRelease({deployRoot:bootstrap.deployRoot,nodeInstanceId:bootstrap.nodeInstanceId,host:HOST}).generationId,prepared.generationId);
        assert.throws(()=>prepareInitialReleaseRuntime({...bootstrap,expected:{...expected,artifact:{...expected.artifact,archiveSha256:H('a')}}}),/bytes/);
        assert.throws(()=>prepareInitialReleaseRuntime({...bootstrap,kind:undefined}),/kind/);
        writeFileSync(path.join(f.source,'scripts/lib/root-nested-fixture.mjs'),'export const fixture=2;\n');
        const changedArchive=buildReleaseAsset({...options,outputDirectory:path.join(root,'local-second')},localInjections);
        assert.notEqual(changedArchive.assetSha256,result.assetSha256);
        assert.throws(()=>prepareInitialReleaseRuntime({...bootstrap,assetFile:changedArchive.asset,manifestFile:changedArchive.publishedManifest,
            expected:{kind:LOCAL_BUILD_KIND,build:changedArchive.manifest.build,artifact:changedArchive.preparedArtifact}}),/Bootstrap initial selection identity mismatch/);
        const sealedRoot=path.join(bootstrap.deployRoot,'releases',prepared.generationId);
        const sealedManifestPath=path.join(sealedRoot,'RELEASE_ASSET_MANIFEST.json'),sealedRecordPath=path.join(sealedRoot,'runtime-generation.json');
        const originalManifestBytes=readFileSync(sealedManifestPath),originalRecordBytes=readFileSync(sealedRecordPath);
        for(const change of [b=>{b.repo='fake/repo';},b=>{b.kind='github';},b=>{delete b.kind;},b=>{b.profileId='other';},b=>{b.commit='bad';}]) {
            const changed=JSON.parse(originalManifestBytes),record=JSON.parse(originalRecordBytes);change(changed.build);
            assert.throws(()=>validateLocalBuildCore(changed.build));
            record.identity.build=changed.build;const altered=Buffer.from(JSON.stringify(changed));
            record.identity.artifact.buildIdentitySha256=forwardSha256(canonicalForward(changed.build));
            record.identity.artifact.manifestSha256=forwardSha256(altered);record.identity.artifact.manifestSize=altered.length;
            record.activationIdentitySha256=forwardSha256(canonicalForward(record.identity));
            writeFileSync(sealedManifestPath,altered);writeFileSync(sealedRecordPath,JSON.stringify(record));
            assert.throws(()=>inspectSealedRelease({deployRoot:bootstrap.deployRoot,nodeInstanceId:bootstrap.nodeInstanceId,host:HOST}),/Local launcher/);
        }
        writeFileSync(sealedManifestPath,originalManifestBytes);writeFileSync(sealedRecordPath,originalRecordBytes);
        const authority=admissionFixture(t,'cutover');
        const mutex=installFixedStateMutexAuthority(t,authority.root,authority.config);
        authority.deps.effectiveUid=()=>authority.deps.ownerUid;
        // B-920: preserve the fixture identity while canonicalizing mapped group membership.
        authority.config.forwardMigration.serviceIdentity.supplementaryGids=[...new Set(authority.config.forwardMigration.serviceIdentity.supplementaryGids)];
        const identity=authority.identity, config=authority.config;
        const database=path.join(authority.root,'database.sqlite');writeFileSync(database,'fixture');
        const dbInfo=lstatSync(database,{bigint:true});
        Object.assign(identity,{generationId:prepared.generationId,releaseIdentitySha256:localBuildIdentitySha256(expected.build),
            databaseContractSha256:expected.artifact.databaseContractSha256,startupClosureSha256:expected.artifact.startupClosureSha256,
            databaseDev:String(dbInfo.dev),databaseIno:String(dbInfo.ino)});
        Object.assign(config.expected,{artifactPolicy:LOCAL_BUILD_KIND,localBuild:expected.build,localArtifact:expected.artifact,
            generationId:identity.generationId,releaseIdentitySha256:identity.releaseIdentitySha256,
            databaseContractSha256:identity.databaseContractSha256,assetSha256:expected.artifact.archiveSha256,
            serverBuildId:expected.build.serverBuildId,clientBuildId:expected.build.clientBuildId,
            targetSchemaDigest:result.manifest.databaseContract.target.schemaDigest});
        config.databaseFile=database;
        writeFileSync(config.bootstrapClaim.releaseManifestFile,readFileSync(result.publishedManifest));
        config.bootstrapClaim.releaseManifestSha256=forwardSha256(readFileSync(config.bootstrapClaim.releaseManifestFile));
        const approval=authority.read('approval.json');delete approval.signature;
        approval.expectedSha256=forwardSha256(canonicalForward(config.expected));approval.startupAdmission=identity;
        const signed={...approval,signature:sign(null,Buffer.from(canonicalForward(approval)),authority.keys.privateKey).toString('base64url')};
        authority.write('approval.json',signed);
        const journal=authority.read('first-cutover.json');journal.expected=config.expected;journal.approvalSha256=forwardSha256(canonicalForward(signed));
        Object.assign(journal.forwardReceipts.schema,{releaseIdentitySha256:identity.releaseIdentitySha256,
            databaseContractSha256:identity.databaseContractSha256,databaseDev:identity.databaseDev,databaseIno:identity.databaseIno,
            targetSchemaDigest:config.expected.targetSchemaDigest});authority.write('first-cutover.json',journal);
        const state=authority.read('startup-admission.json');state.identity=identity;state.approvalSha256=journal.approvalSha256;authority.write('startup-admission.json',state);
        const host=authority.read('host-dispatch-state.json');
        host.gateInstallIntent.identitySeal=forwardSha256(JSON.stringify(['nodeInstanceId','hostIdentitySha256','releaseIdentitySha256','migrationIdentitySha256','pm2SnapshotSha256','databaseContractSha256','assetSha256'].map(key=>[key,config.expected[key]])));
        config.stateLock={schema:'nassaj-cutover-state-lock/v2',flock:{path:'/usr/bin/flock',sha256:forwardSha256(readFileSync('/usr/bin/flock'))}};
        // The release manifest was replaced with the published one, so re-attest the installation.
        mutex.write(config);
        authority.write('host-dispatch-state.json',host);authority.write('reviewed.json',config);
        const generationFile=path.join(bootstrap.deployRoot,'releases',prepared.generationId,'runtime-generation.json');
        const executable=process.execPath, executableSha=forwardSha256(readFileSync(executable));
        const descriptor=prepareForwardStartupAuthority({reviewedHostConfigFile:path.join(authority.root,'reviewed.json'),
            reviewedHostConfigSha256:forwardSha256(readFileSync(path.join(authority.root,'reviewed.json'))),
            releaseManifestFile:config.bootstrapClaim.releaseManifestFile,releaseManifestSha256:config.bootstrapClaim.releaseManifestSha256,
            generationRecordFile:generationFile,generationRecordSha256:forwardSha256(readFileSync(generationFile)),
            startupClosureSha256:identity.startupClosureSha256,applicationUid:1000,
            approvalFile:config.bootstrapClaim.approvalFile,ownerApprovalPublicKeyFile:config.bootstrapClaim.ownerApprovalPublicKeyFile,
            dispatcherExecutable:executable,dispatcherSha256:executableSha,sudoExecutable:executable,sudoSha256:executableSha,
            nodeExecutable:executable,nodeSha256:executableSha},{effectiveUid:()=>0,readRootBytes:file=>readFileSync(file)});
        assert.equal(JSON.parse(descriptor.publicDescriptor).schema,'nassaj-startup-admission-client/v2');
        assert.deepEqual(JSON.parse(descriptor.publicDescriptor).artifact,{...expected.artifact,build:expected.build});
        const request={...authority.request(),releaseIdentitySha256:identity.releaseIdentitySha256,startupClosureSha256:identity.startupClosureSha256};
        const originalExpected=structuredClone(config.expected), originalJournal=authority.read('first-cutover.json'), originalState=authority.read('startup-admission.json');
        for (const change of [value=>{value.localBuild.projectId='other-project';},value=>{value.localBuild.commit='c'.repeat(40);},
            value=>{value.localBuild.profileId='unreviewed';},value=>{value.localArtifact.archiveSha256=H('c');},
            value=>{delete value.artifactPolicy;},value=>{value.localBuild.releaseId=1;}]) {
            config.expected=structuredClone(originalExpected);change(config.expected);
            const different={...approval,expectedSha256:forwardSha256(canonicalForward(config.expected))};
            const differentSigned={...different,signature:sign(null,Buffer.from(canonicalForward(different)),authority.keys.privateKey).toString('base64url')};
            authority.write('approval.json',differentSigned);
            const differentSha=forwardSha256(canonicalForward(differentSigned));
            authority.write('first-cutover.json',{...originalJournal,expected:config.expected,approvalSha256:differentSha});
            authority.write('startup-admission.json',{...originalState,approvalSha256:differentSha});
            assert.throws(()=>authority.call(request));assert.equal(authority.read('startup-admission.json').lastClaim,null);
        }
        config.expected=originalExpected;authority.write('approval.json',signed);authority.write('first-cutover.json',originalJournal);authority.write('startup-admission.json',originalState);
        const offer=authority.call(request);
        const claim=authority.call({...authority.consume(offer),releaseIdentitySha256:identity.releaseIdentitySha256,startupClosureSha256:identity.startupClosureSha256});
        assert.equal(claim.decision,'claimed');assert.equal(claim.generationId,prepared.generationId);
        assert.equal(network,0);
    } finally {globalThis.fetch=fetchBefore;rmSync(root,{recursive:true,force:true});}
});
