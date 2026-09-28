/**
 * Entry point of the standalone release verifier (ADR-174 §7.4, §9.2 step 7).
 * esbuild bundles this file with its whole closure into the release asset
 * `attestation-verifier.mjs`; the same module is imported by the pipeline
 * self-check and run as a CLI by the fleet simulation. The CLI contract is
 * read by LATER pipelines against THIS verifier, so it only grows by bridge
 * releases (§5.2 a).
 *
 *   attestation-verifier.mjs <bundle> <trusted_root> <policy> <manifest>
 *       [--artifacts DIR] [--installed VERSION@SEQUENCE --shim-version N]
 *
 * --artifacts   every manifest archive and the installer are read from DIR
 *               and bound to the manifest and the attested subjects;
 * --installed   decide as a node that runs VERSION at releaseSequence SEQUENCE
 *               (default: a node with nothing installed);
 * --shim-version installed shim version (default: not evaluated).
 *
 * Exit 0 accepted (one JSON line), 2 `REJECTED <code>: <detail>`,
 * 3 `NOOP` (the candidate is the installed release), 64 usage.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ATTESTATION_CODES as C } from './attestation-verifier.mjs';
import {
    VERIFICATION_CODES, VERIFIER_VERSION, isVerificationError, manifestAssets, rejectionCode, verifyAndDecide,
} from './release-verification.mjs';
import { installedTrustState } from './release-sequence.mjs';

export * from './attestation-verifier.mjs';
export * from './release-verification.mjs';
export { installedTrustState } from './release-sequence.mjs';
export { parseReleaseManifest } from './release-manifest.mjs';

const USAGE = 'usage: attestation-verifier.mjs <bundle> <trusted_root> <policy> <manifest> '
    + '[--artifacts DIR] [--installed VERSION@SEQUENCE --shim-version N]';
const INSTALLED = /^(\d{1,9}(?:\.\d{1,9}){3})@([1-9]\d{0,14})$/;

class UsageError extends Error {}

/**
 * Parse CLI arguments; any unknown, repeated or malformed option is a usage error.
 * @param {string[]} argv
 * @returns {{files: string[], artifacts?: string, installed?: {version: string, sequence: number},
 *   shimVersion?: number}}
 */
export function parseVerifierArguments(argv) {
    const files = [];
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith('--')) { files.push(arg); continue; }
        const value = argv[index += 1];
        const key = { '--artifacts': 'artifacts', '--installed': 'installed', '--shim-version': 'shimVersion' }[arg];
        if (!key || value === undefined || key in options) throw new UsageError(`bad option ${arg}`);
        options[key] = value;
    }
    if (files.length !== 4) throw new UsageError('four input files are required');
    const out = { files };
    if (options.artifacts) out.artifacts = options.artifacts;
    if (options.installed !== undefined) {
        const match = INSTALLED.exec(options.installed);
        if (!match || options.shimVersion === undefined) throw new UsageError('--installed needs VERSION@SEQUENCE and --shim-version');
        out.installed = { version: match[1], sequence: Number(match[2]) };
    }
    if (options.shimVersion !== undefined) {
        if (!/^[1-9]\d{0,6}$/.test(options.shimVersion)) throw new UsageError('--shim-version must be a positive integer');
        out.shimVersion = Number(options.shimVersion);
    }
    return out;
}

/** Reads one input file; an unreadable file fails with the code of what it carries. */
function readInput(file, code, json) {
    try {
        const bytes = readFileSync(file);
        return json ? JSON.parse(bytes.toString('utf8')) : bytes;
    } catch (e) {
        const error = new Error(`cannot read ${path.basename(file)}: ${e.code || e.name}`);
        error.code = code;
        throw error;
    }
}

/** Streamed sha256 of a file (archives are large); unreadable → null. */
function hashFile(file) {
    let fd;
    try {
        fd = openSync(file, 'r');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(1 << 20);
        for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
        return hash.digest('hex');
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function artifactsIn(directory, manifest) {
    return [...manifestAssets(manifest).keys()].map(name => ({
        name, actualSha256: hashFile(path.join(directory, path.basename(name))) ?? '',
    }));
}

function verifyFromArguments(args, deps) {
    const [bundlePath, rootPath, policyPath, manifestPath] = args.files;
    const policy = readInput(policyPath, C.TRUST_POLICY_MISSING, true);
    const trustedRoot = readInput(rootPath, C.TRUST_POLICY_MISSING, true);
    const bundleBytes = readInput(bundlePath, C.ATTESTATION_INVALID, false);
    const manifestBytes = readInput(manifestPath, C.MANIFEST_NOT_ATTESTED, false);
    const trustState = args.installed && installedTrustState({ installedVersion: args.installed.version,
        installedSequence: args.installed.sequence });
    return verifyAndDecide({
        bundleBytes, manifestBytes, trustedRoot, policy, shimVersion: args.shimVersion,
        trustState: trustState || undefined, completeArtifacts: true,
        artifacts: args.artifacts ? manifest => artifactsIn(args.artifacts, manifest) : undefined,
    }, deps);
}

/**
 * Run the CLI.
 * @param {string[]} argv arguments after the script path
 * @param {{stdout: {write: Function}, stderr: {write: Function}}} [io]
 * @param {object} [deps] passed to verifyAndDecide (tests)
 * @returns {number} exit code
 */
export function runVerifierCli(argv, io = process, deps = {}) {
    let args;
    try {
        args = parseVerifierArguments(argv);
    } catch (error) {
        io.stderr.write(`${error.message}\n${USAGE}\n`);
        return 64;
    }
    try {
        const { verified, manifest, artifacts, decision } = verifyFromArguments(args, deps);
        if (decision.verdict === 'noop') { io.stdout.write(`NOOP ${manifest.version} is installed\n`); return 3; }
        if (decision.verdict === 'reject') {
            io.stdout.write(`REJECTED ${decision.code}: decision for ${manifest.version}\n`);
            return 2;
        }
        io.stdout.write(`${JSON.stringify({ ok: true, verifierVersion: VERIFIER_VERSION, version: manifest.version,
            releaseSequence: manifest.releaseSequence, integratedTime: verified.integratedTime, logIndex: verified.logIndex,
            subjects: verified.subjects.size, artifacts, warnings: decision.warnings })}\n`);
        return 0;
    } catch (error) {
        const known = isVerificationError(error) || VERIFICATION_CODES.has(error?.code);
        io.stdout.write(`REJECTED ${rejectionCode(error)}: ${known ? error.detail ?? error.message : error?.name}\n`);
        return 2;
    }
}

function isCliEntry() {
    if (!process.argv[1]) return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href;
    } catch {
        return false;
    }
}

if (isCliEntry()) process.exitCode = runVerifierCli(process.argv.slice(2));
