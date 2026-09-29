/** Shared build mechanics only: callers retain their independent source and approval authority. */
import path from 'node:path';

/** Limit dependency lifecycle processes to the established installation environment. */
export function dependencyEnvironment(env = process.env) {
    const allowed = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
        'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
    return { ...Object.fromEntries(allowed.flatMap(key => typeof env[key] === 'string' && env[key] ? [[key, env[key]]] : [])),
        HUSKY: '0', NODE_ENV: 'production' };
}

/** Install a private source tree, then build both artifacts with its installed dependencies. */
export async function installAndBuildCandidate({ sourceRoot, candidateRoot, outputs, sourceOid, version, publicVite }, operations) {
    const env = dependencyEnvironment(operations.env || process.env);
    operations.verifySource('before-install');
    operations.beforeInstall?.();
    operations.run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', ...(operations.installArgs || [])], { cwd: sourceRoot, env });
    operations.verifySource('after-install');
    const npmList = operations.run('npm', ['ls', '--all', '--json'], { cwd: sourceRoot, env });
    const common = { sourceRoot, candidateRoot, releaseCommit: sourceOid, version };
    operations.beforeBuild?.();
    const client = await operations.buildClient({ ...common, outputRoot: outputs.client, publicVite });
    const server = await operations.buildServer({ ...common, outputRoot: outputs.server });
    const sourceProvenance = operations.verifySource('after-build');
    return { client, server, sourceProvenance, npmList, stagedModules: path.join(sourceRoot, 'node_modules') };
}

/** Load each immutable target's builder in its own process so build tools resolve from staged dependencies. */
export function buildInstalledCandidateArtifact(domain, options, run, env) {
    const programs = {
        client: "import {buildClientReleaseCandidate as build} from '../client-build-atomic.mjs'; const result=await build(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify(result)+'\\n');",
        server: "import {buildServerReleaseCandidate as build} from '../server-build-atomic.mjs'; const result=await build(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify(result)+'\\n');",
    };
    if (!Object.hasOwn(programs, domain)) throw new Error('candidate_build_domain_invalid');
    // stderr is inherited so the builder's own failure reason reaches the updater job log.
    const result = run(process.execPath, ['--input-type=module', '-e', programs[domain], JSON.stringify(options)], {
        cwd: path.join(options.sourceRoot, 'scripts', 'lib'), env, stdio: ['ignore', 'pipe', 'inherit'],
    });
    return parseBuilderOutput(result?.stdout);
}

function parseBuilderOutput(stdout) {
    const last = typeof stdout === 'string' ? stdout.trim().split('\n').at(-1) : '';
    try {
        const parsed = JSON.parse(last);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* reported below with a stable code */ }
    throw Object.assign(new Error('candidate_build_output_invalid'), { code: 'candidate_build_output_invalid' });
}

const STDERR_TAIL_BYTES = 4096;
const SECRET_PATTERNS = [
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
    [/\b((?:[A-Za-z0-9_]*(?:token|secret|password|passwd|credential|authorization|cookie|api[_-]?key))["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
    [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]'],
    [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]'],
    [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
    [/\bxox[bp]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
    [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@'],
];

/** Return a bounded (~4KB), secret-redacted tail of child stderr for error messages. */
export function sanitizedStderrTail(stderr) {
    if (typeof stderr !== 'string' || !stderr) return '';
    let text = stderr.slice(-STDERR_TAIL_BYTES * 2).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
    return text.slice(-STDERR_TAIL_BYTES).trim();
}
