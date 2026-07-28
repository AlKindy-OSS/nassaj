import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ActivityIcon, XIcon } from 'lucide-react';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
};

// --- Configurable context-rot tuning ------------------------------------------------
// The effective context window is shorter than the model's nominal window because
// attention degrades ("context rot") well before the real limit is reached.
const EFFECTIVE_CONTEXT_FACTOR = 0.6; // sole knob for the color level only

// Color-level thresholds (share of the *effective* window via rotRatio).
const ATTENTION = 0.3; // >= here: start paying attention (yellow)
const WARNING = 0.5; // >= here: possible degradation (orange)
const CRITICAL = 0.7; // >= here: severe degradation (red)
// ------------------------------------------------------------------------------------

type RotLevel = 'safe' | 'attention' | 'warning' | 'critical';

const LEVEL_BAR_CLASS: Record<RotLevel, string> = {
  safe: 'bg-emerald-500',
  attention: 'bg-amber-500',
  warning: 'bg-orange-500',
  critical: 'bg-red-500',
};

// Border/text accent classes per level (dark-mode aware via the palette).
const LEVEL_ACCENT_CLASS: Record<RotLevel, string> = {
  safe: 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
  attention: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  warning: 'border-orange-500/40 text-orange-600 dark:text-orange-400',
  critical: 'border-red-500/50 text-red-600 dark:text-red-400',
};

// Tinted icon-chip background per level.
const LEVEL_CHIP_CLASS: Record<RotLevel, string> = {
  safe: 'bg-emerald-500/10',
  attention: 'bg-amber-500/10',
  warning: 'bg-orange-500/10',
  critical: 'bg-red-500/10',
};

// Popover border accent per level.
const LEVEL_POPOVER_BORDER: Record<RotLevel, string> = {
  safe: 'border-emerald-500/30',
  attention: 'border-amber-500/40',
  warning: 'border-orange-500/40',
  critical: 'border-red-500/50',
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

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const levelFromRatio = (ratio: number): RotLevel => {
  if (ratio >= CRITICAL) return 'critical';
  if (ratio >= WARNING) return 'warning';
  if (ratio >= ATTENTION) return 'attention';
  return 'safe';
};

// ---------------------------------------------------------------------------
// Popover — rendered into document.body via portal so it is never clipped
// by overflow:hidden ancestors. Centred on-screen so it is always visible
// on any viewport width including mobile.
// ---------------------------------------------------------------------------
type PopoverProps = {
  lines: string[];
  titleText: string;
  closeLabel: string;
  dir: 'rtl' | 'ltr';
  level: RotLevel;
  percentLabel: string;
  onClose: () => void;
};

function UsagePopover({
  lines,
  titleText,
  closeLabel,
  dir,
  level,
  percentLabel,
  onClose,
}: PopoverProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      onPointerDown={handleOverlayPointerDown}
      aria-hidden="false"
    >
      {/* Card */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={titleText}
        dir={dir}
        tabIndex={-1}
        className={`w-full max-w-xs rounded-xl border bg-background shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-primary sm:max-w-sm ${LEVEL_POPOVER_BORDER[level]}`}
        // Stop pointer events from bubbling to overlay so the card itself doesn't close.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <span className={`text-sm font-semibold ${LEVEL_ACCENT_CLASS[level]}`}>
            {titleText}
          </span>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                  ? `font-medium ${LEVEL_ACCENT_CLASS[level]}`
                  : 'text-muted-foreground'
              }
            >
              {line}
            </li>
          ))}
        </ul>

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
export default function TokenUsageSummary({ usage }: TokenUsageSummaryProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const dir: 'rtl' | 'ltr' = locale === 'ar' ? 'rtl' : 'ltr';

  const [open, setOpen] = useState(false);

  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? (usage.breakdown as Record<string, unknown>)
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  const totalTokens = readUsageNumber(usage?.total);
  const cacheRead = readUsageNumber(breakdown?.cacheRead);

  const hasWindow = totalTokens > 0 && Number.isFinite(totalTokens);

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    },
    [],
  );

  const handleClose = useCallback(() => setOpen(false), []);

  // --- Neutral / empty state: no valid window -----------------------------------
  if (!hasWindow) {
    const emptyLines = [
      usedTokens > 0
        ? `${usedTokens.toLocaleString(locale)} ${t('contextRot.label')}`
        : t('contextRot.empty'),
    ];

    return (
      <>
        <div
          className="inline-flex h-9 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground sm:gap-2 sm:px-2.5"
          title={usedTokens > 0 ? `${usedTokens.toLocaleString(locale)}` : t('contextRot.empty')}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <ActivityIcon className="h-3.5 w-3.5" />
          </span>
          <span className="shrink-0 font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
          <span className="hidden min-w-0 truncate text-muted-foreground/70 sm:inline">{t('contextRot.label')}</span>
        </div>

        {open && (
          <UsagePopover
            lines={emptyLines}
            titleText={t('contextRot.popoverTitle')}
            closeLabel={t('contextRot.close')}
            dir={dir}
            level="safe"
            percentLabel={t('contextRot.empty')}
            onClose={handleClose}
          />
        )}
      </>
    );
  }

  // Displayed percentage / bar / number = raw occupancy of the real window.
  const rawRatio = clamp01(usedTokens / totalTokens);
  // Color level = context-rot signal: raw occupancy of the *effective* window
  // (shorter than nominal because attention degrades before the real limit).
  const rotRatio = clamp01(usedTokens / (totalTokens * EFFECTIVE_CONTEXT_FACTOR));
  const level = levelFromRatio(rotRatio);
  const percentValue = rawRatio * 100;
  const percentLabel = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(rawRatio);

  // Multi-line content — same data used in both native tooltip and popover.
  const tooltipLines = [
    t('contextRot.levels.' + level),
    t('contextRot.tooltipUsed', {
      used: usedTokens.toLocaleString(locale),
      total: totalTokens.toLocaleString(locale),
    }),
    cacheRead > 0
      ? t('contextRot.tooltipCacheRead', { value: cacheRead.toLocaleString(locale) })
      : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <div
        // min-w-0 + overflow-hidden + nowrap: in a squeezed composer column the
        // token-count span shrinks and ellipsizes instead of wrapping out of the
        // fixed-height pill (viewport sm: breakpoints can't see pane width).
        className={`inline-flex h-9 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg border bg-background/70 px-2 text-xs shadow-sm transition-colors sm:gap-2 sm:px-2.5 ${LEVEL_ACCENT_CLASS[level]}`}
        title={tooltipLines.join('\n')}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('contextRot.percentUsed', { percent: percentLabel })}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
      >
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md ${LEVEL_CHIP_CLASS[level]}`}>
          <ActivityIcon className="h-3.5 w-3.5" />
        </span>

        {/* Progress bar: hidden on mobile to prevent the row from wrapping on
            narrow screens; visible from sm breakpoint (640 px) upward.
            B-282 — it SHRINKS (no `shrink-0`, `w-20` is a ceiling via basis):
            the pill's wrapper is `min-w-0` so it is the first thing squeezed in
            the composer row, and with a rigid bar the only thing left to give
            was the trailing content — so the percentage got clipped and the row
            showed a bar with no number. Turning up the effort adds the
            ULTRACODE badge beside it, which is what made this visible, but the
            defect was in this pill: the bar is decoration, the number is the
            information, so the bar yields first. */}
        <div
          className="hidden h-1.5 w-20 min-w-0 shrink basis-20 overflow-hidden rounded-full bg-border/60 sm:block"
          role="progressbar"
          aria-hidden="true"
          aria-valuenow={Math.round(percentValue)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full transition-[width,background-color] duration-500 ease-out ${LEVEL_BAR_CLASS[level]}`}
            style={{ width: `${percentValue}%` }}
          />
        </div>

        {/* The one value that must survive any squeeze — see the bar above. */}
        <span className="shrink-0 whitespace-nowrap font-medium tabular-nums text-foreground">
          {percentLabel}
        </span>
        <span className="hidden min-w-0 truncate tabular-nums text-muted-foreground/70 sm:inline">
          {formatTokenCount(usedTokens)}/{formatTokenCount(totalTokens)}
        </span>
      </div>

      {open && (
        <UsagePopover
          lines={tooltipLines}
          titleText={t('contextRot.popoverTitle')}
          closeLabel={t('contextRot.close')}
          dir={dir}
          level={level}
          percentLabel={t('contextRot.percentUsed', { percent: percentLabel })}
          onClose={handleClose}
        />
      )}
    </>
  );
}
