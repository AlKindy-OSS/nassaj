/** Canonical runtime bodies that every personal connector must reconcile to. */
export const CONNECTOR_ROLLOUT_BODY_PROVIDERS = Object.freeze([
  'claude',
  'codex',
] as const);
