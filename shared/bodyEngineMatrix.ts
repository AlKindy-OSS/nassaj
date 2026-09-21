/**
 * bodyEngineMatrix.ts — the BODY × ENGINE compatibility matrix (ADR-073).
 *
 * ADR-073 splits one flat provider list into two orthogonal axes:
 *
 *   • **body**   — a harness that owns the tools, permissions, MCP and sessions
 *                  (`shared/disabledProviders.ts` governs which are selectable).
 *   • **engine** — an HTTP endpoint that generates the tokens and nothing else
 *                  (`shared/engineProviders.ts` governs which may drive Claude).
 *
 * A run is `{ body, engine, model }`. Those two files each answer one axis; this
 * one answers the question that only exists because the axes are orthogonal —
 * *which pairs are real, and for the ones that are not, whose barrier is it?*
 *
 * WHY IT IS DECLARED RATHER THAN DERIVED: none of these cells can be computed
 * from the code. "Moonshot answers 404 on /v1/responses" and "z.ai has no
 * Responses API" are facts about other people's servers, established by running
 * against them on 2026-07-27. Deriving a matrix from what our code happens to
 * support would report our own wiring back to us and call it a capability —
 * which is exactly how "GLM is connected" came to be displayed for a path that
 * had never returned a token.
 *
 * EVIDENCE IS PART OF THE DATA, NOT A COMMENT. ADR-073 keeps `[مقيس]` (measured)
 * strictly apart from `[مستنتَج]` (inferred from a vendor's docs or a binary's
 * strings, with nothing run). Every cell below carries that distinction so the
 * UI can never present an inference as a demonstration. A cell with no evidence
 * is `unverified` and says so.
 *
 * This file sits in the top-level `shared/` tree — the one tree compiled into
 * BOTH bundles (server tsconfig includes `../shared/**`; the Vite root is the
 * project root) — for the same reason `engineProviders.ts` does: a client and a
 * server that disagree about which pairs exist is the drift that produced B-217
 * and B-218.
 *
 * SOURCE OF TRUTH: `docs/decisions/073-body-engine-orthogonal-model.md` and
 * `docs/design/body-engine-orthogonal-model-2026-07-27.md` §3–§4, §10. When a
 * cell changes there, change it here; `bodyEngineMatrix.test.ts` pins the
 * invariants that must hold whatever the cells say.
 */

// `.js` extension: this file is compiled by BOTH tsconfigs, and the server one
// resolves as NodeNext (extension required). Bundler resolution on the client
// side accepts the same specifier, so one spelling serves both trees.
import {
  ENGINE_ANTHROPIC_ENDPOINT,
  isEngineProviderEligible,
  type EngineProviderId,
} from './engineProviders.js';

/** Engines as an axis: the three with an Anthropic-compatible endpoint, plus the
 *  two that only ever appear as a body's own engine or an OpenAI-wire catalog. */
export const ENGINE_AXIS_IDS = Object.freeze([
  'anthropic',
  'glm',
  'kimi',
  'deepseek',
  'zen',
  'local',
] as const);

export type EngineAxisId = (typeof ENGINE_AXIS_IDS)[number];

/** Bodies as an axis, in the order the settings screen lists them. */
export const BODY_AXIS_IDS = Object.freeze([
  'claude',
  'opencode',
  'codex',
  'kimi',
  'antigravity',
  'cursor',
  'hermes',
] as const);

export type BodyAxisId = (typeof BODY_AXIS_IDS)[number];

/**
 * What stands between the operator and this pair working — the axis ADR-073 §9
 * adopted in place of an effort ranking, because "hard for us", "costs money"
 * and "does not exist" are three different things that no single number orders.
 *
 *  - `native`           the body's own engine; no key, no switch, nothing to do.
 *  - `available`        works today; the only precondition is a stored key.
 *  - `blocked_by_us`    the barrier is our code — a guard or a landing that has
 *                       not shipped. Schedulable engineering.
 *  - `blocked_by_owner` the engineering is done; the barrier is a purchase.
 *  - `closed_at_vendor` the endpoint does not exist at the provider. NOT delayed —
 *                       closed. It is not scheduled, estimated, or back-logged,
 *                       and is only revisited on an announced vendor change.
 *  - `unverified`       never run end to end; no claim either way.
 */
export type BodyEngineStatus =
  | 'native'
  | 'available'
  | 'blocked_by_us'
  | 'blocked_by_owner'
  | 'closed_at_vendor'
  | 'unverified';

/**
 * How the cell's status is known.
 *  - `measured` a run was made on this machine and observed.
 *  - `inferred` from vendor documentation or a binary's own strings; nothing run.
 *  - `none`     neither; the cell is `unverified`.
 */
export type BodyEngineEvidence = 'measured' | 'inferred' | 'none';

export type BodyEngineCell = {
  engine: EngineAxisId;
  status: BodyEngineStatus;
  evidence: BodyEngineEvidence;
  /**
   * Stable i18n suffix for the cell's one-line reason (`engines.cell.<note>`),
   * with an English default carried alongside so a missing translation degrades
   * to a true sentence rather than a raw key.
   */
  note: string;
  noteDefault: string;
};

/** Human label for an engine on this axis. `engineProviderLabel` covers only the
 *  three Anthropic-compatible ones; these two exist on no other surface. */
export const ENGINE_AXIS_LABEL: Readonly<Record<EngineAxisId, string>> = Object.freeze({
  anthropic: 'Anthropic',
  glm: 'GLM',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  zen: 'OpenCode Zen',
  local: 'Local models',
});

/**
 * The endpoint an engine is reached on, when we know it and it is ours to state.
 * `anthropic` is deliberately absent: the official path is whatever the body's
 * own credentials resolve to, and printing a host there would imply nassaj
 * routes it. `zen` is absent for the same reason — opencode owns it.
 */
export const ENGINE_AXIS_HOST: Readonly<Partial<Record<EngineAxisId, string>>> = Object.freeze({
  glm: new URL(ENGINE_ANTHROPIC_ENDPOINT.glm).hostname,
  kimi: new URL(ENGINE_ANTHROPIC_ENDPOINT.kimi).hostname,
  deepseek: new URL(ENGINE_ANTHROPIC_ENDPOINT.deepseek).hostname,
});

/** True when the engine's key is one this app stores (the AES per-user store). */
export function engineHasStorableKey(engine: EngineAxisId): engine is EngineProviderId {
  return Object.prototype.hasOwnProperty.call(ENGINE_ANTHROPIC_ENDPOINT, engine);
}

/**
 * Which credential slot a (body, engine) pair actually READS — B-343.
 *
 * `engineHasStorableKey` answers a different question ("do we store a key for
 * this engine?") and the key box used to be gated on it alone. That produced
 * boxes on pairs whose body never reads that slot: opencode's GLM carrier takes
 * its key from opencode's own `auth.json` (target `glm`), not from the AES
 * store, so the box under opencode → Engines wrote a record nothing would ever
 * read — the operator types a key, saves it, and nothing changes. Kimi's body
 * likewise receives only its own vendor key at spawn, never DeepSeek's.
 *
 * So the slot is a property of the PAIR, and `null` means "no box here": we have
 * nowhere honest to put that key today.
 *
 * @returns the provider (and optional target) to write, or null when the pair
 *   has no readable slot.
 */
export function engineKeySlot(
  body: string,
  engine: EngineAxisId,
): { provider: string; target?: string } | null {
  // The Claude body reads the AES store directly at spawn
  // (apply-claude-engine-provider-env.js), keyed by the engine id — but ONLY for
  // an engine it may actually run on. `engineHasStorableKey` alone was too wide:
  // it also matched DeepSeek, which is not in ELIGIBLE_ENGINE_PROVIDERS, so the
  // pair can never run and its key would sit unread. Caught by the ADR-085 drift
  // test, which found a slot with no vendor behind it.
  if (body === 'claude' && engineHasStorableKey(engine) && isEngineProviderEligible(engine)) {
    return { provider: engine };
  }

  // OpenCode carries GLM through its own credential file; the target is the
  // engine id and the writer already accepts it (OPENCODE_CREDENTIAL_TARGETS).
  if (body === 'opencode' && engine === 'glm') {
    return { provider: 'opencode', target: 'glm' };
  }

  return null;
}

const cell = (
  engine: EngineAxisId,
  status: BodyEngineStatus,
  evidence: BodyEngineEvidence,
  note: string,
  noteDefault: string,
): BodyEngineCell => ({ engine, status, evidence, note, noteDefault });

/**
 * The matrix, one row per body. Transcribed from ADR-073 §4 on 2026-07-27; the
 * `evidence` value on each cell is that table's `[مقيس]` / `[مستنتَج]` marker.
 */
export const BODY_ENGINE_MATRIX: Readonly<Record<BodyAxisId, readonly BodyEngineCell[]>> =
  Object.freeze({
    claude: [
      cell('local', 'blocked_by_us', 'inferred', 'claudeLocalForbidden', 'Local models on the Claude body are prohibited by ADR-163.'),
      cell('anthropic', 'native', 'measured', 'claudeNative',
        'The engine Claude Code ships with, on the account already signed in here.'),
      cell('glm', 'available', 'measured', 'claudeGlm',
        'Runs today: verified end to end on this machine, and the chat picker switches to it.'),
      // B-375: was blocked_by_owner/inferred ("all that is missing is a key"),
      // which the UI then resolved to `ready` once the key was stored — i.e. "not
      // run here yet". It had been run here: four Claude-body sessions carried
      // engine_provider='kimi' on 2026-07-31 (one of them by the ADR-088 spawn
      // verdict, not inference), and session cec74357 holds 40 assistant messages
      // from `kimi-k3`. That is a measurement, so the cell is `available`.
      cell('kimi', 'available', 'measured', 'claudeKimi',
        'Runs today: kimi-k3 answered inside a Claude session on this machine, and the chat picker switches to it.'),
      // B-424 — the owner decision the cell below used to wait on, made
      // 2026-08-03. The wire is verified end to end on this machine: the catalog
      // answers 200 (two live ids) and a POST to /v1/messages authenticates and
      // returns 402 Insufficient Balance — which is an ACCOUNT answer, not a
      // routing one, so it proves the path. What it does NOT prove is a completed
      // generation, because the operator's DeepSeek account held no balance at
      // the measurement; that is a purchase, not engineering. `blocked_by_owner`
      // (not `available`) is the honest status for exactly that: the engineering
      // is done, the remaining barrier is funding the account. Evidence is
      // `inferred` rather than `measured` because no token was observed returned.
      cell('deepseek', 'blocked_by_owner', 'inferred', 'claudeDeepseek',
        'The wire and the key are verified; only the DeepSeek account balance is missing. Topping it up is the sole remaining step.'),
      cell('zen', 'closed_at_vendor', 'inferred', 'claudeZen',
        'Zen exposes no Anthropic-compatible endpoint, so the Claude body cannot be pointed at it.'),
    ],
    opencode: [
      cell('local', 'unverified', 'none', 'opencodeLocal', 'Local servers require administrator activation. Runtime verification is deferred.'),
      cell('zen', 'blocked_by_owner', 'inferred', 'opencodeZen',
        "OpenCode's own engine. The path works; it bills against a Zen balance."),
      cell('glm', 'available', 'measured', 'opencodeGlm',
        'Runs today: the carrier returns real tokens through our governed provider block.'),
      cell('anthropic', 'blocked_by_owner', 'none', 'opencodeAnthropic',
        'API key only. Passing a personal Claude subscription through OpenCode is forbidden outright.'),
      cell('kimi', 'blocked_by_owner', 'inferred', 'opencodeKimi',
        'Catalogued upstream; needs a Moonshot key.'),
      cell('deepseek', 'blocked_by_owner', 'inferred', 'opencodeDeepseek',
        'Catalogued upstream; needs a DeepSeek key.'),
    ],
    codex: [
      cell('anthropic', 'closed_at_vendor', 'inferred', 'codexAnthropic',
        'Codex speaks only the Responses protocol, and Anthropic does not serve it.'),
      cell('glm', 'closed_at_vendor', 'inferred', 'codexGlm',
        'z.ai serves no Responses endpoint, and upstream closed the integration request as not planned.'),
      cell('kimi', 'closed_at_vendor', 'measured', 'codexKimi',
        'Moonshot answers 404 on /v1/responses — measured. Closed at the vendor, not pending.'),
      cell('deepseek', 'closed_at_vendor', 'inferred', 'codexDeepseek',
        'Same reason: no Responses endpoint to point Codex at.'),
      cell('zen', 'unverified', 'none', 'codexZen',
        'Zen does expose /responses, but this pair has never been run end to end.'),
    ],
    kimi: [
      cell('kimi', 'native', 'measured', 'kimiNative',
        'Its own engine. A 402 here is the engine billing, not the body — the body runs without it.'),
      cell('glm', 'blocked_by_us', 'measured', 'kimiGlm',
        'Proven on the terminal, environment only. Inside nassaj it waits on its config guard — no launch before the guard.'),
      // B-415 — these three used to read `blocked_by_owner` («needs a key»), which
      // is a claim about a PURCHASE while the barrier standing in front of them is
      // OURS. The missing guard named on the row above is a guard of the BODY, not
      // of one engine: ADR-073 §4 forbids launching a non-Claude body on any custom
      // engine until that body's config guard ships, so it stops kimi × anthropic
      // exactly as it stops kimi × glm. One row cannot hold both verdicts for one
      // barrier — and pricing a code barrier as a shopping trip is precisely the
      // distinction this axis was created to keep (see `BodyEngineStatus`).
      //
      // معرّفات المفاتيح على حالها عمداً (لها ترجمات في تسع لغات)، والنصوص
      // الإنجليزية أدناه هي الصياغة الصحيحة الواجب حملُها إلى ملفات اللغات:
      // جملةُ «ينقصه مفتاح» المترجَمة اليوم تصف حاجزاً غير الحاجز. ولا تُقرأ على
      // الشاشة الآن بحال — `actionableEngineCells` تُسقط `blocked_by_us` كلّه —
      // فالتعارض محجوبٌ لا مؤجَّل، ويسقط نهائياً بتحديث السلاسل.
      cell('anthropic', 'blocked_by_us', 'none', 'kimiAnthropic',
        'Technically established at the vendor, but the Kimi body has no config guard yet — no launch before the guard.'),
      cell('deepseek', 'blocked_by_us', 'none', 'kimiDeepseek',
        'Catalogued, and held by the same missing guard: nassaj does not launch this body on a custom engine yet.'),
      cell('zen', 'blocked_by_us', 'none', 'kimiZen',
        'Catalogued, and held by the same missing guard — a Zen balance would not lift it.'),
    ],
    antigravity: [
      cell('anthropic', 'closed_at_vendor', 'inferred', 'agyClosed',
        'Antigravity resolves its own model inside its CLI and accepts no external engine.'),
    ],
    cursor: [
      cell('anthropic', 'closed_at_vendor', 'inferred', 'cursorClosed',
        'Cursor resolves its own model server-side and accepts no external engine.'),
    ],
    hermes: [
      cell('anthropic', 'unverified', 'none', 'hermesUnverified',
        'Hermes has its own model layer; no engine pair has been examined.'),
    ],
  });

/** The row for a body, or an empty list for an id that has no row. */
export function bodyEngineCells(body: string): readonly BodyEngineCell[] {
  return Object.prototype.hasOwnProperty.call(BODY_ENGINE_MATRIX, body)
    ? BODY_ENGINE_MATRIX[body as BodyAxisId]
    : [];
}

/**
 * The cells a reader can act on: running now, or one credential away (T-1152).
 *
 * The panel used to render every declared cell, so Claude showed five rows of
 * which three only reported that they cannot happen — an engine nobody enabled,
 * and one with no Anthropic-compatible endpoint at all. Measured across the
 * matrix: 23 declared cells, 12 actionable. The other 11 are barriers the reader
 * cannot lift, and they buried the rows that carry an action.
 *
 * `blocked_by_us` and `closed_at_vendor` stay DECLARED — this hides them, it
 * does not delete them, and a pair that later becomes reachable reappears on its
 * own with no edit here.
 */
export function actionableEngineCells(body: string): readonly BodyEngineCell[] {
  return bodyEngineCells(body).filter(
    (cell) => cell.status === 'native'
      || cell.status === 'available'
      || cell.status === 'blocked_by_owner',
  );
}

/**
 * True when the settings screen should show an Engines tab for this body.
 *
 * Reads the SAME predicate the panel renders from, deliberately: gating the tab
 * on "any declared cell" while the panel draws "any actionable cell" is two
 * answers to one question, and it shows up as a tab that opens onto nothing —
 * which is exactly what codex, cursor, hermes and antigravity would do, since
 * every cell they declare is a barrier.
 */
export function bodyHasEngineAxis(body: string): boolean {
  return actionableEngineCells(body).length > 0;
}
