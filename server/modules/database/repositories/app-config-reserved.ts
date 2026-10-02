export const ENGINE_RESTAMP_INTENT_PREFIX = 'engine_restamp.v1:';
/** ADR-194 D1: `sso.disabled` lifts SSO enforcement; only the SSO repository writes it. */
export const SSO_RESERVED_PREFIX = 'sso.';
/** ADR-194 D3: `installation.origin` is owner-confirmed; only its service writes it. */
export const INSTALLATION_RESERVED_PREFIX = 'installation.';

/** Generic configuration writers must never mutate repository-owned namespaces. */
export function assertGenericAppConfigKey(key: string): void {
  if (key.startsWith(ENGINE_RESTAMP_INTENT_PREFIX) || key.startsWith(SSO_RESERVED_PREFIX)
    || key.startsWith(INSTALLATION_RESERVED_PREFIX)) {
    throw new Error('APP_CONFIG_RESERVED_PREFIX');
  }
}
