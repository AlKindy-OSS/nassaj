export const ENGINE_RESTAMP_INTENT_PREFIX = 'engine_restamp.v1:';

/** Generic configuration writers must never mutate repository-owned namespaces. */
export function assertGenericAppConfigKey(key: string): void {
  if (key.startsWith(ENGINE_RESTAMP_INTENT_PREFIX)) {
    throw new Error('APP_CONFIG_RESERVED_PREFIX');
  }
}
