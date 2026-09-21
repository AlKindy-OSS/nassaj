#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildServerReleaseCandidate } from './server-build-atomic.mjs';

const ENTRY_RELATIVE = 'server/scripts/release-database-migration.js';

function assertRealDirectory(directory, label) {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

function verifyIdentity(runtimeRoot, expected) {
    assertRealDirectory(runtimeRoot, 'Release script test runtime');
    if (!existsSync(path.join(runtimeRoot, ENTRY_RELATIVE))) {
        throw new Error(`Release script test runtime is missing ${ENTRY_RELATIVE}.`);
    }
    const provenance = JSON.parse(readFileSync(path.join(runtimeRoot, 'BUILD_PROVENANCE.json'), 'utf8'));
    if (provenance.artifact !== 'server' || provenance.commit !== expected.commit
        || provenance.baseCommit !== expected.commit || provenance.version !== expected.version
        || provenance.dirty !== false) throw new Error('Release script test runtime provenance mismatch.');
}

/** Rename a verified candidate without copy or replacement semantics. */
export function moveCandidateNoClobber(source, target, injected = {}) {
    const run = injected.run || spawnSync;
    const help = run('/usr/bin/mv', ['--help'], { encoding: 'utf8' });
    if (help.status !== 0 || !help.stdout?.includes('--no-copy') || !help.stdout.includes('--no-clobber')) {
        throw new Error('Atomic no-copy/no-clobber mv capability is unavailable.');
    }
    const moved = run('/usr/bin/mv', ['--no-copy', '--no-clobber', '-T', source, target], { encoding: 'utf8' });
    if (moved.status !== 0) throw new Error(`Atomic release script runtime materialization failed: ${moved.stderr || moved.status}`);
}

/** Build from the reviewed identity and atomically materialize a fresh test-only dist-server. */
export function materializeReleaseScriptTestRuntime(options, injected = {}) {
    const sourceRoot = path.resolve(options.sourceRoot);
    const candidateRoot = path.resolve(options.candidateRoot);
    const targetRoot = path.resolve(options.targetRoot);
    assertRealDirectory(sourceRoot, 'Release source');
    if (path.dirname(candidateRoot) !== sourceRoot || path.basename(candidateRoot) !== '.release-script-test-candidate'
        || targetRoot !== path.join(sourceRoot, 'dist-server')) {
        throw new Error('Release script test paths do not match the fixed materialization layout.');
    }
    if (existsSync(candidateRoot) || existsSync(targetRoot)) {
        throw new Error('Release script test materialization requires absent candidate and target paths.');
    }
    mkdirSync(candidateRoot, { mode: 0o700 });
    const candidateRuntime = path.join(candidateRoot, 'server');
    try {
        if (statSync(candidateRoot).dev !== statSync(sourceRoot).dev) {
            throw new Error('Release script test candidate and target must share a filesystem.');
        }
        const build = injected.build || buildServerReleaseCandidate;
        build({ sourceRoot, candidateRoot, outputRoot: candidateRuntime,
            releaseCommit: options.commit, version: options.version });
        verifyIdentity(candidateRuntime, options);
        if (existsSync(targetRoot)) throw new Error('Release script test target appeared before materialization.');
        (injected.move || moveCandidateNoClobber)(candidateRuntime, targetRoot);
        if (existsSync(candidateRuntime)) throw new Error('Release script test candidate remained after materialization.');
        verifyIdentity(targetRoot, options);
        return Object.freeze({ runtimeRoot: targetRoot, commit: options.commit, version: options.version });
    } finally {
        if (existsSync(candidateRoot)) rmSync(candidateRoot, { recursive: true, force: true });
    }
}

function value(argv, flag) {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
}

function main() {
    const argv = process.argv.slice(2); const sourceRoot = path.resolve(value(argv, '--source') || process.cwd());
    const result = materializeReleaseScriptTestRuntime({ sourceRoot,
        candidateRoot: value(argv, '--candidate'),
        targetRoot: path.join(sourceRoot, 'dist-server'), commit: value(argv, '--commit'),
        version: value(argv, '--version') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
