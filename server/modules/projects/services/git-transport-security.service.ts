/** Shared hardened transport primitives for project and agent GitHub flows. */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export type CanonicalGitHubRepository = {
  owner: string;
  repo: string;
  cloneUrl: string;
};

export type GitAskpassLease = {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
};

/** Accepts only canonical HTTPS github.com repository URLs. */
export function parseCanonicalGitHubUrl(rawUrl: unknown): CanonicalGitHubRepository {
  if (typeof rawUrl !== 'string') throw new Error('INVALID_GITHUB_URL');
  const candidate = rawUrl.trim();
  if (!candidate || candidate.startsWith('-')) throw new Error('INVALID_GITHUB_URL');
  const authority = candidate.startsWith('https://')
    ? candidate.slice('https://'.length).split('/')[0]
    : '';
  // URL normalizes an explicit default :443 away, so pin the raw authority too.
  if (authority.toLowerCase() !== 'github.com') throw new Error('INVALID_GITHUB_URL');
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('INVALID_GITHUB_URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('INVALID_GITHUB_URL');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) throw new Error('INVALID_GITHUB_URL');
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(segments[0]);
    repo = decodeURIComponent(segments[1]).replace(/\.git$/i, '');
  } catch {
    throw new Error('INVALID_GITHUB_URL');
  }
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) {
    throw new Error('INVALID_GITHUB_URL');
  }
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/** Keeps only a bounded tail for internal classification; never return it publicly. */
export function appendBoundedDiagnostic(current: string, chunk: unknown): string {
  const combined = current + String(chunk ?? '');
  const bytes = Buffer.from(combined, 'utf8');
  if (bytes.length <= MAX_DIAGNOSTIC_BYTES) return combined;
  return bytes.subarray(bytes.length - MAX_DIAGNOSTIC_BYTES).toString('utf8');
}

/** Stable public clone failure contract; raw git output is deliberately excluded. */
export function classifyGitCloneFailure(diagnostic: string): {
  code: string;
  message: string;
} {
  if (/authentication failed|could not read username|permission denied/i.test(diagnostic)) {
    return { code: 'GIT_CLONE_AUTH_FAILED', message: 'Repository authentication failed' };
  }
  if (/repository not found/i.test(diagnostic)) {
    return { code: 'GIT_CLONE_NOT_FOUND', message: 'Repository not found or inaccessible' };
  }
  return { code: 'GIT_CLONE_FAILED', message: 'Repository clone failed' };
}

/** Stable public push failure contract; raw git output is deliberately excluded. */
export function classifyGitPushFailure(diagnostic: string): {
  code: string;
  message: string;
} {
  if (/authentication failed|could not read username|permission denied/i.test(diagnostic)) {
    return { code: 'GIT_PUSH_AUTH_FAILED', message: 'Repository authentication failed' };
  }
  return { code: 'GIT_PUSH_FAILED', message: 'Repository push failed' };
}

/**
 * Creates an owner-only, short-lived askpass directory on disk. The token is in
 * neither URL, argv, script, nor environment; the child sees only its 0600 file
 * path and the fixed askpass executable path. Call cleanup after git exits.
 */
export async function createGitAskpassLease(token: string | null): Promise<GitAskpassLease> {
  const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!token) return { env: baseEnv, cleanup: async () => undefined };
  if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token) > 16 * 1024) {
    throw new Error('GIT_CREDENTIAL_INVALID');
  }
  const directory = await mkdtemp(path.join('/var/tmp', 'nassaj-git-askpass-'));
  const secretFile = path.join(directory, 'credential');
  const askpassFile = path.join(directory, 'askpass.sh');
  try {
    await writeFile(secretFile, token, { mode: 0o600, flag: 'wx' });
    await writeFile(
      askpassFile,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) exec /bin/cat "$NASSAJ_GIT_ASKPASS_SECRET_FILE" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o700, flag: 'wx' }
    );
    await chmod(directory, 0o700);
    return {
      env: {
        ...baseEnv,
        GIT_ASKPASS: askpassFile,
        GIT_ASKPASS_REQUIRE: 'force',
        NASSAJ_GIT_ASKPASS_SECRET_FILE: secretFile,
      },
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function spawnGitWithAskpass(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) {
  return spawn('git', args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
