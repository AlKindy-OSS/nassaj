/**
 * ADR-207 §3.5 (M8, T-2024 S2): the identity key of a prestaged candidate.
 *
 * A prestaged candidate may be adopted at click only when everything that
 * shaped its bytes is still the same. The key covers the release (commit and
 * source pin), the interpreter (a CHILD probe of `process.execPath`, plus the
 * binary's realpath and `{dev, ino, size, mtimeMs}`), npm (realpath and
 * version), the running builder's server build id and the build inputs
 * (candidate script hash, public Vite values, allow-listed build env hash,
 * `package-lock.json` blob id, strategy). The digest is a SHA-256 of the
 * canonical JSON, so field order never matters.
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROBE_TIMEOUT_MS = 15_000;
const RUNTIME_PROBE = 'process.stdout.write(JSON.stringify({version:process.version,'
    + 'modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch}))';

/** Canonical JSON: object keys sorted at every depth. */
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function execFileText(file, args, options) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { ...options, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' },
            (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
}

function binaryIdentity(file) {
    const realpath = fs.realpathSync(file);
    const stat = fs.statSync(realpath);
    return { realpath, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * Probe the interpreter in a child, never this process's own `process.versions`:
 * the binary on disk may have been replaced since this server started.
 * @param {{execPath?: string, run?: typeof execFileText}} [options]
 */
export async function probeRuntimeIdentity({ execPath = process.execPath, run = execFileText } = {}) {
    let reported;
    try { reported = JSON.parse(await run(execPath, ['-e', RUNTIME_PROBE], { env: {} })); } catch {
        throw Object.assign(new Error('prestage_runtime_probe_failed'), { code: 'prestage_runtime_probe_failed' });
    }
    const { version, modules, napi, platform, arch } = reported ?? {};
    if (![version, modules, napi, platform, arch].every((field) => typeof field === 'string' && field)) {
        throw Object.assign(new Error('prestage_runtime_probe_invalid'), { code: 'prestage_runtime_probe_invalid' });
    }
    return { version, modules, napi, platform, arch, binary: binaryIdentity(execPath) };
}

/** The first `npm` on `searchPath`, as the candidate build resolves it. */
export function resolveOnPath(name, searchPath) {
    for (const directory of String(searchPath || '').split(path.delimiter)) {
        if (!directory || !path.isAbsolute(directory)) continue;
        const candidate = path.join(directory, name);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
    }
    return null;
}

/** npm realpath and version under the build environment's PATH. */
export async function probeNpmIdentity({ env = process.env, run = execFileText } = {}) {
    const npm = resolveOnPath('npm', env.PATH);
    if (!npm) throw Object.assign(new Error('prestage_npm_unavailable'), { code: 'prestage_npm_unavailable' });
    let version;
    try { version = (await run(npm, ['--version'], { env })).trim(); } catch {
        throw Object.assign(new Error('prestage_npm_probe_failed'), { code: 'prestage_npm_probe_failed' });
    }
    return { realpath: fs.realpathSync(npm), version };
}

function requireField(condition, field) {
    if (!condition) throw Object.assign(new Error(`prestage_identity_invalid:${field}`), { code: 'prestage_identity_invalid', field });
}

/**
 * Validate the identity fields and return `{key, digest}`.
 * @param {object} fields
 * @param {string} fields.releaseCommit
 * @param {{repositoryUrl: string, remote: string, branch: string, tag: string}} fields.sourcePin
 * @param {object} fields.runtime   probeRuntimeIdentity() result
 * @param {{realpath: string, version: string}} fields.npm
 * @param {string} fields.builderBuildId  the running server's build id
 * @param {{candidateScriptSha256: string, publicViteSha256: string, buildEnvSha256: string,
 *   packageLockBlob: string, strategy: string}} fields.buildInputs
 */
export function buildPrestageIdentityKey({ releaseCommit, sourcePin, runtime, npm, builderBuildId, buildInputs }) {
    requireField(SHA1.test(releaseCommit || ''), 'releaseCommit');
    requireField(['repositoryUrl', 'remote', 'branch', 'tag'].every((key) => typeof sourcePin?.[key] === 'string' && sourcePin[key]), 'sourcePin');
    requireField(['version', 'modules', 'napi', 'platform', 'arch'].every((key) => typeof runtime?.[key] === 'string')
        && typeof runtime?.binary?.realpath === 'string' && Number.isFinite(runtime.binary.ino), 'runtime');
    requireField(typeof npm?.realpath === 'string' && typeof npm?.version === 'string', 'npm');
    requireField(typeof builderBuildId === 'string' && builderBuildId.length > 0, 'builderBuildId');
    requireField(['candidateScriptSha256', 'publicViteSha256', 'buildEnvSha256'].every((key) => SHA256.test(buildInputs?.[key] || ''))
        && SHA1.test(buildInputs?.packageLockBlob || '') && typeof buildInputs?.strategy === 'string', 'buildInputs');
    const key = {
        releaseCommit, sourcePin: { ...sourcePin }, runtime: { ...runtime, binary: { ...runtime.binary } },
        npm: { ...npm }, builderBuildId, buildInputs: { ...buildInputs },
    };
    return { key, digest: sha256Hex(canonicalJson(key)) };
}

/** The names of the top-level identity fields that differ between two keys (for receipts and logs). */
export function diffPrestageIdentity(recorded, current) {
    const fields = new Set([...Object.keys(recorded ?? {}), ...Object.keys(current ?? {})]);
    return [...fields].filter((field) => canonicalJson(recorded?.[field]) !== canonicalJson(current?.[field])).sort();
}
