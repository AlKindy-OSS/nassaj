import { AlertCircle, AlertTriangle, ChevronDown, Info } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatCycleStart,
  formatUsd,
  isolateBidi,
  resolveHarnessGroups,
  resolveRowState,
  type BreakdownRow,
  type HarnessGroup,
  type SubscriptionCost,
  type SubscriptionRowState,
} from '../subscriptionHelpers';

// `max-w-full truncate` alongside `shrink-0`: the badge keeps its size next to
// a vendor name, but a long plan label (Arabic plans run long) is clipped at the
// card edge instead of pushing the amount out of a ~250px panel.
const PLAN_BADGE_CLASS =
  'shrink-0 max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold normal-case text-muted-foreground';

// One colour per note, never a base + an override: `.text-muted-foreground` is
// emitted AFTER `.text-amber-700` in the compiled stylesheet, so appending the
// amber class to a muted base loses — the warning line rendered grey. Measured
// in dist/assets/index-*.css, not assumed from the class order in the JSX.
const NOTE_BASE_CLASS = 'flex items-start gap-1.5 text-[11px]';
const NOTE_CLASS = `${NOTE_BASE_CLASS} text-muted-foreground`;
const WARNING_NOTE_CLASS = `${NOTE_BASE_CLASS} text-amber-700 dark:text-amber-400`;

/**
 * The model lines of one harness.
 *
 * An unpriced model keeps its name and gets NO amount: printing 0.00 for a
 * model we have no published price for is the one unacceptable lie in this
 * feature (ADR-078 §3), and its absence is exactly why the card above it is
 * flagged partial.
 */
function ModelList({ models, locale }: { models: BreakdownRow[]; locale: string }) {
  const { t } = useTranslation('settings');
  if (models.length === 0) return null;

  return (
    <ul className="space-y-0.5">
      {models.map((row, index) => (
        <li
          key={`${index}-${row.modelId}`}
          className="flex items-baseline justify-between gap-2 text-[11px]"
        >
          {/* Model ids are Latin inside an Arabic panel; `title` keeps the full
              id reachable once truncation bites in a ~250px column. */}
          <bdi className="min-w-0 truncate text-muted-foreground" title={row.modelId}>
            {row.model}
          </bdi>

          {row.costUsd === null ? (
            <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-400">
              {t('subscriptions.unpricedModel', { defaultValue: 'No official price' })}
            </span>
          ) : (
            <bdi className="shrink-0 tabular-nums text-foreground/90">
              {formatUsd(row.costUsd, locale)}
            </bdi>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * subscription → harness → model.
 *
 * The nesting level is drawn ONLY when it carries information. A vendor reached
 * through a single harness (the common case) names that harness once and lists
 * its models flat — an indented group of one is a rule pretending to be a fact.
 * A vendor reached through several (GLM through both `opencode` and `glm-cli`)
 * is the whole reason this level exists: each harness names itself, carries its
 * own amount, and the subscription total closes the list underneath them.
 */
function HarnessBreakdown({
  subscription,
  groups,
  state,
  locale,
}: {
  subscription: SubscriptionCost;
  groups: HarnessGroup[];
  state: SubscriptionRowState;
  locale: string;
}) {
  const { t } = useTranslation('settings');
  const isSingleHarness = groups.length === 1;

  if (isSingleHarness) {
    return (
      <div className="space-y-1 border-t border-border/60 pt-1.5">
        <p className="text-[11px] text-muted-foreground/80">
          {/* The harness name is Latin and lands inside an Arabic sentence:
              isolate it at the character level, since a <bdi> cannot live
              inside an i18next interpolation. */}
          {t('subscriptions.viaHarness', {
            harness: isolateBidi(groups[0].displayName),
            defaultValue: 'Via {{harness}}',
          })}
        </p>
        <ModelList models={groups[0].models} locale={locale} />
      </div>
    );
  }

  return (
    <div className="space-y-1.5 border-t border-border/60 pt-1.5">
      <ul className="space-y-1.5">
        {groups.map((group) => (
          <li key={group.harness} className="space-y-0.5">
            <p className="flex items-baseline justify-between gap-2 text-[11px] font-medium text-foreground/90">
              <bdi className="min-w-0 truncate">{group.displayName}</bdi>
              {/* A harness whose total the server could not put a number on
                  still names itself — it simply carries no amount. */}
              {group.totalUsd !== null && (
                <bdi className="shrink-0 tabular-nums">{formatUsd(group.totalUsd, locale)}</bdi>
              )}
            </p>

            {group.models.length > 0 && (
              <div className="border-s border-border/60 ps-2">
                <ModelList models={group.models} locale={locale} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Restated at the bottom on purpose: it is the same number the collapsed
          header shows, and seeing it under its parts is what makes the list
          checkable by eye. */}
      {state.kind === 'amount' && (
        <p className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-1 text-[11px] font-medium">
          <span className="text-muted-foreground">
            {t('subscriptions.subscriptionTotal', { defaultValue: 'Subscription total' })}
          </span>
          <bdi className="shrink-0 tabular-nums text-foreground">
            {formatUsd(subscription.totalUsd, locale)}
          </bdi>
        </p>
      )}
    </div>
  );
}

/**
 * One SUBSCRIPTION — a vendor you pay, not the CLI that happened to run.
 *
 * Collapsed by default and opened by clicking anywhere on its header: five
 * cards each printing their cycle, provenance, notes and breakdown at once fill
 * the whole panel and nothing can be compared at a glance. Collapsed, a card
 * carries only the three things a comparison needs — name, plan, amount — plus
 * the two markers that must never wait for a click, because ADR-078 forbids an
 * amount that looks like something it is not:
 *   • `≈` when the plan is flat-fee (the figure is API-equivalent VALUE, not
 *     money billed);
 *   • an amber triangle when models in the window have no official price (the
 *     figure is a floor, not the whole).
 * Both are spelled out in full inside the body, and both carry screen-reader
 * text so the button's accessible name states them outright.
 */
export default function SubscriptionCard({
  subscription,
  locale,
}: {
  subscription: SubscriptionCost;
  locale: string;
}) {
  const { t } = useTranslation('settings');
  const [isExpanded, setIsExpanded] = useState(false);
  const uid = useId();
  const bodyId = `${uid}-body`;

  const state = resolveRowState(subscription);
  const groups = resolveHarnessGroups(subscription);
  const cycleSince = formatCycleStart(subscription.cycleStart, locale);

  // A flat-fee subscription is not billed per token, so its figure is the
  // API-equivalent value of the usage.
  const meteredNote =
    state.kind === 'amount' && !state.metered
      ? t('subscriptions.apiEquivalent', {
          defaultValue: 'API-equivalent value of usage — not money billed',
        })
      : t('subscriptions.billed', { defaultValue: 'Billed usage' });

  const assumedModels = Array.isArray(subscription.assumedModels) ? subscription.assumedModels : [];
  const unpricedModels = Array.isArray(subscription.unpricedModels) ? subscription.unpricedModels : [];

  const partialNote = t('subscriptions.partial', {
    defaultValue: 'Partial — some models have no official price',
  });

  return (
    <li className="overflow-hidden rounded-lg border border-border bg-secondary/50">
      {/* The whole header is the control — a 12px chevron is not a hit target
          in a side panel, and the amount must stay part of the button's
          accessible name. */}
      <button
        type="button"
        onClick={() => setIsExpanded((previous) => !previous)}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        className="flex w-full items-start justify-between gap-2 p-3 text-start transition-colors hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {/* Vertical flip only — a sideways chevron would need mirroring under RTL. */}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
              isExpanded ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          />
          {/* Vendor and plan names stay Latin inside an Arabic panel — isolate
              them so the surrounding text keeps its order. */}
          <bdi className="min-w-0 truncate text-sm font-medium text-foreground">
            {subscription.displayName}
          </bdi>
          {subscription.plan && <bdi className={PLAN_BADGE_CLASS}>{subscription.plan}</bdi>}
        </span>

        {state.kind === 'amount' ? (
          <span
            className="flex shrink-0 items-baseline gap-1 text-sm font-semibold text-foreground"
            title={meteredNote}
          >
            {!state.metered && (
              <span aria-hidden="true" className="text-xs font-normal text-muted-foreground">
                ≈
              </span>
            )}
            <bdi className="tabular-nums">{formatUsd(subscription.totalUsd, locale)}</bdi>
            {state.partial && (
              <span title={partialNote} className="self-center">
                <AlertTriangle
                  className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              </span>
            )}
            {/* The markers above are glyphs; these say what they mean. Both ride
                inside the button, so its accessible name carries them. */}
            <span className="sr-only">{meteredNote}</span>
            {state.partial && <span className="sr-only">{partialNote}</span>}
          </span>
        ) : (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            {t('subscriptions.unavailable', { defaultValue: 'Not available' })}
          </span>
        )}
      </button>

      {/* The target of aria-controls exists whether or not it is open; the
          padded, bordered body is only drawn when there is something in it. */}
      <div id={bodyId}>
        {isExpanded && (
          <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>{t('subscriptions.monthToDate', { defaultValue: 'This cycle' })}</span>
              {cycleSince && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t('subscriptions.cycleSince', {
                      date: isolateBidi(cycleSince),
                      defaultValue: 'Since {{date}}',
                    })}
                  </span>
                  {/* من أين جاء هذا التاريخ. بلا هذا السطر يبدو تاريخ الدورة
                      المُشتقّ تخميناً — «الأول من الشهر لأننا لم نجد شيئاً» —
                      مطابقاً تماماً لتاريخ اشتراك حقيقي قرأناه من حسابك. عرض
                      رقم مُقدَّر بمظهر المقيس هو عين ما يمنعه ADR-078. */}
                  <span aria-hidden="true">·</span>
                  <span
                    className={
                      subscription.anchorSource === 'detected'
                        ? 'text-muted-foreground'
                        : 'italic text-muted-foreground/80'
                    }
                    title={subscription.anchorEvidence ?? undefined}
                  >
                    {t(`subscriptions.anchorSource.${subscription.anchorSource ?? 'unknown'}`, {
                      defaultValue:
                        subscription.anchorSource === 'detected'
                          ? 'From your subscription data'
                          : subscription.anchorSource === 'derived'
                            ? 'Estimated from earliest usage'
                            : subscription.anchorSource === 'manual'
                              ? 'Set by you'
                              : 'Calendar month — no subscription date found',
                    })}
                  </span>
                </>
              )}
            </p>

            {state.kind === 'amount' && (
              <p className={NOTE_CLASS}>
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{meteredNote}</span>
              </p>
            )}

            {/* سعرٌ مفترَض لا رسمي: يُسمّى النموذج صراحةً بدل وسم «جزئية»
                مبهم. نموذج غير معلَن قد يشكّل ربع البطاقة، فإخفاء أن رقمه
                تقدير يجعل التقدير يُقرأ قياساً. */}
            {state.kind === 'amount' && assumedModels.length > 0 && (
              <p className={WARNING_NOTE_CLASS}>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  {t('subscriptions.assumedPrice', {
                    models: assumedModels.join(', '),
                    defaultValue: 'Estimated price — {{models}} has no published rate',
                  })}
                </span>
              </p>
            )}

            {state.kind === 'amount' && state.partial && unpricedModels.length > 0 && (
              <p className={WARNING_NOTE_CLASS}>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span title={unpricedModels.join(', ')}>{partialNote}</span>
              </p>
            )}

            {/* No reason, no line: the header already says "Not available", and
                a stand-in sentence would claim to explain something we were not
                told. */}
            {state.kind === 'unavailable' && state.reason && (
              <p className={NOTE_CLASS}>
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                {/* The reason comes from the server untranslated — isolate it. */}
                <bdi>{state.reason}</bdi>
              </p>
            )}

            {/* An older server sends no `byHarness`: no breakdown is drawn at
                all, rather than an empty one that would read as "nothing ran". */}
            {groups.length > 0 && (
              <HarnessBreakdown
                subscription={subscription}
                groups={groups}
                state={state}
                locale={locale}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}
