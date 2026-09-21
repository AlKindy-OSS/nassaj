import fs from 'fs';

const NASSAJ_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Create a reader for the canonical Nassaj version in package.json.
 *
 * The file identity is checked on every call, while JSON parsing is cached until
 * the file changes. This lets a running server report a newly opened development
 * cycle without a restart and avoids publishing malformed version values.
 */
export function createSourceVersionReader(packageJsonPath) {
    let cachedIdentity = null;
    let cachedVersion = null;

    return () => {
        try {
            const stat = fs.statSync(packageJsonPath);
            const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
            if (identity === cachedIdentity) return cachedVersion;

            const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))?.version;
            cachedIdentity = identity;
            cachedVersion = typeof version === 'string' && NASSAJ_VERSION_PATTERN.test(version)
                ? version
                : null;
            return cachedVersion;
        } catch {
            // A transient atomic replacement or malformed file must not fail /health.
            // Do not cache failures: the next request can recover immediately.
            return null;
        }
    };
}

/**
 * Express middleware that attaches the current source version to a health
 * response and prevents intermediaries from caching stale process state.
 */
export function createSourceVersionHealthMiddleware(packageJsonPath) {
    const readSourceVersion = createSourceVersionReader(packageJsonPath);

    return (_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.locals.sourceVersion = readSourceVersion();
        next();
    };
}
