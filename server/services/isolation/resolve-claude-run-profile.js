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
import {
  LOCAL_ENGINE_ENV_KEYS,
  LOCAL_ENGINE_PRIVATE_ENTRIES,
  applyClaudeLocalEngineEnvOrThrow,
  takesLocalEnginePath,
} from './apply-claude-local-engine-env.js';
import { assertClaudeSpawnEnvAllowed } from './claude-spawn-env-guard.js';
import { localEngineDerivedDirName, prepareEnginePinConfigDir } from './engine-pin-config-dir.js';
import { LOCAL_ENGINE, parseLocalEnginePin } from './local-engine-pin.js';
import { assertLinkModeRunAllowed } from './link-mode-run-gate.js';
import {
  OFFICIAL_ENGINE,
  PIN_SOURCE,
  enginePinEnforceEnabled,
  inferEngineFromHistory,
  resolveSpawnEngine,
} from './engine-pin.js';
import { assertModelRunActor } from './credential-actor.js';
import { assertCredentialLinked } from './credential-gate.js';
import { resolveProviderEnv } from './resolve-provider-env.js';

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
 * ADR-200 S2 (C1/D7): a pinned child runs on a derived, credential-free config
 * dir built from the spawn's own (or, under a grant, the grantor's) tree, so a
 * user-scope Anthropic key cannot reach the vendor. The B-1541 guard that runs
 * next still vets that dir, the spawn env and the managed/project/local
 * settings. A non-pinned env is left untouched.
 * @param {NodeJS.ProcessEnv} env mutated in place
 * @param {Set<string>|null} engineHosts the engine verdict
 * @returns {Promise<void>}
 */
async function useEnginePinConfigDir(env, engineHosts) {
  if (engineHosts instanceof Set && engineHosts.size > 0) {
    env.CLAUDE_CONFIG_DIR = await prepareEnginePinConfigDir(env);
  }
}

/**
 * ADR-227: the local-engine run profile. Server state wins over the client and
 * over the shadow-mode switch: a local-pinned session never runs anywhere else.
 * The child runs on a per-server credential-free config dir whose settings env
 * cannot override the routing or model knobs set here.
 */
async function resolveLocalClaudeRunProfile({
  actor, userId, pin, requestedModel, baseEnv, envAlreadyIsolated, honorGrants, cwd, localEngineDeps,
}) {
  const credential = honorGrants
    ? assertCredentialLinked({ actor, provider: 'claude', mode: 'agent', engine: LOCAL_ENGINE, model: requestedModel })
    : { principalId: actor, grantedBy: null };
  const env = envAlreadyIsolated ? { ...baseEnv } : { ...resolveProviderEnv(actor, 'claude', baseEnv) };
  const storedPin = parseLocalEnginePin(pin.storedEngine) ? pin.storedEngine : null;
  const applied = await applyClaudeLocalEngineEnvOrThrow(env, { userId, requestedModel, storedPin }, localEngineDeps);
  env.CLAUDE_CONFIG_DIR = await prepareEnginePinConfigDir(env, {
    derivedName: localEngineDerivedDirName(applied.local.serverId),
    stripEnvKeys: LOCAL_ENGINE_ENV_KEYS,
    privateEntries: LOCAL_ENGINE_PRIVATE_ENTRIES,
  });
  await assertClaudeSpawnEnvAllowed(env, {
    engineHosts: applied.engineHosts, engineOrigins: applied.engineOrigins, cwd,
  });
  return {
    env,
    effectiveEngine: applied.local.pin,
    engineHosts: applied.engineHosts,
    engineOrigins: applied.engineOrigins,
    local: applied.local,
    pin,
    credential,
  };
}

/**
 * Build the complete, spawn-ready env and engine verdict for a Claude body.
 * `authoritativeStoredPin` is for non-browser resume paths: they have no valid
 * client engine signal, so a stored/inferred pin is honoured even during the
 * browser-enforcement shadow period.
 * The credential gate (ADR-152 A1 §3.5) runs here once the engine is known, so
 * a vendor-engine run is admitted on that engine's key and an official run on
 * the Claude tree. PTY terminals (`honorGrants: false`) are not gated: they run
 * on the caller's own tree, and linking happens there.
 * @param {{userId:string|number|null,authenticatedPrincipal?:unknown,
 *   sessionId?:string|null,clientEngine?:string|null,
 *   baseEnv?:NodeJS.ProcessEnv,envAlreadyIsolated?:boolean,
 *   authoritativeStoredPin?:boolean,skipInferenceWhenUnknown?:boolean,
 *   requireKnownResumePin?:boolean,failOnAmbiguous?:boolean,
 *   honorGrants?:boolean,cwd?:string|null}} input `honorGrants: false` marks an
 *   env built on the caller's OWN tree (PTY terminals), so the link-mode gate
 *   (B-1546) reads that tree instead of a grantor's. `cwd` is the child's working directory; the
 *   engine credential check (B-1541) reads project/local settings there and
 *   falls back to this process's cwd, which a spawn without `cwd` inherits.
 *   `requestedModel` is the client's RAW model id (before the Claude catalog
 *   coerces it): a `nassaj_local_*` id selects the local-engine path (ADR-227).
 *   `localEngineDeps` is a test seam for applyClaudeLocalEngineEnv.
 *   A local-engine profile also returns `engineOrigins` and `local`; its
 *   `engineHosts` is an EMPTY set (engaged, but no host-only authorization).
 */
export async function resolveClaudeRunProfileOrThrow({
  userId,
  authenticatedPrincipal,
  sessionId = null,
  clientEngine = null,
  baseEnv = process.env,
  envAlreadyIsolated = false,
  authoritativeStoredPin = false,
  skipInferenceWhenUnknown = false,
  requireKnownResumePin = false,
  failOnAmbiguous = false,
  honorGrants = true,
  cwd = null,
  requestedModel = null,
  localEngineDeps = undefined,
}) {
  // A model run names a member; null and the system actor never get this far.
  const actor = assertModelRunActor(userId);

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
  if (takesLocalEnginePath({ sessionId, storedEngine: pin.storedEngine, requestedModel, clientEngine })) {
    return resolveLocalClaudeRunProfile({
      actor, userId, pin, requestedModel, baseEnv, envAlreadyIsolated, honorGrants, cwd, localEngineDeps,
    });
  }
  const effectiveEngine = authoritativeStoredPin
    ? (pin.storedEngine === OFFICIAL_ENGINE ? null : (pin.storedEngine ?? pin.inferred ?? pin.effectiveEngine))
    : pin.effectiveEngine;

  // ADR-152 A1 §3.5: admitted on a present credential, or refused before any env.
  const credential = honorGrants
    ? assertCredentialLinked({ actor, provider: 'claude', mode: 'agent', engine: effectiveEngine })
    : { principalId: actor, grantedBy: null };
  const env = envAlreadyIsolated
    ? { ...baseEnv }
    : { ...resolveProviderEnv(actor, 'claude', baseEnv) };

  const engineHosts = applyClaudeEngineProviderEnvOrThrow(env, userId, effectiveEngine);
  // B-1546: an official-vendor run in api_key link mode with no key is refused
  // here, before any spawn, so it never falls back to the subscription. An
  // engine-pinned run uses the engine's credential on a credential-free config
  // dir (C1), so the Anthropic link mode does not apply to it.
  if (!(engineHosts instanceof Set && engineHosts.size > 0)) await assertLinkModeRunAllowed(userId, 'claude', { honorGrants });
  await useEnginePinConfigDir(env, engineHosts);
  await assertClaudeSpawnEnvAllowed(env, { engineHosts, cwd });

  return { env, effectiveEngine, engineHosts, engineOrigins: null, local: null, pin, credential };
}
