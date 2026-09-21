import { readFileSync } from 'node:fs';

/** The OSS repository is the immutable release authority for every installation. */
const DEFAULT_PUBLIC_RELEASE_REPOSITORY_URL = 'https://github.com/AlKindy-OSS/nassaj';

/** Schema of the TOFU pin the node installer writes (ADR-156 هـ.2/هـ.3, WI-16). */
const RELEASE_SOURCE_LOCK_SCHEMA = 'nassaj-release-source-lock/v1';
/** A pin is four short fields; anything larger is not a pin this reader accepts. */
const RELEASE_SOURCE_LOCK_MAX_BYTES = 8 * 1024;

// A GitHub owner/repo segment must start with an alphanumeric or underscore and
// may not be composed only of dots — rejecting `.`, `..`, `...` and `.git`-style
// traversal or hidden-name segments that the character class alone would admit.
const SAFE_REPOSITORY_SEGMENT = /^(?![.-])(?!\.+$)[A-Za-z0-9_.-]+$/;

/** Normalize a credential-free GitHub repository URL to a stable identity. */
export function normalizeGitHubRepositoryIdentity(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    let match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
    if (!match) match = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
    if (!match) return null;
    if (!SAFE_REPOSITORY_SEGMENT.test(match[1]) || !SAFE_REPOSITORY_SEGMENT.test(match[2])) return null;
    return {
        owner: match[1],
        repo: match[2],
        identity: `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
    };
}

/**
 * Resolve the release source that this installation trusts (ADR-141, T-1563).
 *
 * `NASSAJ_RELEASE_SOURCE` lets an operator that tracks a private fork — or
 * publishes its own releases — point discovery and the remote-mismatch guard at
 * the repository that owns those releases, kept deliberately separate from
 * `NASSAJ_UPDATE_REMOTE` ("which local remote do I fetch from" vs "which
 * repository do I trust as the release authority"). The value must be a
 * credential-free GitHub repository URL (`https://github.com/<owner>/<repo>` or
 * `git@github.com:<owner>/<repo>`); a bare remote name or an embedded
 * `user:pass@` credential is rejected with a fail-closed `invalid_release_source`
 * boot error rather than silently falling back to the public source. Empty or
 * unset falls back to the immutable public OSS repository.
 *
 * `lockPath` (ADR-156 هـ.3) points at the installer's TOFU pin. The pin is not a
 * second source of the value — the value always comes from the environment that
 * PM2 loaded out of `config/node.env` — it only *attests* it. A pin that names a
 * different repository than the environment is a fail-closed stop, never a
 * silent preference for either side.
 */
export function resolveReleaseSource(env = process.env, { lockPath } = {}) {
    const configured = typeof env?.NASSAJ_RELEASE_SOURCE === 'string' ? env.NASSAJ_RELEASE_SOURCE.trim() : '';
    const repositoryUrl = configured || DEFAULT_PUBLIC_RELEASE_REPOSITORY_URL;
    const parsed = normalizeGitHubRepositoryIdentity(repositoryUrl);
    if (!parsed) throw new Error('invalid_release_source');
    const resolved = { ...parsed, repositoryUrl };
    const pinned = lockPath ? readReleaseSourceLock(lockPath) : null;
    if (pinned && pinned.identity !== resolved.identity) {
        const error = new Error('release_source_lock_mismatch');
        error.pinnedIdentity = pinned.identity;
        error.configuredIdentity = resolved.identity;
        throw error;
    }
    return pinned ? { ...resolved, pinnedIdentity: pinned.identity } : resolved;
}

/**
 * Read the TOFU pin, or `null` when the node was never pinned (an install that
 * predates WI-16). Present-but-unreadable is *not* absent: a truncated, foreign
 * or oversized pin fails closed with `release_source_lock_invalid`, because the
 * one thing a pin exists to prevent is a silent change of release authority.
 */
export function readReleaseSourceLock(lockPath, readFile = readFileSync) {
    let raw;
    try {
        raw = readFile(lockPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        const failure = new Error('release_source_lock_invalid');
        failure.cause = error;
        throw failure;
    }
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > RELEASE_SOURCE_LOCK_MAX_BYTES) {
        throw new Error('release_source_lock_invalid');
    }
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('release_source_lock_invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schema !== RELEASE_SOURCE_LOCK_SCHEMA
        || typeof value.pinnedAt !== 'string' || !value.pinnedAt
        || typeof value.confirmedBy !== 'string' || !value.confirmedBy) {
        throw new Error('release_source_lock_invalid');
    }
    // The pinned identity is re-derived rather than trusted as text, so a pin can
    // never name a repository the normalizer itself would have refused.
    const parsed = normalizeGitHubRepositoryIdentity(value.repositoryUrl);
    if (!parsed || parsed.identity !== value.identity) throw new Error('release_source_lock_invalid');
    return {
        identity: parsed.identity,
        repositoryUrl: value.repositoryUrl,
        pinnedAt: value.pinnedAt,
        confirmedBy: value.confirmedBy,
    };
}

export { DEFAULT_PUBLIC_RELEASE_REPOSITORY_URL, RELEASE_SOURCE_LOCK_SCHEMA };
