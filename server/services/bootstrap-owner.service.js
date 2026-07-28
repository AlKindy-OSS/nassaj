/**
 * Bootstrap owner service.
 *
 * On first run against a database with no `owner`, creates the initial owner
 * account so the system is administrable. Idempotent: once any owner exists,
 * this is a no-op on every subsequent boot.
 *
 * Credential source (in priority order):
 *   1. BOOTSTRAP_OWNER_USERNAME + BOOTSTRAP_OWNER_PASSWORD env vars (recommended).
 *   2. BOOTSTRAP_OWNER_USERNAME only → a strong random password is generated and
 *      printed ONCE to stdout (operator must record it and rotate after login).
 *   3. Neither set → defaults username to "owner" with a generated password.
 *
 * The generated password is the only thing printed; it is never persisted in
 * plaintext nor written to the audit log.
 */

import crypto from 'crypto';

import { userDb, auditLogDb } from '../modules/database/index.js';

import { hashPassword } from './password.service.js';

const MIN_PASSWORD_LENGTH = 12;

function generatePassword() {
  // 24 url-safe chars → ~144 bits of entropy.
  return crypto.randomBytes(18).toString('base64url');
}

function validateProvidedPassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `BOOTSTRAP_OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`
    );
  }
}

/**
 * Ensures an owner exists. Returns a summary describing the action taken.
 * @returns {Promise<{ created: boolean, username?: string, generatedPassword?: string }>}
 */
export async function ensureOwnerBootstrapped() {
  if (userDb.getOwnerCount() > 0) {
    return { created: false };
  }

  const username = (process.env.BOOTSTRAP_OWNER_USERNAME || 'owner').trim();
  if (username.length < 3) {
    throw new Error('BOOTSTRAP_OWNER_USERNAME must be at least 3 characters');
  }

  let password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  let generated = false;
  if (password) {
    validateProvidedPassword(password);
  } else {
    password = generatePassword();
    generated = true;
  }

  const passwordHash = await hashPassword(password);
  const user = userDb.createUser(username, passwordHash, 'owner', null);

  auditLogDb.record('bootstrap_owner', {
    userId: user.id,
    metadata: { username, passwordSource: generated ? 'generated' : 'env' },
  });

  if (generated) {
    // Printed once; operator must capture this. Not stored anywhere.
    console.log(
      '\n========================================================\n' +
        '  BOOTSTRAP OWNER CREATED\n' +
        `  username: ${username}\n` +
        `  password: ${password}\n` +
        '  Record this now and change it after first login.\n' +
        '========================================================\n'
    );
  } else {
    console.log(`Bootstrap owner created from env: username=${username}`);
  }

  return generated
    ? { created: true, username, generatedPassword: password }
    : { created: true, username };
}
