/** Measured installation material for explicit root-filesystem test seams; never a production authority bypass. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectUpdateRuntimeClosure } from '../lib/update-runtime-bundle.mjs';

export const FIXTURE_OPERATOR_ROOT = '/usr/local/lib/nassaj-release-operator';
export const FIXTURE_DISPATCHER = `${FIXTURE_OPERATOR_ROOT}/scripts/release-runtime-host-dispatcher.mjs`;
export const FIXTURE_ATTESTATION = '/etc/nassaj/release-host-support-attestation.json';
export const FIXTURE_PUBLIC = '/etc/nassaj/startup-admission-client.json';
const project = path.resolve(import.meta.dirname, '../..');
const roots = ['scripts/nassaj-maintenance-responder.mjs', 'scripts/release-runtime-host-dispatcher.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Rewriting identical bytes still moves mtime/ctime, and the installed-config reader compares those
 * across its own stability window. A second process installing the same authority must therefore
 * leave untouched anything it did not actually change.
 */
export function writeMeasuredFile(file, bytes, mode) {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(value) && (fs.statSync(file).mode & 0o777) === mode) return;
    fs.writeFileSync(file, value, { mode }); fs.chmodSync(file, mode);
}

function ensureFixtureDirectory(root, directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    for (let current = directory; ; current = path.dirname(current)) {
        const info = fs.lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022)) throw Error('fixture_support_directory_unsafe');
        if (current === root) return;
    }
}

/** Copy the actual root closure and native semver bytes into a private fixture installation. */
export function stageFixtureInstalledSupport(root, dispatcherSource) {
    const directory = path.join(root, 'installed-support'); ensureFixtureDirectory(root, directory);
    const sources = collectUpdateRuntimeClosure(project, roots);
    const walk = relative => {
        for (const entry of fs.readdirSync(path.join(project, relative), { withFileTypes: true })) {
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory()) walk(child); else if (entry.isFile()) sources.push(child); else throw Error('fixture_support_symlink');
        }
    };
    walk('node_modules/semver'); sources.push('package.json');
    const records = sources.sort().map(relative => {
        const bytes = relative === 'package.json' ? Buffer.from('{"type":"module","private":true}\n')
            : fs.readFileSync(relative === roots[1] && dispatcherSource ? dispatcherSource : path.join(project, relative));
        const file = path.join(directory, relative), mode = roots.includes(relative) ? 0o555 : 0o444;
        ensureFixtureDirectory(root, path.dirname(file));
        // A caller-supplied dispatcher is an intentional restage of an endpoint the test rewrote;
        // every other file must still be byte-identical across restages of the same root.
        const replaceable = relative === roots[1] && Boolean(dispatcherSource);
        if (fs.existsSync(file)) {
            if (!fs.readFileSync(file).equals(bytes) || (fs.statSync(file).mode & 0o777) !== mode) {
                if (!replaceable) throw Error('fixture_installed_source_drift');
                fs.chmodSync(file, 0o600); fs.writeFileSync(file, bytes); fs.chmodSync(file, mode);
            }
        } else { fs.writeFileSync(file, bytes, { flag: 'wx', mode }); fs.chmodSync(file, mode); }
        return { relative, path: `${FIXTURE_OPERATOR_ROOT}/${relative}`, mode, size: bytes.length, sha256: sha(bytes) };
    });
    return { directory, records, dispatcher: { path: FIXTURE_DISPATCHER, sha256: records.find(record => record.relative === roots[1]).sha256 } };
}

/** Pin the final fixture config and descriptor only after their final paths and signatures have been prepared. */
export function attestFixtureInstalledConfig(root, support, configFile, descriptorFile) {
    const configBytes = fs.readFileSync(configFile), config = JSON.parse(configBytes);
    const descriptorBytes = fs.readFileSync(descriptorFile), manifestBytes = fs.readFileSync(config.bootstrapClaim.releaseManifestFile);
    const sourceSetSha256 = sha(support.records.map(file => `${file.relative}\0${file.mode}\0${file.size}\0${file.sha256}\n`).join(''));
    const evidence = Buffer.from(JSON.stringify({ fixture: 'measured-installed-source', files: support.records }));
    const installerManifest = { size: evidence.length, sha256: sha(evidence) };
    const record = { schema: 'nassaj-release-host-support-attestation/v2', profile: 'forward', phase: 'configuration_attested',
        installerArchive: installerManifest, installerManifest, runtimeManifest: { size: manifestBytes.length, sha256: sha(manifestBytes) },
        sourceSetSha256, files: support.records, effectiveUnitSha256: sha('fixture-effective-unit'), effectiveUnitSize: 22,
        configHandoff: { ready: true, files: [
            { path: '/etc/nassaj/release-runtime-host.json', mode: 0o600, size: configBytes.length, sha256: sha(configBytes) },
            { path: FIXTURE_PUBLIC, mode: 0o644, size: descriptorBytes.length, sha256: sha(descriptorBytes) },
        ] } };
    writeMeasuredFile(path.join(root, 'installed-source-evidence.json'), evidence, 0o600);
    writeMeasuredFile(path.join(root, 'release-host-support-attestation.json'), JSON.stringify(record), 0o600);
    return record;
}
