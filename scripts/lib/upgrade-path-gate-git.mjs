// upgrade-path-gate-git.mjs — the one git runner of the upgrade-path gate (B-1584).
// Every gate git command runs with a neutral identity and without the operator's
// system/global git configuration, so no signing key, hook or URL rewrite of the
// host can influence the sandbox.

import { spawnSync } from 'node:child_process';

export const NEUTRAL_GIT_ENV = Object.freeze({
    GIT_AUTHOR_NAME: 'Nassaj Upgrade Gate', GIT_AUTHOR_EMAIL: 'upgrade-gate@localhost.invalid',
    GIT_COMMITTER_NAME: 'Nassaj Upgrade Gate', GIT_COMMITTER_EMAIL: 'upgrade-gate@localhost.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
});

/**
 * Run git in `cwd` and return its stdout (trimmed unless `trim: false`); throw
 * with stderr on failure.
 */
export function git(cwd, args, { env = {}, input, trim = true } = {}) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, ...NEUTRAL_GIT_ENV, ...env } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
    return trim ? (result.stdout || '').trim() : (result.stdout || '');
}
