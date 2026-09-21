#!/usr/bin/env node
/**
 * build-provenance.mjs — stamp every build artefact with the commit it came from.
 *
 * WHY: the live site has been served from a build made out of an UNCOMMITTED
 * working tree (265 modified files at the time of the audit), so nothing on disk
 * or over the wire could answer "which code is this?". Two recorded incidents
 * come from the same blind spot: a node serving code 24 days old because the
 * update was a `checkout` with no restart, and a node whose source said 1.38
 * while its build was 1.37.
 *
 * WHAT: writes `<artefact-dir>/BUILD_PROVENANCE.json` right after a build, with
 * the commit (full + short), branch, whether the tree was DIRTY at build time
 * (plus how many files), the nearest tag, the package version, and the build
 * timestamp.
 *
 * DECLARE, NEVER BLOCK. A dirty tree prints a loud warning and nothing more.
 * A fail-closed guard here was considered and REJECTED by decision: this repo
 * builds from a dirty tree as a normal working mode, and a guard that stops the
 * build would be disabled within a week — leaving the blind spot AND no warning.
 * Every failure path (no git, no repo, unreadable package.json) degrades to a
 * partial record and exit 0; a provenance stamp must never be the reason a
 * build fails.
 *
 * Usage: node scripts/build-provenance.mjs [--artifact client|server]
 *        client → dist/            (default)
 *        server → dist-server/
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ARTIFACT_DIRS = { client: 'dist', server: 'dist-server' };

/** Run a git command in ROOT, returning trimmed stdout or null on any failure. */
function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null; // no git binary, not a repo, or the command has no answer
    }
}

function readPackageVersion() {
    try {
        return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? null;
    } catch {
        return null;
    }
}

/**
 * Collect the provenance record. Exported for tests; pure apart from git reads.
 * @param {{ artifact?: string }} [options]
 */
export function collectProvenance({
    artifact = 'client',
    buildId = process.env.NASSAJ_BUILD_ID || null,
    baseCommit = process.env.NASSAJ_BASE_COMMIT || null,
} = {}) {
    // `git status --porcelain` lists tracked modifications AND untracked files —
    // both change what a build produces, so both count as dirty.
    const porcelain = git(['status', '--porcelain']);
    const dirtyFiles = porcelain === null ? null : porcelain.split('\n').filter((line) => line.trim() !== '').length;
    const commit = git(['rev-parse', 'HEAD']);

    return {
        artifact,
        version: readPackageVersion(),
        commit,
        // Local preview safety is content/epoch based. The commit observed when
        // compilation started is informational and never substitutes for buildId.
        baseCommit: /^[a-f0-9]{40}$/.test(baseCommit || '') ? baseCommit : null,
        commitShort: commit ? commit.slice(0, 8) : null,
        // A detached HEAD answers "HEAD"; keep it verbatim rather than inventing a name.
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        describe: git(['describe', '--tags', '--always', '--dirty']),
        // null (not false) when git could not be consulted: "unknown" and "clean"
        // must not read the same on an operator's screen.
        dirty: dirtyFiles === null ? null : dirtyFiles > 0,
        dirtyFiles,
        builtAt: new Date().toISOString(),
        buildId,
    };
}

function main() {
    const argv = process.argv.slice(2);
    const flagIndex = argv.indexOf('--artifact');
    const requested = flagIndex >= 0 ? argv[flagIndex + 1] : 'client';
    const artifact = Object.hasOwn(ARTIFACT_DIRS, requested) ? requested : 'client';

    const record = collectProvenance({ artifact });
    // Atomic publishers build both artefacts outside their live directory.
    // The override is deliberately artifact-neutral; the caller still declares
    // the artifact in the record and validation rejects a mismatch.
    const configuredOutDir = process.env.NASSAJ_PROVENANCE_OUT_DIR;
    const outDir = configuredOutDir ? path.resolve(configuredOutDir) : path.join(ROOT, ARTIFACT_DIRS[artifact]);
    const outFile = path.join(outDir, 'BUILD_PROVENANCE.json');

    try {
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (error) {
        console.warn(`[provenance] could not write ${outFile}: ${error.message}`);
        return; // exit 0 — see DECLARE, NEVER BLOCK above
    }

    const label = `${record.describe ?? 'unknown'} (${record.branch ?? 'unknown branch'})`;
    if (record.dirty) {
        console.warn(
            `\n⚠️  [provenance] built from a DIRTY tree: ${record.dirtyFiles} uncommitted file(s).` +
                `\n    ${label} — this artefact does NOT match any commit. Nothing was blocked.\n`
        );
    } else if (record.dirty === null) {
        console.warn(`[provenance] git unavailable — ${ARTIFACT_DIRS[artifact]}/BUILD_PROVENANCE.json is partial.`);
    } else {
        console.log(`[provenance] ${ARTIFACT_DIRS[artifact]}/ built clean from ${label}`);
    }
}

// Only run when invoked directly, so tests can import collectProvenance.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
