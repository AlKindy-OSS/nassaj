/**
 * Node overlay extension point E3 — the code-defined allowlist of NON-SECRET,
 * NON-PRIVILEGED environment keys the server loads from `config/node.env` at
 * boot, before any spawn (ADR-156 §3.4 step 1, owner decision 8).
 *
 * The list is pinned in code, not in the file: today it holds `TMPDIR` alone.
 * A key outside it is ignored, so a compromised or careless `config/node.env`
 * can never inject `NODE_OPTIONS`, a secret, or the release source — those never
 * travel through node.env (NASSAJ_RELEASE_SOURCE is pinned separately and
 * guarded by remote_mismatch; secrets stay in `.env`). Widening the allowlist
 * needs an ADR.
 *
 * Load semantics mirror `load-env.js`: a key is filled ONLY when it is currently
 * absent from the live environment, so a value already set by the process
 * manager or the shell always wins. Nothing here ever logs a value.
 */
import fs from 'fs';

/** The single non-secret, non-privileged key. Adding one requires an ADR. */
export const NODE_ENV_ALLOWLIST = Object.freeze(['TMPDIR']);

/**
 * Parse a KEY=VALUE `.env`-style buffer, keeping only allowlisted keys.
 * @param {string} contents raw file contents
 * @param {readonly string[]} [allowlist]
 * @returns {Map<string, string>} allowlisted key → value
 */
export function parseAllowlistedEnv(contents, allowlist = NODE_ENV_ALLOWLIST) {
    const allowed = new Set(allowlist);
    const out = new Map();
    if (typeof contents !== 'string') return out;
    for (const rawLine of contents.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!allowed.has(key)) continue;
        out.set(key, line.slice(eq + 1).trim());
    }
    return out;
}

/**
 * Load `config/node.env`'s allowlisted keys into `env`, filling only keys that
 * are currently absent (the live environment wins). Never throws: a missing or
 * unreadable file leaves the environment untouched.
 *
 * @param {object} [options]
 * @param {string} options.configPath absolute path to `config/node.env`
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {readonly string[]} [options.allowlist]
 * @returns {{ loaded: string[], skipped: string[] }} key NAMES only, never values
 */
export function loadNodeEnvAllowlist({ configPath, env = process.env, allowlist = NODE_ENV_ALLOWLIST } = {}) {
    const result = { loaded: [], skipped: [] };
    if (typeof configPath !== 'string' || configPath.length === 0) return result;
    let contents;
    try {
        contents = fs.readFileSync(configPath, 'utf8');
    } catch {
        return result; // absent/unreadable → optional config, environment untouched
    }
    for (const [key, value] of parseAllowlistedEnv(contents, allowlist)) {
        if (env[key] === undefined) {
            env[key] = value;
            result.loaded.push(key);
        } else {
            result.skipped.push(key);
        }
    }
    return result;
}
