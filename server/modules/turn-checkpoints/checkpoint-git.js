/**
 * T-2095 git runner for checkpoint stores. Asynchronous only (no spawnSync on
 * the turn path), deadline-bounded, and run with an environment the project
 * cannot influence: GIT_DIR is the private store, global and system config are
 * off, and every call carries the shared hardening plus hooks disabled.
 */
import { spawn } from 'node:child_process';

import { hardenGitArgs } from '../../../shared/git-safety.js';

let spawnCount = 0;

/** Number of git children started so far (tests assert capture cost does not scale with files). */
export function storeGitSpawnCount() {
  return spawnCount;
}

/** Raised when a capture exceeds its time budget. */
export class CheckpointTimeoutError extends Error {
  constructor() {
    super('turn checkpoint budget exceeded');
    this.code = 'CHECKPOINT_TIMEOUT';
  }
}

const IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'nassaj-checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@nassaj.invalid',
  GIT_COMMITTER_NAME: 'nassaj-checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@nassaj.invalid',
});

/**
 * The isolated environment for one store invocation. Nothing from the
 * server's own GIT_* environment is inherited.
 * @param {{store: string, workTree?: string, indexFile?: string}} input
 */
export function storeGitEnv({ store, workTree, indexFile }) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_DIR: store,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...IDENTITY,
  };
  if (workTree) env.GIT_WORK_TREE = workTree;
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

/**
 * Runs one hardened git command and resolves with its raw output.
 * @param {string[]} args argv after `git`
 * @param {{env: Record<string,string>, input?: Buffer|string, deadline?: number,
 *   allowFailure?: boolean, maxBytes?: number}} options
 * @returns {Promise<{status: number, stdout: Buffer, stderr: string}>}
 */
export function runStoreGit(args, { env, input, deadline = Infinity, allowFailure = false, maxBytes = 64 * 1024 * 1024 }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new CheckpointTimeoutError());
  const pinned = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
  return new Promise((resolve, reject) => {
    spawnCount += 1;
    const child = spawn('git', hardenGitArgs(pinned), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    const timer = Number.isFinite(remaining)
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, remaining)
      : null;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (timedOut) return reject(new CheckpointTimeoutError());
      const result = { status: status ?? -1, stdout: Buffer.concat(chunks), stderr };
      if (size > maxBytes) return reject(new Error(`git ${args[0]} output exceeded its cap`));
      if (result.status !== 0 && !allowFailure) {
        return reject(new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${result.status}`}`));
      }
      return resolve(result);
    });
    child.stdin.on('error', () => { /* the child exited before reading stdin */ });
    child.stdin.end(input ?? undefined);
  });
}

/** Runs git and returns trimmed UTF-8 stdout. */
export async function storeGitText(args, options) {
  return (await runStoreGit(args, options)).stdout.toString('utf8').trim();
}
