// Pure helpers for the "active subscriptions" section. No React, no i18n, no
// fetching — the rules that decide what a card is *allowed* to say live here so
// they stay testable without a DOM.
//
// The three layers this file keeps apart, because the panel used to conflate
// them (owner correction, 2026-07-28):
//   • VENDOR  — who serves the model and therefore who is PAID (anthropic,
//     openai, glm/z.ai, opencode-zen, moonshot…). A subscription is a vendor.
//   • HARNESS — the CLI that happened to run (claude-code, codex, opencode,
//     glm-cli, antigravity). Not something you pay for.
//   • MODEL   — claude-opus-5, glm-5.2, big-pickle.
// A card is a VENDOR; the harnesses it was reached through are nested inside it.

/**
 * One model inside one harness, summed over the cycle.
 *
 * `requests`/`sessions` are part of the wire contract and are deliberately NOT
 * carried into the rendered row: the panel is ~250px wide and a third column
 * would push the amount off the line. They stay typed so the contract is
 * documented where it is consumed.
 */
export type SubscriptionModelCost = {
  model: string;
  /** null = no official price for this model. NEVER rendered as an amount. */
  costUsd: number | null;
  requests?: number;
  sessions?: number;
};

/**
 * One HARNESS (the CLI that ran) inside a vendor subscription.
 *
 * `displayName` is optional: an older or terser server may send only the key,
 * and a key is still a name a person can read — it is never dropped for lack of
 * a pretty label.
 */
export type SubscriptionHarnessCost = {
  harness: string;
  displayName?: string | null;
  totalUsd?: number;
  sessions?: number;
  perModel?: SubscriptionModelCost[];
};

/**
 * One row of GET /api/providers/costs/subscriptions — keyed by VENDOR (who is
 * paid), never by harness (which CLI ran). GLM reached through both `opencode`
 * and `glm-cli` is ONE subscription with two harnesses inside it, not two cards
 * of which one says "Not available".
 */
export type SubscriptionCost = {
  /** Vendor key: anthropic, openai, glm, opencode-zen, moonshot… */
  provider: string;
  displayName: string;
  plan: string | null;
  /** Day of month the billing cycle restarts. Detected server-side; the UI shows it, never edits it. */
  anchorDay: number;
  /**
   * من أين جاء `anchorDay`. اختياري في النوع لا في المعنى: خادم أقدم لا
   * يرسله، والواجهة تعامله حينها كـ`unknown` — أي «شهر تقويمي مفترَض» لا
   * «تاريخ اشتراك مؤكَّد».
   */
  anchorSource?: 'manual' | 'detected' | 'derived' | 'unknown';
  /** المصدر الحرفي للتدقيق، يظهر في التلميح فقط. */
  anchorEvidence?: string | null;
  cycleStart: string; // ISO 8601
  cycleEnd: string; // ISO 8601
  available: boolean;
  reason?: string;
  /**
   * false = a flat-fee subscription. The amount is then the API-equivalent
   * value of the usage, NOT money billed — the UI must say which it is.
   */
  metered: boolean;
  totalUsd: number;
  sessions: number;
  /** false = some model in the window has no official price; the total is a floor. */
  complete: boolean;
  unpricedModels: string[];
  /** نماذج بسعر مفترَض لا رسمي — تُسمّى في البطاقة كتقدير. */
  assumedModels?: string[];
  /**
   * Harness → model breakdown. Optional on purpose: an older server sends none
   * and the section then renders no breakdown at all — an absent array is never
   * rendered as "this vendor ran nothing".
   */
  byHarness?: SubscriptionHarnessCost[];
};

/** Success body of GET /api/providers/costs/subscriptions (minus `success`). */
export type SubscriptionsPayload = {
  pricesAsOf: string;
  subscriptions: SubscriptionCost[];
};

export type SubscriptionRowState =
  | { kind: 'unavailable'; reason: string | null }
  | { kind: 'amount'; metered: boolean; partial: boolean };

/**
 * What a card is allowed to render.
 *
 * Kept out of the JSX because both rules here are about honesty, not layout:
 *  • a vendor the server could not price shows its reason — never "0.00", which
 *    reads as "you spent nothing" instead of "we don't know";
 *  • a non-finite total is treated exactly like an unavailable row. A NaN that
 *    reaches Intl renders as "$NaN" and a null coerces to a very believable
 *    "$0.00" — both are numbers the user never actually has.
 */
export function resolveRowState(subscription: SubscriptionCost): SubscriptionRowState {
  if (!subscription.available) {
    return { kind: 'unavailable', reason: subscription.reason ?? null };
  }
  if (typeof subscription.totalUsd !== 'number' || !Number.isFinite(subscription.totalUsd)) {
    return { kind: 'unavailable', reason: null };
  }
  return {
    kind: 'amount',
    metered: subscription.metered,
    partial: !subscription.complete,
  };
}

/** A model line as the UI is allowed to render it. */
export type BreakdownRow = {
  /** What is printed: the vendor prefix the card already carries is stripped. */
  model: string;
  /** The id exactly as the server sent it — React key and hover title. */
  modelId: string;
  /** null = unpriced: the line shows its name and no amount, never 0.00. */
  costUsd: number | null;
};

/** One harness inside a vendor card, with the models it ran. */
export type HarnessGroup = {
  harness: string;
  /** Never empty: falls back to the key, which is still readable. */
  displayName: string;
  /** null = no printable total for this harness (never "$NaN"). */
  totalUsd: number | null;
  models: BreakdownRow[];
};

function toFiniteUsd(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * "glm/glm-5.2" inside the GLM card is the card's own name printed twice, and
 * the same model arriving as "glm-5.2" from another harness would then read as a
 * different model. Only an EXACT match of the vendor key is stripped, so
 * "opencode/big-pickle" under the `opencode-zen` vendor keeps its prefix.
 */
function stripVendorPrefix(model: string, vendor: string): string {
  const slash = model.indexOf('/');
  if (slash <= 0) return model;
  const head = model.slice(0, slash);
  const tail = model.slice(slash + 1);
  if (!tail) return model;
  return head.toLowerCase() === vendor.trim().toLowerCase() ? tail : model;
}

function resolveModelRows(
  entries: SubscriptionModelCost[] | undefined,
  vendor: string,
): BreakdownRow[] {
  if (!Array.isArray(entries)) return [];

  const rows = entries
    .filter(
      (entry): entry is SubscriptionModelCost =>
        Boolean(entry) && typeof entry.model === 'string' && entry.model.trim().length > 0,
    )
    .map<BreakdownRow>((entry) => {
      const modelId = entry.model.trim();
      return {
        model: stripVendorPrefix(modelId, vendor),
        modelId,
        // A non-finite amount is demoted to unpriced: NaN prints "$NaN" and
        // null coerces to a very believable "$0.00".
        costUsd: toFiniteUsd(entry.costUsd),
      };
    });

  // Ordering is re-applied client-side (dearest first, unpriced last) so the
  // list reads the same whatever order the payload arrived in.
  return rows.sort((a, b) => {
    const aPriced = a.costUsd !== null;
    const bPriced = b.costUsd !== null;
    if (aPriced !== bPriced) return aPriced ? -1 : 1;
    if (aPriced && bPriced && a.costUsd !== b.costUsd) return (b.costUsd as number) - (a.costUsd as number);
    return a.model.localeCompare(b.model);
  });
}

/**
 * The harness groups of one vendor card.
 *
 * Rules, all of them the group-level version of `resolveRowState`:
 *  • a missing/!Array `byHarness` yields no groups — an older server simply has
 *    no breakdown to expand, which is a different claim from "nothing ran";
 *  • a group with no models, no printable total and no sessions carries nothing
 *    at all and is dropped rather than drawn as an empty named row;
 *  • harnesses are ordered dearest first (unprintable totals last) so the
 *    grouping answers "where did the money go" at a glance.
 */
export function resolveHarnessGroups(subscription: SubscriptionCost): HarnessGroup[] {
  if (!Array.isArray(subscription.byHarness)) return [];

  const vendor = typeof subscription.provider === 'string' ? subscription.provider : '';

  const groups = subscription.byHarness
    .filter(
      (entry): entry is SubscriptionHarnessCost =>
        Boolean(entry) && typeof entry.harness === 'string' && entry.harness.trim().length > 0,
    )
    .map<HarnessGroup & { sessions: number }>((entry) => {
      const harness = entry.harness.trim();
      const label = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
      return {
        harness,
        displayName: label || harness,
        totalUsd: toFiniteUsd(entry.totalUsd),
        models: resolveModelRows(entry.perModel, vendor),
        sessions: typeof entry.sessions === 'number' && Number.isFinite(entry.sessions) ? entry.sessions : 0,
      };
    })
    .filter((group) => group.models.length > 0 || group.totalUsd !== null || group.sessions > 0);

  return groups
    .sort((a, b) => {
      const aPriced = a.totalUsd !== null;
      const bPriced = b.totalUsd !== null;
      if (aPriced !== bPriced) return aPriced ? -1 : 1;
      if (aPriced && bPriced && a.totalUsd !== b.totalUsd) return (b.totalUsd as number) - (a.totalUsd as number);
      return a.displayName.localeCompare(b.displayName);
    })
    .map(({ harness, displayName, totalUsd, models }) => ({ harness, displayName, totalUsd, models }));
}

/**
 * Sum of the priced lines. Used by the tests to hold the server to the
 * invariant the whole breakdown rests on — a total IS its parts — and available
 * to the UI for the same reason.
 */
export function sumBreakdownUsd(rows: readonly BreakdownRow[]): number {
  return rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
}

/**
 * Wraps a value that will be interpolated into a translated sentence in
 * U+2068 FSI … U+2069 PDI — the character-level equivalent of `<bdi>`, which
 * cannot be used inside an i18next interpolation.
 *
 * Without it, "عبر opencode" puts a Latin harness name inside an RTL sentence
 * and the bidi algorithm reorders whatever punctuation sits next to it.
 */
export function isolateBidi(value: string): string {
  // Written as escapes on purpose: both characters are invisible in an editor,
  // and a "stray character" cleanup would silently delete a literal one.
  return `\u2068${value}\u2069`;
}

/**
 * USD amount, locale-shaped (Arabic renders Western digits under the `ar`
 * locale, matching the rest of the panel).
 *
 * Sub-cent amounts keep four fraction digits: a real 0.0034 rendered as "$0.00"
 * is indistinguishable from "nothing was spent", and answering that exact
 * question is what this section is for.
 */
export function formatUsd(amountUsd: number, locale: string): string {
  const fractionDigits = amountUsd !== 0 && Math.abs(amountUsd) < 0.01 ? 4 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amountUsd);
  } catch {
    // Unusable locale tag — a plain dollar amount still carries the number.
    return `$${amountUsd.toFixed(fractionDigits)}`;
  }
}

/**
 * Day + month of the cycle start ("10 July" / "10 يوليو"), for the
 * `subscriptions.cycleSince` label. The year is dropped: a monthly window is at
 * most one month back, so it never disambiguates anything.
 *
 * Returns the raw date part when Intl rejects the locale, and null only when
 * the timestamp itself is unusable.
 */
export function formatCycleStart(cycleStart: string, locale: string): string | null {
  const time = new Date(cycleStart).getTime();
  if (Number.isNaN(time)) return null;

  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(time);
  } catch {
    return cycleStart.slice(0, 10);
  }
}

/**
 * The price-table stamp shown next to every amount.
 *
 * `pricesAsOf` is date-only ("2026-07-28"). Date-only strings parse as UTC
 * midnight, so formatting them in the viewer's zone shows the *previous* day
 * anywhere west of Greenwich — pin that shape to UTC, and only that shape
 * (a full ISO timestamp is a real instant and must stay local).
 */
export function formatPricesAsOf(pricesAsOf: string, locale: string): string | null {
  const time = new Date(pricesAsOf).getTime();
  if (Number.isNaN(time)) return null;

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(pricesAsOf);
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...(isDateOnly ? { timeZone: 'UTC' } : {}),
    }).format(time);
  } catch {
    return pricesAsOf;
  }
}
