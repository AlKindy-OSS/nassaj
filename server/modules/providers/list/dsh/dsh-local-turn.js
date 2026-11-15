/**
 * dsh-local-turn — the local-engine half of a DeepSeek Harness turn (ADR-227 "DSH
 * local corrector", T-2108), called from the one dsh spawn site
 * (dsh-acp-runtime.js) in three steps, each failing closed before any process:
 *
 *   1. dshLocalPath — does this turn take the local path? (a chat pinned to a
 *      local server, or a NEW chat naming a local model; a cloud chat asking for a
 *      local model is refused, never moved, and a local chat never moves to cloud);
 *   2. prepareDshLocalLaunch — the launch seam without the deepseek credential, and
 *      the vetted local engine (switch, own server, literal address, context fit,
 *      the version gate bound to the exact dsh entry this launch runs);
 *   3. openDshLocalTurn — only after Claude's prompt hooks admitted the turn: the
 *      turn's corrector, its generated layer and the final env (token, no key).
 *      `close()` removes the layer and closes the corrector; the runtime calls it
 *      when the run exits and on every failure after step 3.
 */

import { resolveDshLocalEngineOrThrow } from '../../../../services/isolation/apply-dsh-local-engine-env.js';
import { openDshLocalCorrector } from '../../../../services/isolation/dsh-local-corrector.js';
import { localEnginePathOrThrow } from '../../../../services/isolation/local-engine-pin-writer.js';

import { assertDshOverrideSemantics } from './dsh-dump-config-check.js';
import { dshInstalledVersion, finalizeDshLocalLaunch, prepareDshLaunch } from './dsh-launch.js';
import { buildDshLocalLayer, dshLocalRunsRoot, removeDshLocalRun, writeDshLocalLayer } from './dsh-local-layer.js';

/**
 * Step 1. Null for a cloud turn; otherwise the session's stored engine.
 * @param {{ requested: string|null }} input
 * @param {string|null|undefined} model the requested model
 * @returns {{ storedEngine: string|null }|null}
 * @throws {Error} ENGINE_PROVIDER_UNAVAILABLE (pin_conflict)
 */
export function dshLocalPath(input, model) {
  return localEnginePathOrThrow({ sessionId: input.requested, requestedModel: model ?? null });
}

/**
 * Step 2. The local launch (no spawnable env yet) and its vetted engine.
 * @param {{ userId: unknown, storedEngine: string|null, requestedModel: string|null,
 *   recordedModel?: string|null }} input `recordedModel`: the chat's recorded local model
 * @param {{ serverEnv?: NodeJS.ProcessEnv, localDeps?: Record<string, Function> }} [deps]
 * @returns {Promise<{ launch: ReturnType<typeof prepareDshLaunch>,
 *   resolved: { local: import('../../../../services/isolation/apply-claude-local-engine-env.js').LocalEngine, secret: string } }>}
 */
export async function prepareDshLocalLaunch({ userId, storedEngine, requestedModel, recordedModel = null }, deps = {}) {
  const launch = prepareDshLaunch({ userId }, { local: true, serverEnv: deps.serverEnv });
  const resolved = await resolveDshLocalEngineOrThrow({
    userId, requestedModel, recordedModel, storedPin: storedEngine, cliVersion: dshInstalledVersion(launch.script),
  }, deps.localDeps);
  if (!resolved) throw Object.assign(new Error('The local engine path resolved no local engine.'), { code: 'ENGINE_PROVIDER_UNAVAILABLE' });
  return { launch, resolved };
}

/**
 * Step 3. Opens the turn's corrector, writes its layer and completes the launch.
 * @param {{ launch: ReturnType<typeof prepareDshLaunch>, resolved: { local: object, secret: string }, runId: string }} input
 * @param {{ serverEnv?: NodeJS.ProcessEnv, runsRoot?: string, openCorrector?: typeof openDshLocalCorrector }} [deps]
 *   `openCorrector` is a test seam
 * @returns {Promise<{ launch: ReturnType<typeof prepareDshLaunch>, token: string, close: () => Promise<void> }>}
 */
export async function openDshLocalTurn({ launch, resolved, runId }, deps = {}) {
  const { local, secret } = resolved;
  const corrector = await (deps.openCorrector ?? openDshLocalCorrector)({ connectOrigin: local.connectOrigin, secret });
  let dir = null;
  try {
    const rows = buildDshLocalLayer(launch.layerText, {
      baseURL: corrector.origin, model: local.model, contextWindow: local.contextWindow,
      maxTokens: local.outputTokens, pluginEntry: launch.pluginEntry,
    });
    const written = writeDshLocalLayer(rows, { root: deps.runsRoot ?? dshLocalRunsRoot(), runId });
    dir = written.dir;
    const serverEnv = deps.serverEnv ?? process.env;
    const final = finalizeDshLocalLaunch(launch, { token: corrector.token, layerPath: written.file, serverEnv });
    assertDshOverrideSemantics(final, serverEnv, { localBaseURL: corrector.origin });
    let closing = null;
    const close = () => {
      closing ??= Promise.resolve().then(() => removeDshLocalRun(written.dir)).finally(() => corrector.close());
      return closing;
    };
    return { launch: final, token: corrector.token, close };
  } catch (error) {
    if (dir) removeDshLocalRun(dir);
    await corrector.close();
    throw error;
  }
}

/**
 * The model id the turn records (cost attribution: the reserved local namespace
 * books it to `local`), and the bare id DSH selects.
 * @param {{ providerId: string, model: string }} local
 * @returns {{ recorded: string, selected: string }}
 */
export function dshLocalModelIds(local) {
  return { recorded: `${local.providerId}/${local.model}`, selected: local.model };
}
