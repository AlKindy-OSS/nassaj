import { useCallback, useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainContentHeaderProps } from '../../types/types';
import { Tooltip } from '../../../../shared/view/ui';
import { useUiPreferences, type TabsDisplayMode } from '../../../../hooks/useUiPreferences';
import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import HeaderUsageIndicator from './HeaderUsageIndicator';

// Cyclic order of the header tab-display modes: full -> compact -> minimal -> hidden -> full.
const NEXT_TABS_MODE: Record<TabsDisplayMode, TabsDisplayMode> = {
  full: 'compact',
  compact: 'minimal',
  minimal: 'hidden',
  hidden: 'full',
};

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  isMobile,
  onMenuClick,
}: MainContentHeaderProps) {
  const { t, i18n } = useTranslation('common');
  const { preferences, setPreference } = useUiPreferences();

  // Cyclic quick-toggle for the header tab switcher. `tabsDisplayMode` is the
  // single source of truth (full | compact | hidden); each press advances to the
  // next mode. The legacy "Compact tabs (icons only)" appearance checkbox writes
  // the derived `tabsIconOnly` flag, which the preferences reducer keeps in sync
  // with `tabsDisplayMode` (compact <-> checked), so button and checkbox stay one
  // source of truth across reloads and instances.
  const tabsMode = preferences.tabsDisplayMode;
  const nextMode = NEXT_TABS_MODE[tabsMode];

  const cycleTabsMode = useCallback(() => {
    setPreference('tabsDisplayMode', NEXT_TABS_MODE[tabsMode]);
  }, [setPreference, tabsMode]);

  // Chevron direction encodes the fold/unfold intent:
  //   full    → pointing toward inline-end (collapse inward)
  //   compact → pointing toward inline-end (collapse further)
  //   minimal → pointing toward inline-end (collapse further, tabs already gone)
  //   hidden  → pointing toward inline-start (expand outward)
  // We use ChevronRight/ChevronLeft and flip via `dir` on the document so RTL
  // layouts receive the mirrored glyph automatically (ChevronLeft = expand in LTR
  // but = collapse in RTL; we invert the mapping so intent stays constant).
  const isRtl = i18n.dir?.() === 'rtl' || document?.documentElement?.dir === 'rtl';
  // In LTR: collapse = Right, expand = Left. In RTL: mirrored automatically by the
  // browser when we use the logical chevron mapping below.
  const ChevronIcon = tabsMode === 'hidden'
    ? (isRtl ? ChevronRight : ChevronLeft)   // expand: point toward start
    : (isRtl ? ChevronLeft : ChevronRight);  // collapse: point toward end (full/compact/minimal)

  // No dedicated locale keys yet (locales are owned elsewhere); supply correct
  // per-language defaults so the control is always meaningful for a11y. Future
  // translations of `mainContent.tabsDisplayToggle.*` override these automatically.
  const isArabic = i18n.language?.startsWith('ar');
  const modeName = (mode: TabsDisplayMode): string => {
    if (mode === 'full') {
      return t('mainContent.tabsDisplayToggle.full', {
        defaultValue: isArabic ? 'فرد (أيقونات + نصوص)' : 'Expanded (icons + text)',
      });
    }
    if (mode === 'compact') {
      return t('mainContent.tabsDisplayToggle.compact', {
        defaultValue: isArabic ? 'ضمّ (أيقونات فقط)' : 'Compact (icons only)',
      });
    }
    if (mode === 'minimal') {
      return t('mainContent.tabsDisplayToggle.minimal', {
        defaultValue: isArabic ? 'مصغَّر (تبويبات مخفية، مؤشر الحصص ظاهر)' : 'Minimal (tabs hidden, usage visible)',
      });
    }
    return t('mainContent.tabsDisplayToggle.hidden', {
      defaultValue: isArabic ? 'إخفاء الكل' : 'Hidden all',
    });
  };

  // Tooltip/label states the current mode and the next action on press.
  const toggleLabel = t('mainContent.tabsDisplayToggle.label', {
    current: modeName(tabsMode),
    next: modeName(nextMode),
    defaultValue: isArabic
      ? `عرض التبويبات: ${modeName(tabsMode)} — اضغط للانتقال إلى ${modeName(nextMode)}`
      : `Tabs display: ${modeName(tabsMode)} — press to switch to ${modeName(nextMode)}`,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
          />
        </div>

        <HeaderUsageIndicator tabsMode={tabsMode} sessionProvider={selectedSession?.__provider} />

        <div className="flex min-w-0 flex-shrink items-center gap-1.5 sm:flex-shrink-0">
          {/* Tab group renders only when the display mode is "full" or "compact".
              In "minimal" and "hidden" it is not mounted at all (no offscreen DOM).
              "minimal" keeps the usage indicator visible; "hidden" suppresses both. */}
          {(tabsMode === 'full' || tabsMode === 'compact') && (
            <div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">
              {canScrollLeft && (
                <div className="pointer-events-none absolute inset-y-0 start-0 z-10 w-6 bg-gradient-to-r from-background to-transparent rtl:bg-gradient-to-l" />
              )}
              <div
                ref={scrollRef}
                onScroll={updateScrollState}
                className="scrollbar-hide overflow-x-auto"
              >
                <MainContentTabSwitcher
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                />
              </div>
              {canScrollRight && (
                <div className="pointer-events-none absolute inset-y-0 end-0 z-10 w-6 bg-gradient-to-l from-background to-transparent rtl:bg-gradient-to-r" />
              )}
            </div>
          )}

          {/* Cyclic tabs-display toggle (full -> compact -> minimal -> hidden -> full),
              pinned to the trailing (inline-end) edge of the header. Rendered as a
              small circular button containing a directional chevron: the chevron
              points toward inline-end when collapsing (full/compact/minimal) and
              toward inline-start when expanding (hidden), matching RTL layouts. */}
          <Tooltip content={toggleLabel} position="bottom">
            <button
              type="button"
              onClick={cycleTabsMode}
              aria-label={toggleLabel}
              title={toggleLabel}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-border/50 bg-background text-muted-foreground/70 transition-colors hover:border-border hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronIcon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
