/**
 * Central fail-closed run profile for every Claude-body process.
 *
 * A Claude session's engine is server state, not a browser hint.  Every caller
 * that can launch or resume Claude must come through this module so the same
 * per-user env, engine pin, credential injection, and host allow-list reach the
 * child process.  Callers may add unrelated env values afterwards, but must not
 * rewrite ANTHROPIC_* routing values.
 */

import { ELIGIBLE_ENGINE_PROVIDERS } from '../../../shared/engineProviders.js';
import { auditLogDb, sessionAgentsDb, sessionsDb } from '../../modules/database/index.js';
import { providerModelsService } from '../../modules/providers/index.js';

import { applyClaudeEngineProviderEnvOrThrow } from './apply-claude-engine-provider-env.js';
import { assertAnthropicBaseUrlAllowed, assertSettingsEnvAllowed } from './anthropic-base-url-guard.js';
import { collectSettingsBaseUrls } from './collect-settings-base-urls.js';
import {
  OFFICIAL_ENGINE,
  PIN_SOURCE,
  enginePinEnforceEnabled,
  inferEngineFromHistory,
  resolveSpawnEngine,
} from './engine-pin.js';
import { resolveProviderEnv } from './resolve-provider-env.js';
import { resolveProviderEnvStrict } from './resolve-provider-env-strict.js';

/** Resolve the server-authoritative engine pin for a Claude-body spawn. */
export async function resolveClaudeSessionEngineForSpawn({
  sessionId,
  clientEngine,
  userId,
  authenticatedPrincipal,
  skipInference = false,
  failOnAmbiguous = false,
  failOnPinReadError = false,
  failOnIncompleteCatalog = false,
  failOnPinWriteError = false,
}) {
  const client = typeof clientEngine === 'string' && clientEngine.trim() !== ''
    ? clientEngine.trim()
    : null;
  if (!sessionId) {
    return { effectiveEngine: client, decision: 'client', storedEngine: null, inferred: null };
  }

  let storedEngine = null;
  try {
    storedEngine = sessionsDb.getSessionEnginePin(sessionId)?.engine ?? null;
  } catch (error) {
    console.warn(`[engine-pin] pin read failed for ${sessionId}: ${error?.message ?? error}`);
    if (failOnPinReadError) {
      const pinError = new Error('The resumed Claude session engine pin could not be read.');
      pinError.code = 'ENGINE_PIN_READ_FAILED';
      throw pinError;
    }
  }

  let inferred = null;
  let ambiguous = null;
  if (storedEngine === null && !skipInference) {
    try {
      const historyModelIds = [...new Set(
        sessionAgentsDb.listBySession(sessionId)
          .map((row) => row.agent_kind === 'model' ? (row.agent_model ?? row.agent_name) : row.agent_model)
          .filter((value) => typeof value === 'string' && value.trim() !== ''),
      )];
      if (historyModelIds.length > 0) {
        const engineCatalogs = {};
        const incompleteCatalogs = [];
        for (const engine of ELIGIBLE_ENGINE_PROVIDERS) {
          try {
            const { models } = await providerModelsService.getProviderModels(
              engine, {}, userId, authenticatedPrincipal,
            );
            const values = (models?.OPTIONS ?? []).map((option) => option?.value).filter(Boolean);
            if (models?.degraded === true) incompleteCatalogs.push(engine);
            else if (values.length > 0) engineCatalogs[engine] = values;
            else incompleteCatalogs.push(engine);
          } catch {
            incompleteCatalogs.push(engine);
          }
        }
        if (incompleteCatalogs.length > 0 && failOnIncompleteCatalog) {
          const error = new Error(
            `Engine pin inference requires complete catalogs; unavailable: ${incompleteCatalogs.join(', ')}.`,
          );
          error.code = 'ENGINE_PIN_CATALOG_INCOMPLETE';
          throw error;
        }
        if (incompleteCatalogs.length === 0 || !failOnIncompleteCatalog) {
          const hint = inferEngineFromHistory(historyModelIds, engineCatalogs);
          if (hint.kind === 'engine') {
            try {
              const write = sessionsDb.setSessionEnginePin(sessionId, hint.engine, PIN_SOURCE.INFERRED);
              if (!write || write.outcome === 'missing_row' || write.engine !== hint.engine) {
                throw new Error('The inferred engine pin was not persisted authoritatively.');
              }
              inferred = hint.engine;
            } catch (error) {
              if (failOnPinWriteError) {
                const writeError = new Error('The inferred Claude session engine pin could not be persisted.');
                writeError.code = 'ENGINE_PIN_WRITE_FAILED';
                writeError.cause = error;
                throw writeError;
              }
            }
          } else if (hint.kind === 'ambiguous') {
            ambiguous = hint.engines;
          }
        }
      }
    } catch (error) {
      if (
        (failOnIncompleteCatalog && error?.code === 'ENGINE_PIN_CATALOG_INCOMPLETE')
        || (failOnPinWriteError && error?.code === 'ENGINE_PIN_WRITE_FAILED')
      ) throw error;
      console.warn(`[engine-pin] inference failed for ${sessionId}: ${error?.message ?? error}`);
    }
  }

  const enforce = enginePinEnforceEnabled();
  if (ambiguous && (enforce || failOnAmbiguous)) {
    const error = new Error(
      `This session's history names models from more than one engine (${ambiguous.join(', ')}), `
      + 'so the engine it should run on cannot be determined safely.',
    );
    error.code = 'ENGINE_PIN_AMBIGUOUS';
    throw error;
  }

  const { engine, decision, mismatch } = resolveSpawnEngine({
    storedEngine: storedEngine ?? inferred,
    clientEngine: client,
    enforce,
  });
  if (mismatch || inferred || ambiguous) {
    auditLogDb.record('engine_pin_decision', {
      userId: typeof userId === 'number' ? userId : null,
      metadata: {
        sessionId,
        storedEngine,
        inferredEngine: inferred,
        ambiguousEngines: ambiguous,
        clientEngine: client,
        decision,
        enforce,
      },
    });
  }
  return { effectiveEngine: engine, decision, storedEngine, inferred };
}

/**
 * Build the complete, spawn-ready env and engine verdict for a Claude body.
 * `authoritativeStoredPin` is for non-browser resume paths: they have no valid
 * client engine signal, so a stored/inferred pin is honoured even during the
 * browser-enforcement shadow period.
 * @param {{userId:string|number|null,authenticatedPrincipal?:unknown,
 *   sessionId?:string|null,clientEngine?:string|null,
 *   baseEnv?:NodeJS.ProcessEnv,strictUser?:boolean,envAlreadyIsolated?:boolean,
 *   authoritativeStoredPin?:boolean,skipInferenceWhenUnknown?:boolean,
 *   requireKnownResumePin?:boolean,failOnAmbiguous?:boolean}} input
 */
export async function resolveClaudeRunProfileOrThrow({
  userId,
  authenticatedPrincipal,
  sessionId = null,
  clientEngine = null,
  baseEnv = process.env,
  strictUser = false,
  envAlreadyIsolated = false,
  authoritativeStoredPin = false,
  skipInferenceWhenUnknown = false,
  requireKnownResumePin = false,
  failOnAmbiguous = false,
}) {
  const env = envAlreadyIsolated
    ? { ...baseEnv }
    : { ...(strictUser
      ? resolveProviderEnvStrict(userId, 'claude', baseEnv)
      : resolveProviderEnv(userId, 'claude', baseEnv)) };

  const pin = await resolveClaudeSessionEngineForSpawn({
    sessionId,
    clientEngine,
    userId,
    authenticatedPrincipal,
    skipInference: skipInferenceWhenUnknown,
    failOnAmbiguous,
    failOnPinReadError: requireKnownResumePin,
    failOnIncompleteCatalog: requireKnownResumePin,
    failOnPinWriteError: requireKnownResumePin,
  });
  if (sessionId && requireKnownResumePin && pin.storedEngine === null && pin.inferred === null) {
    const error = new Error('The resumed Claude session has no authoritative engine pin.');
    error.code = 'ENGINE_PIN_UNKNOWN';
    throw error;
  }
  const effectiveEngine = authoritativeStoredPin
    ? (pin.storedEngine === OFFICIAL_ENGINE ? null : (pin.storedEngine ?? pin.inferred ?? pin.effectiveEngine))
    : pin.effectiveEngine;

  const engineHosts = applyClaudeEngineProviderEnvOrThrow(env, userId, effectiveEngine);
  assertSettingsEnvAllowed(env.CLAUDE_CONFIG_DIR, env);
  const settingsBaseUrls = await collectSettingsBaseUrls(env);
  assertAnthropicBaseUrlAllowed(env, {
    engineProviderHosts: engineHosts ?? undefined,
    extraValues: settingsBaseUrls,
  });

  return { env, effectiveEngine, engineHosts, pin };
}
