import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CircleDollarSign, Clock3, XIcon } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { useConversationCostContext } from '../../context/ConversationCostContext';

import { resolveAnchoredPlacement, type AnchoredPlacement } from './anchoredPopover';
import {
  buildCostSummaryLines,
  COST_DASH,
  formatCompactTokens,
  formatCostCount,
  formatCostUsd,
  formatWorkDuration,
  resolveCostDisplay,
  resolveCostSnapshotStatus,
  sumConversationCostTokens,
  sumCostTokens,
  type ConversationCost,
  type CostSummaryLine,
} from './conversationCostFormat';

type ConversationCostChipProps = {
  /** Client-derived from completed, explicitly linked turns; no fallback estimate. */
  workDurationMs?: number | null;
  className?: string;
};

type CostPopoverProps = {
  cost: ConversationCost | null;
  lines: string[];
  titleText: string;
  closeLabel: string;
  perModelLabel: string;
  workDurationLabel: string;
  workDurationText: string | null;
  dir: 'rtl' | 'ltr';
  /** الزرّ الذي فتحها — تُثبَّت تحته. */
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
};

/**
 * نافذة التفصيل — تُصيَّر في `document.body` عبر portal كي لا يقصّها أي سلف
 * بـ`overflow:hidden`، و**تُثبَّت تحت الزرّ** لا وسط الشاشة: نافذة تظهر في
 * منتصف المتصفح تقطع الصلة بين ما ضُغط وما ظهر. الهندسة في
 * `anchoredPopover.ts` (دالّة صرفة مختبَرة) لأن حالاتها الحديّة أرقام لا ألوان.
 */
function CostPopover({
  cost,
  lines,
  titleText,
  closeLabel,
  perModelLabel,
  workDurationLabel,
  workDurationText,
  dir,
  triggerRef,
  onClose,
}: CostPopoverProps) {
  const { t } = useTranslation('chat');
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);

  // `useLayoutEffect` لا `useEffect` + rAF: الموضع يُحسب **قبل الرسم**، فلا
  // تومض النافذة في زاوية الشاشة ثم تقفز إلى مكانها. وهو أيضاً ما يجعلها
  // مرئية لشجرة الإتاحة فور الفتح بدل حالة مخفيّة عابرة يتخطّاها قارئ الشاشة.
  // ويُعاد الحساب عند كل تمرير/تحجيم: الرأس يتحرّك مع تمرير الصفحة، ونافذة
  // معلّقة في مكانها القديم أسوأ من واحدة متمركزة.
  useLayoutEffect(() => {
    const reposition = () => {
      const trigger = triggerRef.current;
      if (!trigger || typeof window === 'undefined') {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      setPlacement(
        resolveAnchoredPlacement({
          trigger: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          measuredHeight: dialogRef.current?.offsetHeight ?? 0,
          preferredWidth: 320,
          isRtl: dir === 'rtl',
        }),
      );
    };

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [dir, triggerRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleOverlayPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  const perModel = cost?.available ? cost.perModel : [];

  return createPortal(
    // الغطاء يلتقط النقر خارجها فقط؛ لم يعد يتوسّط شيئاً.
    <div className="fixed inset-0 z-[9999]" onPointerDown={handleOverlayPointerDown}>
      <div
        ref={dialogRef}
        role="dialog"
        // ليست modal: نافذة مثبَّتة على زرّها لا تحجب ما تحتها، ووسمها modal
        // يجعل قارئ الشاشة يُخفي بقيّة الصفحة بلا داعٍ.
        aria-labelledby={titleId}
        dir={dir}
        tabIndex={-1}
        style={
          placement
            ? {
                position: 'fixed',
                // design-ok: إحداثيات portal فيزيائية بالضرورة — الشرح في
                // anchoredPopover.ts، والاتجاه محسوم هناك بـisRtl.
                top: placement.top,
                bottom: placement.bottom,
                left: placement.left,
                right: placement.right,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }
            : // مسار احتياطي فقط (لا زرّ مرجعي): تُترك في التدفّق بلا تثبيت
              // بدل إخفائها — نافذة غير مرئية لقارئ الشاشة أسوأ من واحدة
              // في موضع غير مثالي.
              { position: 'fixed', top: 16 }
        }
        className="overflow-y-auto rounded-xl border border-border/70 bg-background shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <span id={titleId} className="text-sm font-semibold text-foreground">{titleText}</span>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <ul className="space-y-1.5 px-4 py-3 text-sm" role="list">
          {workDurationText && (
            <li className="flex items-center gap-2 font-semibold text-foreground">
              <Clock3 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span>{workDurationLabel}</span>
              <bdi dir="ltr" className="tabular-nums">
                {workDurationText}
              </bdi>
            </li>
          )}
          {lines.map((line, index) => (
            <li
              key={line}
              className={index === 0 && !workDurationText ? 'font-medium text-foreground' : 'text-muted-foreground'}
            >
              {line}
            </li>
          ))}
        </ul>

        {perModel.length > 0 && (
          <div className="border-t border-border/40 px-4 py-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{perModelLabel}</p>
            <ul className="space-y-1.5 text-xs" role="list">
              {perModel.map((entry) => (
                <li
                  key={entry.model}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5"
                >
                  {/* اسم النموذج لاتيني داخل سياق عربي: <bdi> يعزله فلا يقلب
                      ما حوله ولا ينقلب ترتيبه. */}
                  <bdi className="min-w-0 break-words text-foreground">{entry.model}</bdi>
                  <bdi
                    dir="ltr"
                    className={cn(
                      'justify-self-end tabular-nums',
                      entry.costUsd === null ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {formatCostUsd(entry.costUsd)}
                  </bdi>
                  <bdi
                    dir={dir}
                    className="col-span-2 min-w-0 whitespace-normal break-words tabular-nums text-muted-foreground"
                  >
                    {cost?.provider.toLowerCase() === 'codex'
                      ? t('conversationCost.codexModelUsage', {
                          count: entry.requests,
                          tokens: formatCompactTokens(sumCostTokens(entry.tokens)),
                          defaultValue: '{{count}} threads · {{tokens}} processing units',
                        })
                      : t('conversationCost.requestModelUsage', {
                          count: entry.requests,
                          tokens: formatCompactTokens(sumCostTokens(entry.tokens)),
                          defaultValue: '{{count}} requests · {{tokens}} processing units',
                        })}
                  </bdi>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * شارة كلفة المحادثة في رأس المحادثة.
 *
 * ثلاث حالات لا رابع لها، وكلها صادقة:
 *  • `—` حين تتعذّر الكلفة (مزوّد لا يحفظ التوكنز، أو مسار خادمي لم يردّ) مع
 *    السبب في التلميح — **لا `$0.00`**.
 *  • `~$X` حين سُعِّر بعض النماذج فقط، والتلميح يسمّي ما لم يُسعَّر.
 *  • `$X` كاملاً — ويبقى التلميح ملزَماً بقول إن كان مبلغاً محاسَباً أم قيمة
 *    مكافئة لاستهلاك على اشتراك.
 */
export default function ConversationCostChip({
  workDurationMs,
  className,
}: ConversationCostChipProps) {
  const { t, i18n } = useTranslation('chat');
  const dir: 'rtl' | 'ltr' = i18n.language.startsWith('ar') ? 'rtl' : 'ltr';

  const [open, setOpen] = useState(false);
  // يقرأ من ConversationCostContext الذي يزوّده ChatInterface بدل استدعاء
  // hook ثانٍ — يضمن جلباً واحداً لكل استجابة من النموذج.
  const { cost, status } = useConversationCostContext();

  const display = resolveCostDisplay({ status, cost });

  const unavailableText = t('conversationCost.unavailable', {
    defaultValue: 'Estimated value is not available for this provider',
  });
  const pricingUnavailableText = t('conversationCost.pricingUnavailable', {
    defaultValue: 'Price unavailable — usage is recorded, but pricing is incomplete in the calculator',
  });
  const loadingText = t('conversationCost.loading', { defaultValue: 'Calculating…' });
  const refreshingText = t('conversationCost.refreshing', { defaultValue: 'Refreshing saved summary…' });
  const staleText = t('conversationCost.stale', { defaultValue: 'Showing the last saved summary' });
  const incompleteText = t('conversationCost.incompleteSnapshot', {
    defaultValue: 'Summary is still being completed',
  });
  const tokensLabel = t('conversationCost.totalTokens', { defaultValue: 'Processing units' });
  const tokensUnavailableText = t('conversationCost.tokensUnavailable', {
    defaultValue: 'Processing-unit total is not available',
  });

  const renderLine = useCallback(
    (line: CostSummaryLine): string => {
      switch (line.key) {
        case 'unavailable':
          return line.reason ? `${unavailableText} — ${line.reason}` : unavailableText;
        case 'pricingUnavailable':
          return line.models.length > 0 ? `${pricingUnavailableText}: ${line.models.join(', ')}` : pricingUnavailableText;
        case 'baseRateEstimate':
          return t('conversationCost.baseRateEstimate', {
            defaultValue: 'Astra estimate uses Standard base rates verified on 2026-09-06; Fast and long-context adjustments are not included. Actual charges may differ.',
          });
        case 'billed':
          return t('conversationCost.billed', { defaultValue: 'Billed usage' });
        case 'apiEquivalent':
          return t('conversationCost.apiEquivalent', {
            defaultValue:
              'API-equivalent value of this usage on a subscription — not an amount billed',
          });
        case 'partial': {
          // النصّ المترجَم جملة ثابتة بلا متغيّرات؛ أسماء النماذج تُلحَق بعده
          // بدل حشوها فيه. و`complete:false` قد تنشأ عن بنود بلا سعر معلن لا
          // عن نماذج مسمّاة — عندها لا ذيل أصلاً بدل قائمة فارغة.
          const text = t('conversationCost.partial', {
            defaultValue: 'Partial — some models have no published price',
          });
          return line.models.length > 0 ? `${text}: ${line.models.join(', ')}` : text;
        }
        case 'subagents':
          return t('conversationCost.subagents', {
            count: line.count,
            defaultValue: 'Includes subagent activity ({{count}} requests)',
          });
        case 'pricesAsOf':
          return t('conversationCost.pricesAsOf', {
            date: line.date,
            defaultValue: 'Prices as of {{date}}',
          });
        default:
          return '';
      }
    },
    [t, unavailableText, pricingUnavailableText],
  );

  const lines = useMemo(
    () => buildCostSummaryLines(cost).map(renderLine).filter(Boolean),
    [cost, renderLine],
  );

  const titleText = t('conversationCost.tooltipTitle', { defaultValue: 'Conversation summary' });
  const totalTokens = sumConversationCostTokens(cost);
  // Response duration has one source: the persisted response_turn_metrics
  // aggregate passed by the session store. cost.workDurationMs belongs to
  // usage accounting and must never affect response-time UI.
  const validWorkDurationMs = typeof workDurationMs === 'number'
    && Number.isSafeInteger(workDurationMs)
    && workDurationMs >= 0
    ? workDurationMs
    : null;
  const workDurationText = validWorkDurationMs === null
    ? null
    : formatWorkDuration(validWorkDurationMs);
  const workDurationLabel = t('conversationCost.workDuration', { defaultValue: 'Work time' });
  const snapshotStatus = resolveCostSnapshotStatus(cost, status);
  const snapshotStateText =
    snapshotStatus === 'refreshing'
      ? refreshingText
      : snapshotStatus === 'stale'
        ? staleText
        : snapshotStatus === 'incomplete'
          ? incompleteText
          : snapshotStatus === 'unavailable' && cost?.snapshotReason
            ? cost.snapshotReason
            : null;
  const tokenStateText =
    totalTokens !== null
      ? `${formatCostCount(totalTokens)} ${tokensLabel}`
      : display.kind === 'loading'
        ? loadingText
        : tokensUnavailableText;

  const stateText =
    display.kind === 'loading'
      ? loadingText
      : display.kind === 'unavailable'
        ? display.reason === 'pricing_unavailable' ? pricingUnavailableText : unavailableText
        : `${display.partial ? '~' : ''}${display.amount}${display.partial ? ` — ${t('conversationCost.partialAmount', { defaultValue: 'Partial' })}` : ''}`;

  // في حالة التعذّر يحمل أول سطرٍ النصَّ والسبب معاً، فتصديره بـ`stateText`
  // يكرّره حرفياً في التلميح.
  const costTooltip =
    lines.length === 0
      ? `${titleText}: ${stateText}`
      : display.kind === 'unavailable'
        ? lines.join('\n')
        : [stateText, ...lines].join('\n');
  const tooltip = [snapshotStateText, costTooltip, workDurationText && `${workDurationLabel}: ${workDurationText}`, tokenStateText]
    .filter(Boolean)
    .join('\n');
  const popoverLines = [snapshotStateText, tokenStateText, ...(lines.length > 0 ? lines : [stateText])].filter(
    (line): line is string => Boolean(line),
  );

  const triggerRef = useRef<HTMLButtonElement>(null);
  const handleToggle = useCallback(() => setOpen((previous) => !previous), []);
  const handleClose = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        title={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={[titleText, snapshotStateText, stateText, workDurationText && `${workDurationLabel}: ${workDurationText}`, tokenStateText]
          .filter(Boolean)
          .join('; ')}
        className={cn(
          'inline-flex h-7 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-lg bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-1.5 sm:px-2',
          open && 'bg-accent/80 text-foreground',
          className,
        )}
      >
        <CircleDollarSign
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            display.kind === 'amount' ? 'text-primary' : 'text-muted-foreground/70',
          )}
          aria-hidden
        />

        {(snapshotStatus === 'stale' || snapshotStatus === 'incomplete') && (
          <AlertTriangle
            data-testid="conversation-snapshot-warning"
            className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
            // اسم الزرّ الكامل يحمل snapshotStateText؛ إخفاء الأيقونة يمنع
            // قارئ الشاشة من تكرار الوصف مع إبقاء التحذير مرئياً للمبصر.
            aria-hidden
          />
        )}

        {display.kind === 'loading' && (
          <span className="h-3 w-8 shrink-0 animate-pulse rounded bg-muted/60" aria-hidden />
        )}

        {display.kind === 'unavailable' && (
          <span className="shrink-0 tabular-nums text-muted-foreground/70" aria-hidden>
            {COST_DASH}
          </span>
        )}

        {display.kind === 'amount' && (
          // المبلغ سلسلة لاتينية/رقمية: `dir="ltr"` داخل <bdi> يثبّت ترتيبها
          // ويعزلها عن الفقرة العربية المحيطة.
          <bdi dir="ltr" className="shrink-0 font-medium tabular-nums text-foreground">
            {display.partial ? '~' : ''}
            {display.amount}
          </bdi>
        )}

        <span className="mx-0.5 h-3 w-px shrink-0 bg-border/80" aria-hidden />

        <Clock3
          data-testid="conversation-work-duration-icon"
          className="h-3.5 w-3.5 shrink-0 text-primary/80"
          aria-hidden
        />

        {workDurationText ? (
          <bdi dir="ltr" className="shrink-0 font-medium tabular-nums text-foreground" aria-hidden>
            {workDurationText}
          </bdi>
        ) : (
          <span className="shrink-0 tabular-nums text-muted-foreground/70" aria-hidden>
            {COST_DASH}
          </span>
        )}

        <span className="mx-0.5 h-3 w-px shrink-0 bg-border/80" aria-hidden />

        {display.kind === 'loading' && (
          <span className="h-3 w-8 shrink-0 animate-pulse rounded bg-muted/60" aria-hidden />
        )}

        {display.kind !== 'loading' && (
          <bdi
            dir="ltr"
            className={cn(
              'shrink-0 tabular-nums',
              totalTokens === null ? 'text-muted-foreground/70' : 'font-medium text-foreground',
            )}
            aria-hidden
          >
            {totalTokens === null ? COST_DASH : formatCompactTokens(totalTokens)}
          </bdi>
        )}

      </button>

      {open && (
        <CostPopover
          cost={cost}
          lines={popoverLines}
          titleText={titleText}
          // زرّ إغلاق النافذة يعيد استعمال مفتاح «إغلاق» المترجَم أصلاً في
          // TokenUsageSummary — لا مفتاح جديداً لكلمة قائمة.
          closeLabel={t('contextRot.close', { defaultValue: 'Close' })}
          perModelLabel={t('conversationCost.perModel', { defaultValue: 'By model' })}
          workDurationLabel={workDurationLabel}
          workDurationText={workDurationText}
          dir={dir}
          triggerRef={triggerRef}
          onClose={handleClose}
        />
      )}
    </>
  );
}
