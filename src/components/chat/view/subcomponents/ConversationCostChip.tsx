import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CircleDollarSign, XIcon } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { useConversationCost } from '../../hooks/useConversationCost';
import { resolveAnchoredPlacement, type AnchoredPlacement } from './anchoredPopover';
import {
  buildCostSummaryLines,
  COST_DASH,
  formatCompactTokens,
  formatCostCount,
  formatCostUsd,
  resolveCostDisplay,
  sumCostTokens,
  type ConversationCost,
  type CostSummaryLine,
} from './conversationCostFormat';

type ConversationCostChipProps = {
  sessionId: string;
  /**
   * حالة البثّ في المحادثة. هبوطها (true ← false) هو محفّز إعادة الجلب
   * الوحيد — لا استطلاع دوري.
   */
  isLoading?: boolean;
  className?: string;
};

type CostPopoverProps = {
  cost: ConversationCost | null;
  lines: string[];
  titleText: string;
  closeLabel: string;
  perModelLabel: string;
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
  dir,
  triggerRef,
  onClose,
}: CostPopoverProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
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
        aria-label={titleText}
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
          <span className="text-sm font-semibold text-foreground">{titleText}</span>
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
          {lines.map((line, index) => (
            <li
              key={line}
              className={index === 0 ? 'font-medium text-foreground' : 'text-muted-foreground'}
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
                <li key={entry.model} className="flex items-baseline gap-2">
                  {/* اسم النموذج لاتيني داخل سياق عربي: <bdi> يعزله فلا يقلب
                      ما حوله ولا ينقلب ترتيبه. */}
                  <bdi className="min-w-0 flex-1 truncate text-foreground">{entry.model}</bdi>
                  <bdi dir="ltr" className="shrink-0 tabular-nums text-muted-foreground/70">
                    {formatCostCount(entry.requests)}×{formatCompactTokens(sumCostTokens(entry.tokens))}
                  </bdi>
                  <bdi
                    dir="ltr"
                    className={cn(
                      'shrink-0 tabular-nums',
                      entry.costUsd === null ? 'text-muted-foreground/60' : 'text-foreground',
                    )}
                  >
                    {formatCostUsd(entry.costUsd)}
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
  sessionId,
  isLoading,
  className,
}: ConversationCostChipProps) {
  const { t, i18n } = useTranslation('chat');
  const dir: 'rtl' | 'ltr' = i18n.language.startsWith('ar') ? 'rtl' : 'ltr';

  const [open, setOpen] = useState(false);
  const { cost, status } = useConversationCost(sessionId, { isLoading });

  const display = resolveCostDisplay({ status, cost });

  const label = t('conversationCost.label', { defaultValue: 'Cost' });
  const unavailableText = t('conversationCost.unavailable', {
    defaultValue: 'Cost is not available for this provider',
  });
  const loadingText = t('conversationCost.loading', { defaultValue: 'Calculating…' });

  const renderLine = useCallback(
    (line: CostSummaryLine): string => {
      switch (line.key) {
        case 'unavailable':
          return line.reason ? `${unavailableText} — ${line.reason}` : unavailableText;
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
    [t, unavailableText],
  );

  const lines = useMemo(
    () => buildCostSummaryLines(cost).map(renderLine).filter(Boolean),
    [cost, renderLine],
  );

  const titleText = t('conversationCost.tooltipTitle', { defaultValue: 'Conversation cost' });

  const stateText =
    display.kind === 'loading'
      ? loadingText
      : display.kind === 'unavailable'
        ? unavailableText
        : `${display.partial ? '~' : ''}${display.amount}`;

  // في حالة التعذّر يحمل أول سطرٍ النصَّ والسبب معاً، فتصديره بـ`stateText`
  // يكرّره حرفياً في التلميح.
  const tooltip =
    lines.length === 0
      ? `${titleText}: ${stateText}`
      : display.kind === 'unavailable'
        ? lines.join('\n')
        : [stateText, ...lines].join('\n');

  const handleToggle = useCallback(() => setOpen((previous) => !previous), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        title={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${titleText}: ${stateText}`}
        className={cn(
          'inline-flex h-7 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-lg border border-border/70 bg-background/70 px-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:gap-1.5 sm:px-2',
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

        <span className="hidden min-w-0 truncate text-muted-foreground/70 sm:inline">{label}</span>
      </button>

      {open && (
        <CostPopover
          cost={cost}
          lines={lines.length > 0 ? lines : [stateText]}
          titleText={titleText}
          // زرّ إغلاق النافذة يعيد استعمال مفتاح «إغلاق» المترجَم أصلاً في
          // TokenUsageSummary — لا مفتاح جديداً لكلمة قائمة.
          closeLabel={t('contextRot.close', { defaultValue: 'Close' })}
          perModelLabel={t('conversationCost.perModel', { defaultValue: 'By model' })}
          dir={dir}
          triggerRef={triggerRef}
          onClose={handleClose}
        />
      )}
    </>
  );
}
