/**
 * WebAuthn relying-party configuration (B-PK-2).
 *
 * Read once at boot from the environment:
 *   - WEBAUTHN_RP_ID    relying party ID — the registrable domain the passkeys
 *                       are bound to (e.g. nassaj.example.com). No scheme,
 *                       no port.
 *   - WEBAUTHN_ORIGIN   expected origin(s) of the WebAuthn ceremony. Full
 *                       origin(s) including scheme; comma-separated list
 *                       supported (e.g. for a dev origin alongside production).
 *   - WEBAUTHN_RP_NAME  human-readable relying party name shown by browsers.
 *
 * Development fallback (no env set): rpID=localhost, origin=http://localhost:5173
 * — matches the Vite dev server. Passkeys registered against localhost will NOT
 * work on the deployed domain, hence the production boot warning below.
 */

const DEV_RP_ID = 'localhost';
const DEV_ORIGIN = 'http://localhost:5173';
const DEFAULT_RP_NAME = 'Nassaj';

/** Splits a comma-separated origin list, trimming entries and dropping blanks. */
function parseOriginList(value) {
  if (!value || typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || DEV_RP_ID;

export const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME || DEFAULT_RP_NAME;

/** Always an array — @simplewebauthn accepts string[] for expectedOrigin. */
const configuredOrigins = parseOriginList(process.env.WEBAUTHN_ORIGIN);
export const WEBAUTHN_ORIGINS =
  configuredOrigins.length > 0 ? configuredOrigins : [DEV_ORIGIN];

if (process.env.NODE_ENV === 'production' && !process.env.WEBAUTHN_RP_ID) {
  console.warn(
    '[webauthn] WEBAUTHN_RP_ID is not set in production — falling back to rpID=localhost. ' +
      'Passkeys will not work on the deployed domain. Set WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN ' +
      'and WEBAUTHN_RP_NAME in the environment (see .env.example, AUTH section).'
  );
}
