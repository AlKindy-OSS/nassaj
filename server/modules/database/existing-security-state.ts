import type { Database } from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- read-only admission probe reuses the canonical alias classifier. */
import { probeSessionWorkspaceAlias } from '../session-workspaces/session-workspace-overlay.js';
/* eslint-enable boundaries/dependencies */

type AliasProbe = (input: { projectPath: string; sessionId: string }) => string;
type Environment = Readonly<Record<string, string | undefined>>;

/** Validate existing startup prerequisites without opening a singleton or creating secrets/flags. */
export function inspectExistingSecurityState(database: Database, environment: Environment,
  probeAlias: AliasProbe = probeSessionWorkspaceAlias): Readonly<{ policyId: 'existing-security-state/v1' }> {
  if (environment.NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW === '1') {
    throw new Error('existing_security_universal_shadow_requires_initialization');
  }
  const appConfig = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get('app_config');
  if (!appConfig) throw new Error('existing_security_app_config_missing');
  const environmentSecret = environment.JWT_SECRET;
  if (environmentSecret) {
    if (environmentSecret.length < 32) throw new Error('existing_security_jwt_invalid');
  } else {
    const storedSecret = database.prepare('SELECT 1 FROM app_config WHERE key = ? AND typeof(value) = ? AND length(value) >= ?')
      .get('jwt_secret', 'text', 32);
    if (!storedSecret) throw new Error('existing_security_jwt_missing_or_invalid');
  }
  if (!database.prepare('SELECT 1 FROM users WHERE role = ? LIMIT 1').get('owner')) {
    throw new Error('existing_security_owner_missing');
  }
  if (!database.prepare('SELECT 1 FROM (SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1) WHERE typeof(public_key) = ? AND length(public_key) > 0 AND typeof(private_key) = ? AND length(private_key) > 0').get('text', 'text')) {
    throw new Error('existing_security_vapid_missing');
  }
  const aliases = database.prepare('SELECT session_id AS sessionId, project_path AS projectPath FROM session_workspace_modes WHERE mode = ?')
    .all('legacy_shared') as Array<{ sessionId: string; projectPath: string }>;
  for (const alias of aliases) {
    let state: string;
    try { state = probeAlias(alias); }
    catch { throw new Error('existing_security_overlay_ratchet_required'); }
    if (state !== 'absent') throw new Error('existing_security_overlay_ratchet_required');
  }
  return Object.freeze({ policyId: 'existing-security-state/v1' });
}
