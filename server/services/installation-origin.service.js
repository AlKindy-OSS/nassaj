/**
 * Owner-confirmed installation origin for SSO (ADR-194 D3 / I8, T-1962 S3).
 *
 * The SSO redirect URI is `<installation origin>/api/auth/oidc/callback`,
 * computed when the draft is saved and copied at apply; it is never derived
 * from Host or X-Forwarded-*. The origin comes from:
 *   1. the connector installation-origin store (ADR-193), when the connector
 *      substrate is initialized on this node and holds a persisted origin; the
 *      substrate registers its live reader here at boot;
 *   2. otherwise the minimal owner-confirmed `installation.origin` record in
 *      app_config, validated by the same ADR-193 validator.
 * Nodes whose connector substrate is not initialized have no writable origin
 * store (its write path runs under the substrate's fenced lease), which is why
 * the app_config record exists. Once the connector store holds an origin it
 * is the only source, and confirming here is refused.
 */
import { getConnection } from '../modules/database/connection.js';
// Namespace import: tests replace this repository with partial mocks, and a
// named import of an absent binding would fail at link time.
import * as auditLogRepository from '../modules/database/repositories/audit-log.js';
import { canonicalInstallationOrigin } from '../modules/connectors/connector-installation-origin-resolver.js';

import { SSO_CALLBACK_PATH } from './sso-config-record.js';

export const INSTALLATION_ORIGIN_CONFIG_KEY = 'installation.origin';

/** @type {(() => string | null) | null} */
let connectorOriginReader = null;

export class InstallationOriginError extends Error {
  constructor(code) {
    super(code);
    this.name = 'InstallationOriginError';
    this.code = code;
  }
}

const allowLoopback = () => process.env.NODE_ENV !== 'production';

/** Called once by the connector substrate with its database-only live origin reader. */
export function registerConnectorInstallationOriginReader(reader) {
  connectorOriginReader = typeof reader === 'function' ? reader : null;
}

function connectorOrigin() {
  try {
    return connectorOriginReader?.() ?? null;
  } catch {
    return null;
  }
}

/** The app_config record, re-validated on read; a tampered value reads as null. */
function recordedOrigin(db) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(INSTALLATION_ORIGIN_CONFIG_KEY);
  if (!row) return null;
  try {
    const origin = canonicalInstallationOrigin(row.value, allowLoopback());
    return origin === row.value ? origin : null;
  } catch {
    return null;
  }
}

/** The owner-confirmed installation origin, or null when none is confirmed or readable. */
export function confirmedInstallationOrigin() {
  const fromConnectors = connectorOrigin();
  if (fromConnectors !== null) return fromConnectors;
  try {
    return recordedOrigin(getConnection());
  } catch {
    return null;
  }
}

/**
 * Owner confirms the origin on a node without a connector origin (service
 * half; the owner-only route with step-up is S4). Strict audit in the same
 * transaction. Throws InstallationOriginError.
 * @param {{ origin: string, actorUserId: number }} input
 * @returns {string} the canonical origin
 */
export function confirmInstallationOrigin({ origin, actorUserId }) {
  if (connectorOrigin() !== null) throw new InstallationOriginError('installation_origin_managed_by_connectors');
  let canonical;
  try {
    canonical = canonicalInstallationOrigin(origin, allowLoopback());
  } catch {
    throw new InstallationOriginError('installation_origin_invalid');
  }
  if (canonical !== origin) throw new InstallationOriginError('installation_origin_invalid');
  const db = getConnection();
  db.transaction(() => {
    const replaced = recordedOrigin(db) !== null;
    db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(INSTALLATION_ORIGIN_CONFIG_KEY, canonical);
    auditLogRepository.recordStrictAuditOnConnection(db, 'installation_origin_confirmed', {
      userId: actorUserId, metadata: { replaced },
    });
  }).immediate();
  return canonical;
}

/** The redirect URI a draft save stores (D3), or null while no origin is confirmed. */
export function ssoRedirectUriForDraft() {
  const origin = confirmedInstallationOrigin();
  return origin === null ? null : `${origin}${SSO_CALLBACK_PATH}`;
}

/**
 * I8 status of a stored (pinned) redirect URI against the confirmed origin:
 * 'ok', 'redirect_origin_mismatch' (login keeps the stored value; the owner
 * must re-test and re-apply), or 'installation_origin_unconfirmed'.
 */
export function ssoRedirectOriginStatus(storedRedirectUri) {
  const origin = confirmedInstallationOrigin();
  if (origin === null) return 'installation_origin_unconfirmed';
  let storedOrigin = null;
  try {
    storedOrigin = new URL(storedRedirectUri).origin;
  } catch {
    return 'redirect_origin_mismatch';
  }
  return storedOrigin === origin ? 'ok' : 'redirect_origin_mismatch';
}
