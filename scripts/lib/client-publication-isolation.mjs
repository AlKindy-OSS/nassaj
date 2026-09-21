/** Fail-closed namespace build launcher. Only installed code determines host mounts and environment. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { inspectClientPublicationTree } from './client-publication-artifacts.mjs';

const require = createRequire(import.meta.url);
const SUPERVISOR = `
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const commands=JSON.parse(process.argv[1]);
const descendants=()=>fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)&&Number(x)!==1&&Number(x)!==process.pid);
for(const command of commands){
 const result=spawnSync(command.command,command.args,{cwd:command.cwd,stdio:'inherit',env:command.env});
 if(result.status!==0)process.exit(71);
 if(descendants().length)process.exit(72);
}
`;

function realDirectory(value) {
    const directory = path.resolve(value), stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('client_build_mount_unsafe');
    return directory;
}

/** Resolve only known installed bubblewrap executables; absence is an error, never uncaged fallback. */
export function resolveClientBuildSandbox() {
    const candidates = ['/usr/bin/bwrap'];
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
    if (architecture) {
        try {
            const root = path.dirname(require.resolve(`@openai/codex-linux-${process.arch}/package.json`));
            candidates.push(path.join(root, 'vendor', `${architecture}-unknown-linux-musl`, 'codex-resources', 'bwrap'));
        } catch {}
    }
    for (const file of candidates) {
        try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
    }
    throw new Error('client_build_isolation_unavailable');
}

/** Construct a minimal mount namespace; source/dependencies are readonly and no host root is mounted. */
export function clientBuildSandboxInvocation(options) {
    const source = realDirectory(options.sourceRoot), dependencies = realDirectory(options.dependenciesRoot);
    const output = realDirectory(options.outputRoot), scratch = realDirectory(options.scratchRoot);
    if ([source, dependencies, output, scratch].some((item, index, all) => all.some((other, i) => i !== index && (item === other || item.startsWith(`${other}/`))))) throw new Error('client_build_mount_overlap');
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
        if (fs.existsSync(path.join(source, name))) throw new Error('client_build_environment_file_refused');
    }
    if (!Array.isArray(options.commands) || !options.commands.length) throw new Error('client_build_commands_required');
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64', '--dev', '/dev', '--proc', '/proc',
        '--ro-bind', source, source, '--ro-bind', dependencies, dependencies,
        '--bind', output, output, '--bind', scratch, '/tmp', '--dir', '/empty-home'];
    // Snapshots may retain a git pointer; it is not a build input or a grant to host control.
    if (fs.existsSync(path.join(source, '.git'))) {
        const git = path.join(source, '.git');
        args.push(...(fs.lstatSync(git).isDirectory() ? ['--tmpfs', git] : ['--ro-bind', '/dev/null', git]));
    }
    const safe = { PATH: '/usr/bin:/bin', HOME: '/empty-home', TMPDIR: '/tmp', NODE_ENV: 'production', LANG: 'C.UTF-8' };
    const permitted = new Set(['NASSAJ_ATOMIC_CLIENT_BUILD', 'NASSAJ_LOCAL_PREVIEW', 'NASSAJ_BUILD_ID',
        'NASSAJ_CLIENT_OUT_DIR', 'NASSAJ_CLIENT_PREVIEW_ROOT', 'NASSAJ_CLIENT_GENERATION_ID']);
    const commands = options.commands.map(command => {
        if (!path.isAbsolute(command.command) || !Array.isArray(command.args) || command.args.some(value => typeof value !== 'string')) throw new Error('client_build_command_invalid');
        const env = { ...safe };
        for (const [key, value] of Object.entries(command.env || {})) {
            if (!permitted.has(key) || typeof value !== 'string') throw new Error('client_build_environment_refused');
            env[key] = value;
        }
        return { command: command.command, args: command.args, cwd: source, env };
    });
    args.push('--chdir', source, '--', '/usr/bin/node', '--input-type=module', '-e', SUPERVISOR, JSON.stringify(commands));
    return { command: resolveClientBuildSandbox(), args, output };
}

/** Wait for namespace teardown (including every child) before exposing any output to the verifier. */
export async function runIsolatedClientBuild(options) {
    const invocation = clientBuildSandboxInvocation(options);
    const timeout = options.timeoutMs ?? 10 * 60 * 1000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30 * 60 * 1000) throw new Error('client_build_timeout_invalid');
    await new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, { stdio: ['ignore', 'inherit', 'inherit'],
            env: { PATH: '/usr/bin:/bin' }, cwd: options.scratchRoot });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (status, signal) => {
            clearTimeout(timer);
            if (status !== 0 || signal || timedOut) reject(new Error(timedOut ? 'client_build_timeout' : 'client_build_isolation_or_descendant_failure'));
            else resolve();
        });
    });
    return inspectClientPublicationTree(invocation.output);
}
