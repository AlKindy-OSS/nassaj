/**
 * localEngine.ts — the LOCAL engine axis of the Claude body (ADR-227), shared by
 * the server and the client so both name a local engine and classify a local model
 * id identically.
 *
 * `local` is deliberately NOT in `ELIGIBLE_ENGINE_PROVIDERS` (engineProviders.ts):
 * a local server is per member and authorized by full origin, never inferred from
 * history, so it never rides the vendor-engine path.
 */

/** The bare engine id of the local axis; never in ELIGIBLE_ENGINE_PROVIDERS. */
export const LOCAL_ENGINE = 'local' as const;

/** Reserved provider namespace of local model servers (ADR-163 §4). */
export const LOCAL_MODEL_PROVIDER_PREFIX = 'nassaj_local_';

/**
 * True for a `nassaj_local_*` model id. Database-free, so any caller can classify
 * a request without loading the local-model store.
 */
export function isLocalModelId(model: unknown): model is string {
  return typeof model === 'string' && model.startsWith(LOCAL_MODEL_PROVIDER_PREFIX);
}
