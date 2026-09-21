import os from 'node:os';
import path from 'node:path';

/**
 * The single source of truth for where the backend stores its SQLite database
 * when DATABASE_PATH is not set explicitly. Kept in one place so load-env.js and
 * every consumer (including the source-update database snapshot) agree on the
 * default — a stable user-level location that never moves when dist-server is
 * rebuilt.
 */
export const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');

/** Resolve the application database file path from the environment or the default. */
export function resolveDatabaseFilePath(env = process.env) {
    return env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : DEFAULT_DATABASE_PATH;
}
