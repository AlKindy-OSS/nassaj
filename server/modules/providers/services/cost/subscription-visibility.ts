/**
 * subscription-visibility — who may see an AMOUNT on the subscription card (T-1098).
 *
 * THE LEAK THIS CLOSES. `sessionScope` returns `null` for a SHARED provider
 * (session-cost.service.ts), and null means "no filter": the cycle total is then
 * every member's spend on that provider, not the reader's. The card renders that
 * number to whoever asks, and `/costs/subscriptions` carried no role gate — so on
 * the live install (2 owners + 3 members) a plain member opened the card and read
 * the owners' spend, labelled as if it were their own. Two defects in one number:
 * a privacy leak, and a figure that is wrong even for the person reading it.
 *
 * OWNER DECISION 2026-08-03 — the rule is per SURFACE, not global:
 *   • Subscription card → the amount is for `owner` / `admin` / the SUBSCRIPTION
 *     HOLDER.
 *   • Per-conversation costs and project boards → unchanged, visible to everyone
 *     as before. This module is deliberately NOT imported by those paths.
 *
 * WHO IS "THE HOLDER". A shared provider has no individual holder — it is one
 * company/operator credential, which is exactly why its total is everyone's. An
 * ISOLATED provider is the opposite: each member authenticates with their own
 * credential, and `sessionScope` already narrows the total to that member's own
 * conversations. So the reader of an isolated row IS its holder by construction,
 * and needs no extra check. The rule therefore reduces to: redact SHARED rows for
 * anyone who is not owner/admin, and leave isolated rows alone.
 *
 * FAIL-CLOSED ON UNKNOWN. A provider absent from the sharing policy is treated as
 * shared (redacted), never as isolated. `hermes` is the live example. Erring this
 * way hides a number the member might have been entitled to; erring the other way
 * publishes the team's spend — and only one of those is recoverable. Tracked as a
 * fidelity follow-up rather than fixed by editing the sharing policy: that policy
 * also drives real credential isolation at spawn time, so it must never be
 * retuned for a display concern.
 */

import { isProviderIsolated as defaultIsProviderIsolated } from '@/services/provider-sharing.js';

import { vendorHarnesses as defaultVendorHarnesses } from './model-vendor.js';

/**
 * The minimum shape this module touches. Declared structurally (rather than
 * importing `SubscriptionCostView`) so the same helper serves both that view and
 * the slightly looser shared `ProviderSubscriptionCost` the route is typed
 * against — and so it keeps returning the CALLER's exact type instead of
 * widening it at the boundary.
 */
export type AmountBearingSubscriptionRow = {
  provider: string;
  available: boolean;
  reason?: string;
  totalUsd: number;
  sessions: number;
  unpricedModels?: string[];
  balanceUsd?: number | null;
  byHarness?: unknown;
  assumedModels?: unknown;
};

/** Roles allowed to read a shared provider's amount. */
const AMOUNT_PRIVILEGED_ROLES = new Set(['owner', 'admin']);

/**
 * WHY THIS IS NOT A SIMPLE KEY LOOKUP (caught by live verification 2026-08-03).
 *
 * A card row is keyed by VENDOR (`anthropic`, `openai`, `google`), while
 * `provider_sharing` is keyed by HARNESS (`claude`, `codex`, `agy`). An earlier
 * cut of this file looked the vendor key up in the policy directly; `glm` and
 * `deepseek` happened to pass because their names coincide, which made the unit
 * tests green — but on the live install `anthropic` and `moonshot` matched
 * nothing, fell to the unknown branch, and would have hidden a member's OWN
 * Claude and Kimi spend from them. The synthetic fixtures could not catch it
 * because they were written in harness keys, which is not what the route emits.
 *
 * And the relation is many-to-one: the `google` row aggregates `antigravity`
 * and `agy`, which may carry different sharing modes. So the question is not
 * "is this provider isolated" but "is EVERY harness feeding this row isolated" —
 * one shared contributor is enough to put other members' spend into the total.
 */

/** Shown in place of the amount. Server-side English, like every other `reason`. */
export const SHARED_AMOUNT_RESTRICTED_REASON =
  'This provider is shared across the team, so the cycle total is everyone’s spend — not yours. Visible to an owner or admin.';

/**
 * True when this row's amount belongs to the reader alone.
 *
 * Resolves the row key to the harnesses that feed it, then demands that ALL of
 * them be isolated. A row with no known harness behind it (`unknown`, or a key
 * the vendor map has never heard of) takes the conservative branch: it is only
 * treated as reader-owned if the key ITSELF is an isolated harness — which keeps
 * a row that is already named by its harness working, without ever guessing on
 * a name nothing recognises.
 *
 * @param rowKey the row's `provider` field (a vendor key in practice)
 * @param isIsolated injectable policy read (tests)
 * @param harnessesOf injectable vendor→harness expansion (tests)
 */
function readerOwnsAmount(
  rowKey: string,
  isIsolated: (p: string) => boolean,
  harnessesOf: (vendor: string) => string[],
): boolean {
  const harnesses = harnessesOf(rowKey);
  if (harnesses.length === 0) {
    return isIsolated(rowKey);
  }
  // EVERY contributor must be isolated — one shared harness means the total can
  // carry someone else's spend, and that is precisely what must not be shown.
  return harnesses.every((harness) => isIsolated(harness));
}

/**
 * Strip every amount-bearing field from one row.
 *
 * `available:false` is the contract the card already understands
 * (`resolveRowState` in subscriptionHelpers.ts renders "Not available" + reason
 * and never prints a figure), so this needs no client change. The numeric fields
 * are additionally zeroed rather than left populated: a client that ignored the
 * flag must still not find the team's total sitting in the payload — the gate is
 * the REDACTION, not the flag.
 *
 * `sessions` is cleared too. A bare conversation count is a weak signal, but it
 * is still a signal about other people's activity, and nothing on this card needs
 * it once the amount is gone.
 */
function redactRow<T extends AmountBearingSubscriptionRow>(view: T): T {
  const redacted = {
    ...view,
    available: false,
    reason: SHARED_AMOUNT_RESTRICTED_REASON,
    totalUsd: 0,
    sessions: 0,
    balanceUsd: null,
  } as T & { byHarness?: unknown; assumedModels?: unknown };
  if (Array.isArray(view.unpricedModels)) {
    (redacted as AmountBearingSubscriptionRow).unpricedModels = [];
  }
  // Optional breakdowns carry per-model and per-harness figures; drop the keys
  // entirely rather than emptying them, so "no detail" stays distinguishable
  // from "detail that is all zeroes".
  delete redacted.byHarness;
  delete redacted.assumedModels;
  return redacted;
}

/**
 * Apply the subscription-card visibility rule to a full row set.
 *
 * Pure and total: unknown/absent roles are treated as unprivileged, so a caller
 * that forgets to resolve a role redacts rather than leaks.
 *
 * @param views rows straight from `getSubscriptionCosts`
 * @param role the READER's role ('owner' | 'admin' | 'user' | null)
 * @param deps injectable policy seam (tests)
 */
export function applySubscriptionAmountVisibility<T extends AmountBearingSubscriptionRow>(
  views: readonly T[],
  role: string | null | undefined,
  deps: {
    isProviderIsolated?: (provider: string) => boolean;
    vendorHarnesses?: (vendor: string) => string[];
  } = {},
): T[] {
  const isIsolated = deps.isProviderIsolated ?? defaultIsProviderIsolated;
  const harnessesOf = deps.vendorHarnesses ?? defaultVendorHarnesses;
  if (typeof role === 'string' && AMOUNT_PRIVILEGED_ROLES.has(role)) {
    return [...views];
  }
  return views.map((view) =>
    readerOwnsAmount(view.provider, isIsolated, harnessesOf) ? view : redactRow(view),
  );
}
