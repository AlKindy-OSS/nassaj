/**
 * Client half of the model-switch context guard (T-2087, ADR-223).
 *
 * The server is the authority: it refuses a turn whose pinned model cannot
 * hold the conversation. This module only warns before a switch (advisory,
 * fail-open) and turns the refusal payload into renderable fields, so every
 * sentence the user reads comes from the UI language, never the server text.
 */
import type { TFunction } from 'i18next';

import { isolateBidi } from '../../quick-settings-panel/subscriptionHelpers';
import { formatCompactTokens } from '../view/subcomponents/conversationCostFormat';

export const CONTEXT_GUARD_REFUSAL_CODE = 'context_guard_window_too_small';
export const COMPACT_COMMAND = '/compact';

/** How long the pre-switch check may delay a switch before it is skipped. */
const FIT_TIMEOUT_MS = 4000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/;

export type ContextGuardInfo = {
  used: number;
  budget: number;
  model: string;
  previousModel: string | null;
  /**
   * The server says `/compact` runs on the previous, larger model (official
   * Claude only). Anything but an explicit `true` hides the shrink action:
   * elsewhere it would compact on the pinned small model.
   */
  canCompactOnPrevious: boolean;
};

export type ContextFitVerdict = 'fits' | 'too_small' | 'unknown';

export type ContextFitReport = {
  verdict: ContextFitVerdict;
  used: number | null;
  budget: number | null;
  model: string;
};

type Bag = Record<string, unknown>;
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

const asBag = (value: unknown): Bag | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Bag : null
);
const readCount = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);
const readModel = (value: unknown): string | null => (
  typeof value === 'string' && MODEL_ID.test(value) ? value : null
);

/** The refusal in renderable form, or `null` when `source` is another frame. */
export function readContextGuardRefusal(source: unknown): ContextGuardInfo | null {
  const root = asBag(source);
  if (!root || root.code !== CONTEXT_GUARD_REFUSAL_CODE) return null;
  const payload = asBag(root.contextGuard);
  const used = readCount(payload?.used);
  const budget = readCount(payload?.budget);
  const model = readModel(payload?.model);
  if (used === null || budget === null || !model) return null;
  return {
    used, budget, model, previousModel: readModel(payload?.previousModel),
    canCompactOnPrevious: payload?.canCompactOnPrevious === true,
  };
}

/**
 * A model id for plain-text copy (dialogs, status lines): bidi-isolated and
 * with non-breaking hyphens, so `claude-haiku-4-5` never wraps mid-id and
 * reorders around the Arabic sentence.
 */
export function plainModelLabel(model: string): string {
  return isolateBidi(model.replace(/-/g, '\u2011'));
}

/** Token counts in the project's compact Latin-digit form (e.g. `312K`). */
export function formatGuardTokens(value: number): string {
  return formatCompactTokens(value);
}

/**
 * Asks the server whether `model` can hold the session. Any failure (network,
 * 4xx/5xx, rate limit, timeout, malformed body) yields `null`: the check is
 * advisory and must never stand between the user and a switch.
 */
export async function fetchContextFit(
  fetcher: Fetcher,
  provider: string,
  sessionId: string,
  model: string,
): Promise<ContextFitReport | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIT_TIMEOUT_MS);
  try {
    const url = `/api/providers/${encodeURIComponent(provider)}/sessions/${encodeURIComponent(sessionId)}`
      + `/context-fit?model=${encodeURIComponent(model)}`;
    const response = await fetcher(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) return null;
    const data = asBag(asBag(await response.json())?.data);
    const verdict = data?.verdict;
    if (verdict !== 'fits' && verdict !== 'too_small' && verdict !== 'unknown') return null;
    return { verdict, used: readCount(data?.used), budget: readCount(data?.budget), model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type GuardModelSwitchInput = {
  fetcher: Fetcher;
  provider: string;
  sessionId: string;
  model: string;
  t: TFunction;
  confirm: (options: {
    title: string; message: string; code: string; confirmLabel: string; cancelLabel: string; tone: 'danger';
  }) => Promise<boolean>;
  /** Called with the neutral "couldn't verify" line when the server cannot measure. */
  onUnknown: (line: string) => void;
};

/**
 * Pre-switch check. Resolves `true` to go ahead with the switch, `false` when
 * the user cancelled after being told the conversation will not fit.
 */
export async function guardModelSwitch(input: GuardModelSwitchInput): Promise<boolean> {
  const { t, model } = input;
  const report = await fetchContextFit(input.fetcher, input.provider, input.sessionId, model);
  if (!report || report.verdict === 'fits') return true;
  if (report.verdict === 'unknown' || report.used === null || report.budget === null) {
    input.onUnknown(t('contextGuard.preflight.unknown', { model: plainModelLabel(model) }));
    return true;
  }
  return input.confirm({
    title: t('contextGuard.preflight.title'),
    message: t('contextGuard.preflight.tooSmall', {
      used: isolateBidi(formatGuardTokens(report.used)),
      budget: isolateBidi(formatGuardTokens(report.budget)),
      model: plainModelLabel(model),
    }),
    code: COMPACT_COMMAND,
    confirmLabel: t('contextGuard.preflight.switchAnyway'),
    cancelLabel: t('contextGuard.preflight.cancel'),
    tone: 'danger',
  });
}
