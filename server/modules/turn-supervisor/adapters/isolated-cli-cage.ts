import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TurnAdapterError } from './types.js';

const ROOT = '/var/tmp/nassaj-turn-supervisor-roles';
const MANIFESTS = path.join(ROOT, 'cleanup-manifests');

export type IsolatedCliProcessSpec = Readonly<{
  binary: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}>;

export type IsolatedCliResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;

export type EphemeralRoleHome = Readonly<{
  id: string; directory: string; home: string; xdgConfig: string; xdgData: string; xdgState: string; xdgCache: string;
  hermesHome: string; manifestPath: string;
}>;

type CleanupManifest = Readonly<{
  version: 1; id: string; directory: string; ownerPid: number; createdAt: string;
}>;

function safeRoleDirectory(candidate: string): boolean {
  const normalizedRoot = `${path.resolve(ROOT)}${path.sep}`;
  return path.resolve(candidate).startsWith(normalizedRoot) && !path.resolve(candidate).includes(`${path.sep}..${path.sep}`);
}

/** Creates an isolated role home and writes its durable cleanup intent first. */
export async function createEphemeralRoleHome(ownerPid = process.pid): Promise<EphemeralRoleHome> {
  const id = randomUUID();
  const directory = path.join(ROOT, `role-${id}`);
  const home = path.join(directory, 'home');
  const xdgConfig = path.join(directory, 'xdg-config');
  const xdgData = path.join(directory, 'xdg-data');
  const xdgState = path.join(directory, 'xdg-state');
  const xdgCache = path.join(directory, 'xdg-cache');
  const hermesHome = path.join(directory, 'hermes-home');
  const manifestPath = path.join(MANIFESTS, `${id}.json`);
  await mkdir(MANIFESTS, { recursive: true, mode: 0o700 });
  const manifest: CleanupManifest = {
    version: 1, id, directory, ownerPid, createdAt: new Date().toISOString(),
  };
  await writeFile(`${manifestPath}.pending`, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
  await import('node:fs/promises').then(({ rename }) => rename(`${manifestPath}.pending`, manifestPath));
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await Promise.all([home, xdgConfig, xdgData, xdgState, xdgCache, hermesHome]
    .map((entry) => mkdir(entry, { recursive: true, mode: 0o700 })));
  return Object.freeze({ id, directory, home, xdgConfig, xdgData, xdgState, xdgCache, hermesHome, manifestPath });
}

/** Removes only a role directory whose durable manifest matches its identity. */
export async function cleanupEphemeralRoleHome(role: EphemeralRoleHome): Promise<void> {
  if (!safeRoleDirectory(role.directory)) throw new TypeError('unsafe ephemeral role directory');
  const parsed = JSON.parse(await readFile(role.manifestPath, 'utf8')) as CleanupManifest;
  if (parsed.version !== 1 || parsed.id !== role.id || parsed.directory !== role.directory) {
    throw new Error('ephemeral role cleanup manifest mismatch');
  }
  await rm(role.directory, { recursive: true, force: false });
  await unlink(role.manifestPath);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Crash sweeper: removes only manifest-bound homes whose owning server died. */
export async function sweepOrphanedRoleHomes(): Promise<readonly string[]> {
  await mkdir(MANIFESTS, { recursive: true, mode: 0o700 });
  const removed: string[] = [];
  for (const name of await readdir(MANIFESTS)) {
    if (!name.endsWith('.json')) continue;
    const manifestPath = path.join(MANIFESTS, name);
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as CleanupManifest;
      if (parsed.version !== 1 || !safeRoleDirectory(parsed.directory) || processAlive(parsed.ownerPid)) continue;
      await rm(parsed.directory, { recursive: true, force: false });
      await unlink(manifestPath);
      removed.push(parsed.id);
    } catch { /* malformed manifests are quarantined, never guessed/deleted */ }
  }
  return Object.freeze(removed);
}

function quoteSystemdProperty(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\n') || value.includes('\0')) throw new TypeError('unsafe cage path');
  return value;
}

/**
 * Runs an exact argv in a transient systemd service. The service supplies the
 * filesystem/cgroup cage; detached launch plus unit kill supplies TERM→KILL.
 * Resolution happens only after close and a negative cgroup ActiveState probe.
 */
export function spawnInIsolatedCliCage(input: IsolatedCliProcessSpec & {
  role: EphemeralRoleHome; signal?: AbortSignal; systemdRunBinary?: string; systemctlBinary?: string;
}): Promise<IsolatedCliResult> {
  const unit = `nassaj-turn-role-${input.role.id}`;
  const systemdRun = input.systemdRunBinary ?? '/usr/bin/systemd-run';
  const systemctl = input.systemctlBinary ?? '/usr/bin/systemctl';
  const isolatedNames = new Set(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HERMES_HOME']);
  const inheritedEnvironment = Object.keys(input.env)
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !isolatedNames.has(name))
    // NAME without = asks systemd-run to copy the value from its own sanitized
    // process environment; credential values never enter argv or logs.
    .flatMap((name) => [`--setenv=${name}`]);
  const args = [
    '--user', '--wait', '--pipe', '--collect', '--service-type=exec', `--unit=${unit}`,
    '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
    '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes',
    `--property=ReadOnlyPaths=${quoteSystemdProperty(input.cwd)}`,
    `--property=ReadWritePaths=${quoteSystemdProperty(input.role.directory)}`,
    '--setenv=HOME=' + input.role.home, '--setenv=XDG_CONFIG_HOME=' + input.role.xdgConfig,
    '--setenv=XDG_DATA_HOME=' + input.role.xdgData,
    '--setenv=XDG_STATE_HOME=' + input.role.xdgState, '--setenv=XDG_CACHE_HOME=' + input.role.xdgCache,
    '--setenv=HERMES_HOME=' + input.role.hermesHome,
    ...inheritedEnvironment,
    input.binary, ...input.args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(systemdRun, args, {
      cwd: input.cwd, env: input.env, shell: false, detached: true,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const control = (verb: 'kill' | 'is-active', extra: readonly string[] = []): Promise<number | null> => new Promise((done) => {
      const ctl = spawn(systemctl, ['--user', verb, ...extra, unit], { shell: false, stdio: 'ignore' });
      ctl.once('close', done); ctl.once('error', () => done(null));
    });
    const wait = () => new Promise<void>((done) => setTimeout(done, 25));
    const reap = async (): Promise<void> => {
      await control('kill', ['--kill-who=all', '--signal=SIGTERM']);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await control('is-active')) !== 0) return;
        await wait();
      }
      await control('kill', ['--kill-who=all', '--signal=SIGKILL']);
      while ((await control('is-active')) === 0) await wait();
    };
    const abort = (): void => { aborted = true; void reap(); };
    if (input.signal?.aborted) abort(); else input.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', async (code) => {
      input.signal?.removeEventListener('abort', abort);
      await reap();
      if (aborted) reject(new TurnAdapterError('aborted', 'supervised CLI role was aborted and reaped'));
      else resolve(Object.freeze({ code, stdout, stderr }));
    });
  });
}

export const isolatedCliCageInternals = Object.freeze({ ROOT, MANIFESTS, safeRoleDirectory });
