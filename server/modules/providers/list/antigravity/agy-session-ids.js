// Dependency-free id shapes for antigravity sessions, shared by the adapter and
// the isolation layer (which must not pull the provider's isolation imports).

/** agy brain ids are lowercase UUIDs; anything else is never a brain id. */
export const AGY_BRAIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Spawn keys minted by agy-cli's generateNassajSessionId: `agy_<ms>_<base36>`. */
export const AGY_SPAWN_KEY_PATTERN = /^agy_\d+_[a-z0-9]+$/;
