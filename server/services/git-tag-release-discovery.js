import { spawn } from 'node:child_process';

import {
    compareNassajReleaseVersions, isNassajReleaseVersion,
} from '../../shared/release-version-policy.js';

import { ReleaseDiscoveryError } from './release-discovery.js';
import { resolveReleaseSource } from './release-source-config.js';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 1024 * 1024;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function positiveInteger(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

/**
 * Run `git ls-remote --tags <remote>` in the source tree. The git environment
 * is neutralized against an untrusted *system* config and interactive prompts,
 * but — unlike the read-only capability probe — the user's global config and SSH
 * agent are deliberately preserved so the node's own git credentials reach a
 * private release source. No GitHub API token is used; a public source needs no
 * credential at all.
 */
function defaultLsRemote({ appRoot, remote, env, timeoutMs }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'ls-remote', '--tags', '--', remote], {
                cwd: appRoot,
                env: {
                    ...env,
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_CONFIG_NOSYSTEM: '1',
                    GIT_CONFIG_SYSTEM: '/dev/null',
                    GIT_OPTIONAL_LOCKS: '0',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch { resolve({ ok: false }); return; }
        let stdout = '';
        let settled = false;
        const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish({ ok: false }); }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > OUTPUT_LIMIT) { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish({ ok: false }); }
        });
        child.stderr.on('data', () => {}); // drained but never surfaced (no secrets in logs)
        child.once('error', () => finish({ ok: false }));
        child.once('close', (code) => finish({ ok: code === 0, stdout }));
    });
}

/**
 * Parse ls-remote output and select the latest *annotated* four-part release
 * tag. An annotated tag is identified by its peeled `refs/tags/<tag>^{}` line,
 * whose SHA is the release commit; lightweight, malformed, and non-canonical
 * tags are ignored. Returns the highest version by canonical comparison, or null.
 */
export function selectLatestAnnotatedReleaseTag(stdout) {
    const peeled = new Map();
    for (const line of String(stdout).split('\n')) {
        const match = /^([a-f0-9]{40})\trefs\/tags\/(\S+?)(\^\{\})?$/.exec(line.trim());
        if (!match) continue;
        const [, sha, name, isPeeled] = match;
        if (!isPeeled) continue; // only the peeled line proves an annotated tag
        const version = name.startsWith('v') ? name.slice(1) : '';
        if (!isNassajReleaseVersion(version) || name !== `v${version}`) continue;
        peeled.set(version, sha);
    }
    let best = null;
    for (const [version, commit] of peeled) {
        if (best === null || compareNassajReleaseVersions(version, best.version) > 0) best = { version, commit };
    }
    return best;
}

/**
 * git-checkout-v2 release discovery (ADR-141, T-1569). Discovers the latest
 * annotated four-part tag from the configured update remote with `git ls-remote`
 * — working on a private source through the node's own git credentials and on a
 * public source with none — instead of the credential-free GitHub API, which
 * cannot read a private repository. Trust remains remote identity + tag->commit
 * + fast-forward + version match, all enforced later by the updater.
 */
export function createGitTagReleaseDiscovery({
    appRoot,
    env = process.env,
    remote = env.NASSAJ_UPDATE_REMOTE || 'origin',
    source = resolveReleaseSource(env),
    now = Date.now,
    ttlMs = positiveInteger(env.NASSAJ_RELEASE_DISCOVERY_TTL_MS, DEFAULT_TTL_MS, 60 * 60_000),
    timeoutMs = positiveInteger(env.NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60_000),
    lsRemote = defaultLsRemote,
} = {}) {
    if (!appRoot) throw new TypeError('Git tag release discovery requires appRoot');
    if (!SAFE_REMOTE.test(remote)) throw new Error('invalid_update_remote');
    let cache = null;
    let inFlight = null;

    const refresh = async () => {
        const result = await lsRemote({ appRoot, remote, env, timeoutMs });
        if (!result?.ok) {
            throw new ReleaseDiscoveryError('release_source_unavailable', 'The git release source is unavailable.');
        }
        const latest = selectLatestAnnotatedReleaseTag(result.stdout || '');
        if (!latest) {
            throw new ReleaseDiscoveryError('release_not_found',
                `No governed release tag is published in the configured release source (${source.identity}). `
                + 'Set NASSAJ_RELEASE_SOURCE to the repository that owns the releases, or update manually.', 404);
        }
        const tagName = `v${latest.version}`;
        const release = {
            releaseId: null,
            version: latest.version,
            tagName,
            commit: latest.commit,
            assetId: null,
            assetName: null,
            assetSize: null,
            assetSha256: null,
            title: tagName,
            notes: '',
            htmlUrl: `https://github.com/${source.owner}/${source.repo}/releases/tag/${encodeURIComponent(tagName)}`,
            publishedAt: null,
        };
        const value = { release };
        cache = { result: value, freshUntil: now() + ttlMs };
        return value;
    };

    return async function discoverRelease() {
        if (cache && now() < cache.freshUntil) return cache.result;
        if (inFlight) return inFlight;
        inFlight = refresh().finally(() => { inFlight = null; });
        return inFlight;
    };
}
