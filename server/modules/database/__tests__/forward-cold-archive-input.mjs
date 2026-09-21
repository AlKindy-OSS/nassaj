/** Test-only external archive binding and dependency boundary for the B899 cold fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RELEASE_ASSET_LIMITS, inspectTarGz, verifyExtractedReleaseAsset } from '../../../../scripts/lib/update-release-asset.mjs';
import { validateLocalPreparedArtifact } from '../../../../scripts/lib/local-reviewed-build-identity.mjs';
import {forwardValueSha256} from '../../../../scripts/lib/release-runtime-forward-child-protocol.mjs';

const exact = (value, keys) => assert.equal(Object.keys(value || {}).sort().join(','), keys);
const same = (a, b) => ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(key => a[key] === b[key]);

/** Consume the external test request from one stable bounded descriptor, never from a candidate module. */
export function readColdArchiveRequest(file) {
    assert.equal(fs.realpathSync(file),file);
    const before=fs.lstatSync(file);
    assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&!(before.mode&0o022)&&before.size>0&&before.size<=65536);
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
        assert.ok(same(before,fs.fstatSync(fd)));
        const bytes=Buffer.alloc(before.size+1);let size=0,count;
        while((count=fs.readSync(fd,bytes,size,bytes.length-size,null)))size+=count;
        assert.equal(size,before.size);assert.ok(same(before,fs.fstatSync(fd))&&same(before,fs.lstatSync(file)));
        return JSON.parse(bytes.subarray(0,size));
    } finally {fs.closeSync(fd);}
}

/** Read/hash one bounded stable FD; retain bytes only when the existing tar inspector needs them. */
function readPinned(pin, maximum, retain = false) {
    exact(pin, 'path,sha256,size');
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= maximum);
    assert.equal(fs.realpathSync(pin.path), pin.path);
    const before = fs.lstatSync(pin.path);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && !(before.mode & 0o022));
    assert.equal(before.size, pin.size);
    const fd = fs.openSync(pin.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        assert.ok(same(before, fs.fstatSync(fd)));
        const hash = createHash('sha256'), chunks = [], buffer = Buffer.alloc(65536);
        let total = 0, count;
        while ((count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, pin.size + 1 - total), null))) {
            total += count; assert.ok(total <= pin.size); hash.update(buffer.subarray(0, count));
            if (retain) chunks.push(Buffer.from(buffer.subarray(0, count)));
        }
        assert.equal(total, pin.size); assert.equal(hash.digest('hex'), pin.sha256);
        assert.ok(same(before, fs.fstatSync(fd)) && same(before, fs.lstatSync(pin.path)));
        return { info: before, bytes: retain ? Buffer.concat(chunks) : null };
    } finally { fs.closeSync(fd); }
}

/** Require externally pinned local material before any candidate module is imported. */
export function verifyColdArchiveInput(input) {
    exact(input, 'archive,expected,extractedRoot,manifest');
    exact(input.expected, 'artifact,build,kind');
    assert.equal(input.expected.kind, 'owner-reviewed-local-build/v1');
    assert.equal(fs.realpathSync(input.extractedRoot), input.extractedRoot);
    const mounts = fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>line.split(' '));
    const mount = mounts.filter(row=>input.extractedRoot===row[4]||input.extractedRoot.startsWith(row[4]==='/'?'/':row[4]+'/')).sort((a,b)=>b[4].length-a[4].length)[0];
    assert.ok(mount?.[5].split(',').includes('ro'), 'cold archive extraction must be read-only');
    const archive = readPinned(input.archive, RELEASE_ASSET_LIMITS.archiveBytes, true);
    const manifest = readPinned(input.manifest, RELEASE_ASSET_LIMITS.manifestBytes, true);
    const archived = inspectTarGz(archive.bytes);
    const archivedManifest = archived.entries.find(entry => entry.name === 'RELEASE_ASSET_MANIFEST.json');
    assert.equal(archivedManifest?.type, 'file'); assert.equal(archivedManifest.mode, 0o644);
    assert.deepEqual(archived.tar.subarray(archivedManifest.contentOffset,
        archivedManifest.contentOffset + archivedManifest.size), manifest.bytes);
    const archivedFiles = archived.entries.filter(entry => entry.type === 'file' && entry !== archivedManifest)
        .map(entry => ({path:entry.name,mode:entry.mode,size:entry.size,sha256:entry.sha256}))
        .sort((a,b)=>a.path<b.path?-1:1);
    assert.deepEqual(archivedFiles, JSON.parse(manifest.bytes).files);
    const artifact = validateLocalPreparedArtifact(input.expected.artifact,input.expected.build);
    assert.equal(artifact.archiveSha256, input.archive.sha256); assert.equal(artifact.archiveSize, input.archive.size);
    assert.equal(artifact.manifestSha256, input.manifest.sha256); assert.equal(artifact.manifestSize, input.manifest.size);
    const embedded = readPinned({ path: path.join(input.extractedRoot, 'RELEASE_ASSET_MANIFEST.json'),
        sha256: input.manifest.sha256, size: input.manifest.size }, RELEASE_ASSET_LIMITS.manifestBytes, true);
    assert.deepEqual(embedded.bytes, manifest.bytes);
    const verified = verifyExtractedReleaseAsset(input.extractedRoot, input.expected,
        { expectedStartupClosureSha256: artifact.startupClosureSha256 });
    assert.equal(forwardValueSha256(verified.manifest.databaseContract),artifact.databaseContractSha256);
    // The core extraction verifier already checks the pinned startup material and the exact forward roots.
    const record=verified.manifest.files.find(row=>row.path==='dist-server/STARTUP_CLOSURE.json');
    const startup=JSON.parse(readPinned({path:path.join(input.extractedRoot,record.path),size:record.size,sha256:record.sha256},
        RELEASE_ASSET_LIMITS.manifestBytes,true).bytes);
    return { input, archive: archive.info, manifestBytes: manifest.bytes, manifest: verified.manifest,
        material: startup.material || startup, artifact, build: input.expected.build };
}

/** Register the same restriction in the verifier process and generated application child. */
export function restrictColdArchiveImports(root) {
    const inside = url => typeof url === 'string' && url.startsWith('file:')
        && (fileURLToPath(url) === root || fileURLToPath(url).startsWith(root + path.sep));
    return registerHooks({ resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        if (inside(context.parentURL) && !result.url.startsWith('node:') && !inside(result.url)) {
            throw Error('cold_archive_dependency_escape');
        }
        return result;
    } });
}

/** Remove inherited Git authority before creating or using the isolated repository. */
export function coldGitEnvironment(root) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    return {...env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
        GIT_DIR:path.join(root,'.git'), GIT_WORK_TREE:root};
}

/** Positively establish worktree/root/common-dir before fixture or application writers run. */
export function assertColdGitFixture(root) {
    assert.equal(fs.realpathSync(root), root);
    const metadata=fs.lstatSync(path.join(root,'.git'));
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
    const env=coldGitEnvironment(root);
    for(const [argument,expected] of [['--show-toplevel',root],['--absolute-git-dir',path.join(root,'.git')],['--git-common-dir',path.join(root,'.git')]]) {
        const result=spawnSync('/usr/bin/git',['rev-parse','--path-format=absolute',argument],
            {cwd:root,env,encoding:'utf8',timeout:5000});
        assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),expected);
    }
    return env;
}
