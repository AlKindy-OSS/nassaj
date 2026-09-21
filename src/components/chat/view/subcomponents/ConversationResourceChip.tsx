/**
 * ConversationResourceChip — ما تستهلكه هذه المحادثة من الجهاز، في رأسها.
 *
 * وُجد بعد حادثة 29–31 يوليو 2026: اجتمعت 14 محادثة و22 وكيلاً فرعياً على صندوق
 * بعشرة غيغابايت حتى سقط، ولم يكن في أي شاشة رقمٌ يقول «هذه المحادثة تأكل
 * 900MB». كل مشارك قدّر أن عمله خفيف لأن لا أحد كان يرى المجموع.
 *
 * ثلاث حالات صادقة لا رابع لها:
 *  • `—` حين تتعذّر النسبة (محادثة خاملة، أو نجت إعادة تشغيل ولم تُعثر عمليتها)
 *    مع السبب في التفصيل — **لا `0MB`**، فالصفر يُقرأ «لا تستهلك شيئاً».
 *  • رقم الذاكرة وحده حين لم تُجمع عيّنتا معالج بعد (‏`cpuPercent: null`).
 *  • ذاكرة + معالج حين توفّرا.
 *
 * وحالة **الجهاز** ليست هنا: المسارات المشتركة وswap لا تُنسب لمحادثة، فمكانها ذيل
 * الشريط الجانبي مع بقيّة تلمترية المضيف. رقمٌ للجهاز داخل شارة المحادثة
 * يُقرأ رقمَ المحادثة — وهو أسوأ من غيابه.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Activity, XIcon } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import {
  useSessionResources,
  type ResourceKind,
  type SessionResources,
} from '../../hooks/useSessionResources';

import { resolveAnchoredPlacement, type AnchoredPlacement } from './anchoredPopover';
import { formatMb, RESOURCE_DASH as DASH } from './conversationResourceFormat';

type ConversationResourceChipProps = {
  sessionId: string;
  /** حالة البثّ — ترفع وتيرة القياس أثناء العمل. */
  isLoading?: boolean;
  className?: string;
};


function ResourcePopover({
  resources,
  dir,
  titleText,
  closeLabel,
  triggerRef,
  onClose,
  t,
}: {
  resources: SessionResources | null;
  dir: 'rtl' | 'ltr';
  titleText: string;
  closeLabel: string;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);

  useLayoutEffect(() => {
    const reposition = () => {
      const trigger = triggerRef.current;
      if (!trigger || typeof window === 'undefined') return;
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
          preferredWidth: 300,
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleOverlayPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const kindLabel = (kind: ResourceKind): string =>
    t(`resources.kind.${kind}`, {
      defaultValue: { session: 'المحادثة', agent: 'وكلاء', browser: 'متصفّح', test: 'اختبارات', build: 'بناء', other: 'أخرى' }[kind],
    });

  return createPortal(
    <div className="fixed inset-0 z-[9999]" onPointerDown={handleOverlayPointerDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={titleText}
        dir={dir}
        tabIndex={-1}
        style={
          placement
            ? {
                position: 'fixed',
                // design-ok: إحداثيات portal فيزيائية بالضرورة — الاتجاه محسوم
                // داخل anchoredPopover بـisRtl.
                top: placement.top,
                bottom: placement.bottom,
                left: placement.left,
                right: placement.right,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }
            : { position: 'fixed', top: 16 }
        }
        className="overflow-y-auto rounded-xl border border-border/70 bg-background shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onPointerDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
          <p className="text-sm font-medium text-foreground">{titleText}</p>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="px-4 py-3 text-sm">
          {resources?.available ? (
            <>
              <p className="text-foreground">
                {t('resources.summary', {
                  defaultValue: 'الذاكرة {{mem}} · {{count}} عملية',
                  mem: formatMb(resources.memoryMb),
                  count: resources.processCount,
                })}
                {resources.cpuPercent !== null && (
                  <>
                    {' · '}
                    <bdi dir="ltr" className="tabular-nums">{resources.cpuPercent.toFixed(1)}%</bdi>
                    {' '}
                    {t('resources.cpu', { defaultValue: 'معالج' })}
                  </>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground/70">
                {resources.memorySource === 'pss'
                  ? t('resources.pssNote', {
                      defaultValue: 'قياس PSS — الصفحة المشتركة مقسومة على قرّائها، فلا تُعدّ مرّتين.',
                    })
                  : t('resources.rssNote', {
                      defaultValue: 'قياس RSS (تعذّر PSS) — قد يعدّ الصفحات المشتركة أكثر من مرّة.',
                    })}
              </p>

              {resources.breakdown.length > 1 && (
                <ul className="mt-2.5 space-y-1 text-xs" role="list">
                  {resources.breakdown.map(entry => (
                    <li key={entry.kind} className="flex items-center gap-2">
                      <bdi className="min-w-0 flex-1 truncate text-muted-foreground">
                        {kindLabel(entry.kind)}
                        {entry.processCount > 1 && ` ×${entry.processCount}`}
                      </bdi>
                      <bdi dir="ltr" className="shrink-0 tabular-nums text-foreground">
                        {formatMb(entry.memoryMb)}
                      </bdi>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              {t('resources.unattributed', {
                defaultValue: 'لا عملية حيّة منسوبة لهذه المحادثة الآن — محادثة خاملة، أو نجت إعادة تشغيل الخادم.',
              })}
            </p>
          )}
        </div>

      </div>
    </div>,
    document.body,
  );
}

export default function ConversationResourceChip({
  sessionId,
  isLoading,
  className,
}: ConversationResourceChipProps) {
  const { t, i18n } = useTranslation('chat');
  const dir: 'rtl' | 'ltr' = i18n.language.startsWith('ar') ? 'rtl' : 'ltr';
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const { resources, status } = useSessionResources(sessionId, { isLoading });

  const titleText = t('resources.title', { defaultValue: 'موارد المحادثة' });

  const chipText = useMemo(() => {
    if (!resources?.available) return DASH;
    return formatMb(resources.memoryMb);
  }, [resources]);

  const stateText = useMemo(() => {
    if (status === 'unavailable') return t('resources.unavailable', { defaultValue: 'غير متاحة' });
    if (!resources?.available) return t('resources.idle', { defaultValue: 'بلا عملية حيّة' });
    return chipText;
  }, [chipText, resources, status, t]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        title={`${titleText}: ${stateText}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${titleText}: ${stateText}`}
        className={cn(
          'inline-flex h-7 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-lg bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-1.5 sm:px-2',
          open && 'bg-accent/80 text-foreground',
          className,
        )}
      >
        <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <bdi dir="ltr" className="truncate tabular-nums">
          {chipText}
        </bdi>
      </button>
      {open && (
        <ResourcePopover
          resources={resources}
          dir={dir}
          titleText={titleText}
          closeLabel={t('resources.close', { defaultValue: 'إغلاق' })}
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          t={t as (key: string, options?: Record<string, unknown>) => string}
        />
      )}
    </>
  );
}
