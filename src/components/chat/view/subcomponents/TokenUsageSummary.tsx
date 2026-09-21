import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from 'lucide-react';

import { cacheUsagePresentation, contextUsagePresentation } from '../../hooks/contextUsagePresentation';

import { PromptInputButton } from '../../../../shared/view/ui';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  provider?: string;
  modelId?: string | null;
  /** بداية الجلسة (ISO) لتنبيه مرور ساعة؛ null = غير معروفة فلا تنبيه زمنياً. */
  sessionStartedAt?: string | null;
  /** معرّف الجلسة: يُصفّر التنبيهات التلقائية عند التبديل بين الجلسات. */
  sessionId?: string | null;
  /**
   * للمزوّدين بلا عدّاد توكنز (B-92): لا حلقة فارغة، لكن تنبيه مرور الساعة
   * يجب أن يظهر في كل المحادثات، فتُرسم الحلقة فقط حين يوجد تنبيه.
   */
  onlyWhenAlerting?: boolean;
};

// Claude's fixed policy is scoped to the actual carrier, never the model name.
export const COMPACT_ALERT_TOKENS = 150_000;
export const CLOSE_ALERT_TOKENS = 250_000;
export const SESSION_AGE_ALERT_MS = 60 * 60 * 1000;
const AGE_TICK_MS = 60 * 1000;
type OperatorAlert = 'compact' | 'close' | 'hour' | 'pressure';

/** Display recommendations only from validated current-context readings. */
export const operatorAlertsFor = (usedTokens: number | null, ageMs: number | null, provider: string, proposed: number | null = null): OperatorAlert[] => {
  const alerts: OperatorAlert[] = [];
  if (usedTokens !== null && Number.isFinite(usedTokens) && usedTokens >= 0) {
    if (provider === 'claude' && usedTokens >= CLOSE_ALERT_TOKENS) alerts.push('close');
    else if (provider === 'claude' && usedTokens >= COMPACT_ALERT_TOKENS) alerts.push('compact');
    else if (provider !== 'claude' && proposed !== null && proposed > 0 && usedTokens >= proposed) alerts.push('pressure');
  }
  if (ageMs !== null && ageMs >= SESSION_AGE_ALERT_MS) alerts.push('hour');
  return alerts;
};

const parseStartedAt = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** عمر الجلسة بالمللي ثانية، يُحدَّث كل دقيقة؛ null حين البداية مجهولة. */
function useSessionAgeMs(sessionStartedAt: string | null | undefined): number | null {
  const startedMs = parseStartedAt(sessionStartedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedMs === null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [startedMs]);
  return startedMs === null ? null : Math.max(0, now - startedMs);
}

// نفس هندسة أزرار أدوات المُؤلِّف (h-8 w-8) مع توسيط الحلقة داخل الزر.
// بلا خلفية عند المرور (كزرّ مستوى التفكير المجاور): الخلفية `ghost` مربّعٌ
// مستدير الحواف يحتضن شكلاً دائرياً بحجمه تقريباً، فيقرأه العين هالةً مربّعة
// حول دائرة لا تمييزَ تحويم. البديل إشارةُ تحويم بلا سطح: خفوت طفيف.
// الحلقة تملأ مساحة الزر 32px، لتساوي قطر دائرة مستوى التفكير.
const TRIGGER_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 shadow-none transition-opacity hover:bg-transparent hover:opacity-75 hover:shadow-none active:bg-transparent [&_svg]:size-8';

type RotLevel = 'safe' | 'attention' | 'warning' | 'critical';

// نبرات الحالة من الرموز (`--success`/`--warning`/`--danger`) لا من درجات
// tailwind الخام: هي المعايَرة المعتمدة في المشروع (B-399)، وتتبع الثيم وأطقم
// العلامة، وتُغني عن `dark:` variant فيسقط معها فخّ ابتلاع الصنف غير المشروط.
// المستويات أربعة واللون ثلاث درجات: التصعيد من «تحذير» إلى «حرج» يحمله النصّ
// في النافذة والنسبة الملوّنة داخل الحلقة، لا لونٌ رابع لا رمز له.
const LEVEL_RING_CLASS: Record<RotLevel, string> = {
  safe: 'text-success',
  attention: 'text-warning',
  warning: 'text-danger',
  critical: 'text-danger',
};

// نبرة النصّ لكل مستوى (عنوان النافذة وسطرها الأول).
const LEVEL_ACCENT_CLASS: Record<RotLevel, string> = {
  safe: 'text-success',
  attention: 'text-warning',
  warning: 'text-danger',
  critical: 'text-danger',
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// ---------------------------------------------------------------------------
// Circular gauge — the trigger itself. The arc length *is* the occupancy, so
// the at-a-glance signal is the shape (plus its color level); the exact
// used/total numbers are one hover (or one light press) away, and the full
// breakdown one click away.
// ---------------------------------------------------------------------------
// 32px داخل زر 32px (h-8 w-8) لمطابقة قطر دائرة مستوى التفكير.
const RING_SIZE = 32;
// سماكة تقرأ بوضوح عند 32px من دون أن تبدو أثقل من الأيقونات المجاورة.
const RING_STROKE = 2;
// شفافية مسار الخلفية: المسار بلون المستوى نفسه لا برمادي محايد، فيُقرأ القوس
// وسريره جسماً واحداً — الرمادي كان يجعلهما طبقتين متنافرتين على سطح فاتح.
const RING_TRACK_OPACITY = 0.15;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function UsageRing({
  ratio,
  level,
  centerText,
}: {
  ratio: number;
  level: RotLevel;
  centerText: string;
}) {
  const center = RING_SIZE / 2;

  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className={`shrink-0 ${LEVEL_RING_CLASS[level]}`}
      aria-hidden="true"
      focusable="false"
    >
      {/* Track — بلون المستوى مخفّفاً، لا برمادي محايد */}
      <circle
        cx={center}
        cy={center}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity={RING_TRACK_OPACITY}
        strokeWidth={RING_STROKE}
      />
      {/* Arc — starts at 12 o'clock and fills clockwise in both directions
          (a gauge reads as a clock, not as text, so it is not mirrored in RTL). */}
      <circle
        cx={center}
        cy={center}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamp01(ratio))}
        transform={`rotate(-90 ${center} ${center})`}
        className="transition-[stroke-dashoffset,color] duration-500 ease-out"
      />
      <text
        x={center}
        y={center}
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-foreground text-[10px] font-semibold tabular-nums"
      >
        {centerText}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Popover — rendered into document.body via portal so it is never clipped
// by overflow:hidden ancestors, and anchored *above the ring* (falling back
// below it only when there is no room) so the numbers stay visually attached
// to the gauge they describe instead of jumping to the middle of the screen.
// ---------------------------------------------------------------------------
type PopoverProps = {
  lines: string[];
  cache: ReturnType<typeof cacheUsagePresentation>;
  trailingLines: string[];
  titleText: string;
  closeLabel: string;
  dir: 'rtl' | 'ltr';
  level: RotLevel;
  percentLabel: string;
  anchor: HTMLElement | null;
  onClose: () => void;
};

function UsagePopover({
  lines,
  cache,
  trailingLines,
  titleText,
  closeLabel,
  dir,
  level,
  percentLabel,
  anchor,
  onClose,
}: PopoverProps) {
  const { t, i18n } = useTranslation('chat');
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure after paint: the card's height depends on how many lines the
  // provider actually supplied, so it cannot be known before rendering.
  useLayoutEffect(() => {
    const card = dialogRef.current;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    const a = anchor?.getBoundingClientRect();
    if (!a) {
      // No anchor (shouldn't happen) — fall back to screen-centred.
      setPos({
        top: Math.max(8, (window.innerHeight - height) / 2),
        left: Math.max(8, (window.innerWidth - width) / 2),
      });
      return;
    }
    const left = Math.min(
      Math.max(8, a.left + a.width / 2 - width / 2),
      Math.max(8, window.innerWidth - width - 8),
    );
    const top = a.top - height - 8 >= 8 ? a.top - height - 8 : a.bottom + 8;
    setPos({ top: Math.max(8, Math.min(top, window.innerHeight - height - 8)), left });
  }, [anchor, lines.length, cache.state, cache.scope, trailingLines.length]);

  // Close on Escape key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus the dialog container on mount for keyboard users.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleOverlayPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Close only when the transparent overlay itself is clicked, not the card.
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  return createPortal(
    // Transparent full-screen overlay to capture outside clicks.
    <div
      className="fixed inset-0 z-[9999]"
      onPointerDown={handleOverlayPointerDown}
      aria-hidden="false"
    >
      {/* Card — anchored above the ring */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={titleText}
        dir={dir}
        tabIndex={-1}
        // design-ok: إحداثيات مقيسة من getBoundingClientRect في فضاء الviewport
        // الفيزيائي — inset-inline لا معنى له هنا لأن الرقم محسوب لا منطقي.
        style={{
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          visibility: pos ? 'visible' : 'hidden',
        }}
        // نفس سطح القوائم المنبثقة في المُؤلِّف (مبدّل النموذج): rounded-xl و
        // border-border و bg-popover و shadow-xl — النبرة الملوّنة في النصّ لا
        // في الإطار، فلا يظهر صندوق أحمر/أخضر غريب عن بقية الطبقات.
        className="fixed max-h-[calc(100dvh-1rem)] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // Stop pointer events from bubbling to overlay so the card itself doesn't close.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          {/* نقطة الحالة ثم العنوان بلون النصّ العادي — نفس عرف زرّ الوضع
              (chat⇄agent) في الصفّ نفسه: اللون إشارة صغيرة لا صبغة للعنوان. */}
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${LEVEL_ACCENT_CLASS[level]}`}
            />
            {titleText}
          </span>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body — one line per entry */}
        <ul className="space-y-1.5 px-4 py-3 text-sm text-foreground" role="list">
          {lines.map((line, i) => (
            <li
              key={i}
              className={
                i === 0
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground'
              }
            >
              {line}
            </li>
          ))}
        </ul>

        <section aria-label={t('contextRot.cache.title')} className="border-t border-border/60 px-4 py-3 text-sm">
          <h3 className="font-semibold text-foreground">{t('contextRot.cache.title')}</h3>
          <p className="mt-1 text-foreground" data-testid="cache-reuse">
            {cache.ratio !== null
              ? t('contextRot.cache.ratio', { percent: new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 0 }).format(cache.ratio) })
              : t(cache.state === 'empty' ? 'contextRot.cache.empty' : 'contextRot.cache.unknown')}
          </p>
          {cache.scope && <p className="mt-1 text-muted-foreground">{t(`contextRot.cache.scope.${cache.scope}`)}{cache.historical ? ` — ${t('contextRot.cache.history')}` : ''}</p>}
          {cache.ratio !== null && <p className="mt-1 tabular-nums text-muted-foreground">{t('contextRot.cache.counts', { read: cache.read?.toLocaleString(i18n.language), input: cache.input?.toLocaleString(i18n.language) })}</p>}
          {cache.source && <p className="mt-1 break-words text-muted-foreground">{t('contextRot.cache.source', { source: t(`contextRot.cache.sources.${cache.provider === 'claude' || cache.provider === 'codex' ? cache.provider : 'harness'}`) })}</p>}
          {cache.observedAt && <p className="mt-1 text-muted-foreground">{t('contextRot.cache.observed', { time: new Date(cache.observedAt).toLocaleString(i18n.language) })}</p>}
          <p className="mt-2 text-muted-foreground">{t('contextRot.cache.disclaimer')}</p>
        </section>
        {trailingLines.length > 0 && <ul className="space-y-1.5 border-t border-border/60 px-4 py-3 text-sm text-muted-foreground">{trailingLines.map(line => <li key={line}>{line}</li>)}</ul>}

        {/* Footer percentage bar */}
        <div className="border-t border-border/40 px-4 pb-4 pt-2">
          <p className="mb-1.5 text-xs text-muted-foreground">{percentLabel}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
/** Shows measured occupancy separately from provider compaction recommendations. */
export default function TokenUsageSummary({ usage, provider = '', modelId = null, sessionStartedAt = null, sessionId = null, onlyWhenAlerting = false }: TokenUsageSummaryProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const dir: 'rtl' | 'ltr' = locale === 'ar' ? 'rtl' : 'ltr';

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const reading = contextUsagePresentation(usage, provider, sessionId, modelId);
  const cache = cacheUsagePresentation(usage, provider, sessionId, modelId);
  const usedTokens = reading.used;
  const totalTokens = reading.window;
  const cumulativeUsed = reading.cumulative;
  const hasWindow = usedTokens !== null && totalTokens !== null;
  const policyLines = [
    reading.newSession !== null ? t('contextRot.cache.newSessionThreshold', { value: reading.newSession.toLocaleString(locale) }) : null,
    reading.native !== null ? t('contextRot.nativeThreshold', { value: reading.native.toLocaleString(locale) }) : null,
    reading.proposed !== null ? t(provider === 'claude' ? 'contextRot.cache.ownerThreshold' : 'contextRot.cache.experimentalThreshold', { value: reading.proposed.toLocaleString(locale) }) : t('contextRot.thresholdUnknown'),
  ].filter(Boolean) as string[];
  const trailingLines = [
    reading.lastInput !== null ? t('contextRot.lastInput', { value: reading.lastInput.toLocaleString(locale) }) : null,
    cumulativeUsed !== null ? t('contextRot.coordinatorTotal', { value: cumulativeUsed.toLocaleString(locale) }) : null,
  ].filter(Boolean) as string[];

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);

  const handleClose = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);

  // --- Operator alerts: blink the ring and open the card once per threshold ----
  const ageMs = useSessionAgeMs(sessionStartedAt);
  const alerts = operatorAlertsFor(usedTokens, ageMs, provider, reading.proposed);
  const alertKey = alerts.join('+');
  const announcedRef = useRef<string>('');
  useEffect(() => {
    announcedRef.current = '';
    setOpen(false);
  }, [sessionId, provider, modelId]);
  useEffect(() => {
    if (!alertKey || announcedRef.current === alertKey) return;
    announcedRef.current = alertKey;
    setOpen(true);
  }, [alertKey, sessionId, provider, modelId]);
  const alertLines = alerts.map((alert) =>
    t(`contextRot.alerts.${alert}`, {
      defaultValue:
        alert === 'close'
          ? 'At 250K tokens — consider continuing in a new conversation.'
          : alert === 'compact'
            ? 'Over 150K tokens — run /compact now.'
            : alert === 'pressure' ? 'Proposed compaction threshold reached.' : 'This session is over an hour old — consider saving a continuation summary.',
    }),
  );
  const alertLevel: RotLevel | null = alerts.includes('close')
    ? 'critical'
    : alerts.length > 0
      ? 'warning'
      : null;
  const ringClass = alerts.length > 0 ? 'animate-pulse' : '';

  if (onlyWhenAlerting && alerts.length === 0) return null;

  // --- Neutral / empty state: no valid window -----------------------------------
  if (!hasWindow) {
    // B-823: a lookup that FAILED must not read as "no tokens used yet". The two
    // states look alike (both have no window) but mean opposite things — one is a
    // fresh session, the other is a number we could not read — so the failure gets
    // its own wording, its own attention tone and its own '?' in the ring.
    const isUnavailable = Boolean(sessionId || usage);
    const unavailableLabel = t('contextRot.unavailable', {
      defaultValue: 'Context usage unavailable',
    });
    const emptyLabel = isUnavailable ? unavailableLabel : t('contextRot.empty');
    const emptyLevel: RotLevel = alertLevel ?? (isUnavailable ? 'attention' : 'safe');

    const emptyLines = [
      ...alertLines,
      ...policyLines,
      usedTokens !== null
        ? `${usedTokens.toLocaleString(locale)} ${t('contextRot.label')}`
        : emptyLabel,
    ];

    return (
      <>
        <PromptInputButton
          ref={triggerRef}
          className={TRIGGER_CLASS}
          tooltip={{
            content: usedTokens !== null ? `${formatTokenCount(usedTokens)}/—` : emptyLabel,
          }}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={[...alertLines, emptyLabel].join(' ')}
          onClick={handleToggle}
        >
          <span className={`contents ${ringClass}`}>
            <UsageRing ratio={0} level={emptyLevel} centerText={isUnavailable ? '?' : '—'} />
          </span>
        </PromptInputButton>

        {open && (
          <UsagePopover
            cache={cache}
            trailingLines={trailingLines}
            lines={emptyLines}
            titleText={t('contextRot.popoverTitle')}
            closeLabel={t('contextRot.close')}
            dir={dir}
            level={emptyLevel}
            percentLabel={emptyLabel}
            anchor={triggerRef.current}
            onClose={handleClose}
          />
        )}
      </>
    );
  }

  // Displayed percentage / bar / number = raw occupancy of the real window.
  const rawRatio = clamp01(usedTokens / totalTokens);
  // Color represents the measured threshold crossing, never an inferred quality loss.
  const level: RotLevel = alertLevel ?? 'safe';
  const percentValue = rawRatio * 100;
  const percentLabel = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(rawRatio);
  const percentDigits = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(Math.round(percentValue));

  // Multi-line content — same data used in both native tooltip and popover.
  const tooltipLines = [
    t('contextRot.tooltipUsed', {
      used: usedTokens.toLocaleString(locale),
      total: totalTokens.toLocaleString(locale),
    }),
    ...alertLines,
    t(reading.proposed === null ? 'contextRot.thresholdUnknown' : alerts.includes('pressure') || alerts.includes('compact') || alerts.includes('close') ? 'contextRot.pressureReached' : 'contextRot.pressureBelow'),
    ...policyLines,
  ].filter(Boolean) as string[];

  return (
    <>
      {/* B-282 note retired with the pill: the ring is a fixed 32px square, so
          nothing inside it can be squeezed out by a narrow composer column —
          there is no bar to clip and no trailing number to truncate. */}
      <PromptInputButton
        ref={triggerRef}
        className={TRIGGER_CLASS}
        // التلميح من مكوّن التلميح المشترك نفسه الذي تستعمله بقية أزرار الصفّ:
        // نفس السطح المقلوب ونفس التأخير، ويعطي التحويم على الفأرة والضغطة
        // المطوّلة على اللمس مجّاناً — بدل تلميح خاصّ يشبه المشروع ولا يطابقه.
        tooltip={{
          content: `${formatTokenCount(usedTokens)}/${formatTokenCount(totalTokens)}`,
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={[...alertLines, t('contextRot.percentUsed', { percent: percentLabel })].join(' ')}
        onClick={handleToggle}
      >
        <span
          role="progressbar"
          aria-valuenow={Math.round(percentValue)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('contextRot.barAria')}
          className={`contents ${ringClass}`}
        >
          {/* الرقم داخل الحلقة بلا علامة «٪»: القوس نفسه يقول إن الوحدة نسبة،
          والعلامة تسرق عرضاً من رقم يجب أن يبقى مقروءاً في 32px. النسبة
              كاملةً تبقى في الاسم المتاح لقارئ الشاشة وفي النافذة. */}
          <UsageRing ratio={rawRatio} level={level} centerText={percentDigits} />
        </span>
      </PromptInputButton>

      {open && (
        <UsagePopover
          cache={cache}
          trailingLines={trailingLines}
          lines={tooltipLines}
          titleText={t('contextRot.popoverTitle')}
          closeLabel={t('contextRot.close')}
          dir={dir}
          level={level}
          percentLabel={t('contextRot.percentUsed', { percent: percentLabel })}
          anchor={triggerRef.current}
          onClose={handleClose}
        />
      )}
    </>
  );
}
