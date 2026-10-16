/**
 * Owner break-glass: clear an account's login-throttle lock offline
 * (T-2035, ADR-212).
 *
 * A third party who knows a username can re-lock its password sign-in each
 * time a lock ends (5 failures → up to 30 minutes, again and again). Passkey
 * and SSO sign-in are never throttled, and an owner who can still sign in
 * uses POST /api/auth/users/:id/login-unlock. This script is the last resort
 * for an operator with shell access to the host: it opens the application
 * database (DATABASE_PATH from the environment or the app's .env), derives
 * the throttle keys from the service JWT secret (never printed), deletes every
 * throttle row of the account and records `login_unlocked` (via: 'cli').
 *
 * Usage (from the app root, as the service user):
 *   npx tsx --tsconfig server/tsconfig.json server/scripts/unlock-login.ts --user <username|id>
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export type UnlockResult = Readonly<{ userId: number; cleared: number }>;

/** Exit codes: 0 done, 2 usage, 3 no such account, 4 not configured. */
export class UnlockLoginError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'UnlockLoginError';
  }
}

/**
 * Clears every throttle row of one account. Opens the database through the
 * application's own connection (DATABASE_PATH), so callers set the
 * environment first. Never creates a JWT secret: without one there is nothing
 * the throttle could have keyed.
 */
export async function unlockLogin(user: string): Promise<UnlockResult> {
  const database = await import('../modules/database/index.js');
  const { createLoginThrottle, unlockAccountLogin } = await import('../services/login-throttle.service.js');
  const secret = process.env.JWT_SECRET || database.appConfigDb.get('jwt_secret');
  if (!secret) throw new UnlockLoginError('No JWT secret is configured; nothing to unlock', 4);
  const table = database.getConnection()
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='login_throttle'").get();
  if (!table) throw new UnlockLoginError('login_throttle does not exist yet; start the server once', 4);

  const trimmed = user.trim();
  const row = /^\d+$/.test(trimmed)
    ? database.userDb.getRawById(Number(trimmed))
    : database.userDb.getUserByLoginIdentifier(trimmed);
  if (!row) throw new UnlockLoginError('No such account', 3);
  const identifiers = database.userDb.listLoginIdentifiers(row.id);
  const cleared = unlockAccountLogin(createLoginThrottle({ secret }), { userId: row.id, identifiers });
  database.auditLogDb.record('login_unlocked', { metadata: { targetUserId: row.id, cleared, via: 'cli' } });
  return Object.freeze({ userId: row.id, cleared });
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { user: { type: 'string' } }, strict: true });
  if (!values.user) {
    process.stderr.write('usage: unlock-login.ts --user <username|id>\n');
    return 2;
  }
  await import('../load-env.js');
  try {
    const result = await unlockLogin(values.user);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UnlockLoginError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  } finally {
    (await import('../modules/database/index.js')).closeConnection();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`unlock-login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
