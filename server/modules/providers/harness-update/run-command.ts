/**
 * Bounded child runner of every harness update / version read (T-1749,
 * moved out of update.service.ts for T-1871 so the snapshot flows share it).
 * A hard timeout SIGKILLs the whole POSIX process group, and the result is
 * resolved only once the group is proven dead (`quiesced`) — rollback must
 * never start while an updater child can still write the install.
 */

import { spawn } from 'node:child_process';

// eslint-disable-next-line boundaries/no-unknown -- the root command service owns the canonical secret-stripping environment.
import { cleanSpawnEnv } from '@/services/command-board-custom.js';
import { listAllActiveScopes } from '@/modules/workflow-supervisor/index.js';

import { hasLiveHarnessLaunch } from './spawn-admission.js';
import type { RunResult } from './update-jobs.js';

/** Options of one bounded child run. */
export interface RunCommandOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  /** Called with the pid (= process group id) right after the spawn succeeded. */
  onSpawn?: (pid: number) => void;
}

/**
 * Hands the new group id to `onSpawn` (the durable updater record). If that
 * record cannot be written the group is killed at once: an updater nobody can
 * later prove dead must not keep running (the run then ends as a failure).
 */
function recordSpawn(groupId: number, onSpawn: (pid: number) => void): void {
  try {
    onSpawn(groupId);
  } catch {
    try {
      process.kill(process.platform === 'win32' ? groupId : -groupId, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Hard cap on a single update child process. */
export const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 64 * 1024;

/** Default bounded command runner (spawn + hard timeout + SIGKILL). */
export function runHarnessUpdateCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn> | null = null;
    let groupId: number | null = null;
    const appendBounded = (current: string, chunk: unknown) => {
      const marker = '\n[output truncated]';
      const contentLimit = MAX_CAPTURE_BYTES - marker.length;
      if (current.length >= contentLimit) {
        return current.endsWith(marker) ? current : `${current.slice(0, contentLimit)}${marker}`;
      }
      const next = `${current}${String(chunk)}`;
      return next.length <= contentLimit
        ? next
        : `${next.slice(0, contentLimit)}${marker}`;
    };
    const finish = (code: number | null, quiesced = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, quiesced });
    };
    const waitForGroupDeath = async () => {
      if (!timedOut || groupId === null || process.platform === 'win32') return true;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          process.kill(-groupId, 0);
        } catch {
          return true;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      return false;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child?.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // Resolve only from close/error below: rollback must not begin while any
      // member of the update process group can still be mutating the install.
    }, opts.timeoutMs);
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      groupId = child.pid ?? null;
    } catch (err) {
      stderr = appendBounded(stderr, err instanceof Error ? err.message : String(err));
      finish(null);
      return;
    }
    if (groupId !== null && opts.onSpawn) recordSpawn(groupId, opts.onSpawn);
    child.stdout?.on('data', (b) => {
      stdout = appendBounded(stdout, b.toString());
    });
    child.stderr?.on('data', (b) => {
      stderr = appendBounded(stderr, b.toString());
    });
    child.on('error', (err) => {
      stderr = appendBounded(stderr, err instanceof Error ? err.message : String(err));
      finish(null);
    });
    child.on('close', (code) => {
      void waitForGroupDeath().then((quiesced) => finish(code, quiesced));
    });
  });
}

/**
 * The gate's second leg (item 6): launches this process started outside the
 * presence run registry. In-process children are counted by spawn-admission;
 * the workflow leg runs as a DETACHED systemd user unit (`wf-*.service` →
 * task-runner → `claude -p`) that outlives this process, so it is probed with
 * `systemctl --user list-units`. A probe failure throws and the caller fails
 * CLOSED (treats the harness as busy) rather than updating under a live turn.
 */
export async function defaultHasUnregisteredLaunch(providerIds: string[]): Promise<boolean> {
  if (hasLiveHarnessLaunch(providerIds)) return true;
  if (!providerIds.includes('claude')) return false;
  const units = await listAllActiveScopes();
  return units.length > 0;
}

/** `<binary> --version` under cleanSpawnEnv with a 10 s cap; stdout, else stderr, else null. */
export function defaultRunVersion(cmd: string, args: string[]): Promise<string | null> {
  return runHarnessUpdateCommand(cmd, args, { env: cleanSpawnEnv() as NodeJS.ProcessEnv, timeoutMs: 10_000 }).then((r) =>
    r.stdout.trim() !== '' ? r.stdout : r.stderr.trim() !== '' ? r.stderr : null,
  );
}
