/**
 * codex-local-run — the local-engine launch of a Codex chat (ADR-227 "Codex and
 * DSH bodies", T-2107), called from the one Codex spawn chokepoint
 * (openai-codex.js). Two steps, because the CLI version gate needs the launch
 * identity that is acquired between them:
 *
 *   1. codexLocalPathOrThrow — does this launch take the local path? (a session
 *      pinned to a local server, or a NEW chat naming a local model; a cloud chat
 *      asking for a local model is refused, never moved);
 *   2. resolveCodexLocalRunOrThrow — the spawn env (no OpenAI credential, the
 *      server key in its own variable), the per-server credential-free
 *      CODEX_HOME and the provider config, or a typed refusal.
 *
 * Nothing here runs for a cloud Codex chat.
 */

import { applyCodexLocalEngineEnvOrThrow } from './apply-codex-local-engine-env.js';
import { readCodexHookTrust } from './codex-hook-trust.js';
import { prepareCodexLocalHome } from './codex-local-home.js';
import { assertModelRunActor } from './credential-actor.js';
import { parseLocalEnginePin } from './local-engine-pin.js';
import { localEnginePathOrThrow } from './local-engine-pin-writer.js';
import { resolveProviderEnv } from './resolve-provider-env.js';

/**
 * Step 1. Null for a cloud launch; otherwise the session's stored engine.
 * @param {{ sessionId?: string|null, requestedModel?: string|null }} input
 * @returns {{ storedEngine: string|null }|null}
 * @throws {Error} ENGINE_PROVIDER_UNAVAILABLE (pin_conflict)
 */
export const codexLocalPathOrThrow = localEnginePathOrThrow;

/**
 * Step 2. The complete local launch, or a typed refusal (never a cloud fallback).
 * @param {{ userId: string|number|null|undefined, storedEngine: string|null,
 *   requestedModel?: string|null, cliVersion: string|null|undefined, codexBin: string,
 *   cwd: string, baseEnv?: NodeJS.ProcessEnv }} input `cliVersion` and `codexBin` are the
 *   launch identity's version and executable (the hook-trust read runs that CLI); `cwd`
 *   is the chat's working directory; `qualifyBareModel` is true when the chat's model
 *   was not explicitly re-picked (resolveLocalEngine)
 * @param {Record<string, Function>} [deps] test seam of applyCodexLocalEngineEnvOrThrow
 * @returns {Promise<{ env: NodeJS.ProcessEnv, config: Record<string, string|number|boolean>,
 *   local: import('./apply-claude-local-engine-env.js').LocalEngine }>}
 */
export async function resolveCodexLocalRunOrThrow(input, deps = {}) {
  const { userId, storedEngine, requestedModel = null, cliVersion, codexBin, cwd, qualifyBareModel = false } = input;
  const baseEnv = input.baseEnv ?? process.env;
  const env = { ...resolveProviderEnv(assertModelRunActor(userId), 'codex', baseEnv) };
  const storedPin = parseLocalEnginePin(storedEngine) ? storedEngine : null;
  const applied = await applyCodexLocalEngineEnvOrThrow(env, {
    userId, requestedModel, storedPin, cliVersion, qualifyBareModel: Boolean(storedPin) && qualifyBareModel,
  }, deps);
  if (!applied) throw Object.assign(new Error('The local engine path resolved no local engine.'), { code: 'ENGINE_PROVIDER_UNAVAILABLE' });
  env.CODEX_HOME = await prepareCodexLocalHome(env.CODEX_HOME, applied.local.serverId, {
    hookTrust: (codexHome) => readCodexHookTrust({ codexBin, codexHome, cwd }),
  });
  return { env, config: applied.config, local: applied.local };
}

/**
 * T-2107 qa high 7: the error item codex-cli emits for a model it has no catalog
 * entry for ("Model metadata for `<id>` not found ..."). Expected on every local
 * turn (the context window is set explicitly), so a local run logs it instead of
 * showing it as a red error.
 * @param {unknown} event SDK thread event
 * @returns {boolean}
 */
export function isModelMetadataNotice(event) {
  const item = /** @type {{type?: string, item?: {type?: string, message?: unknown}}} */ (event);
  return item?.type === 'item.completed' && item.item?.type === 'error'
    && typeof item.item.message === 'string' && /^Model metadata for `[^`]*` not found\./u.test(item.item.message);
}
