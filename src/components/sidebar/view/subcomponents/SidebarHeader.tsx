import { BookOpen, CalendarClock, Folder, TerminalSquare, PanelLeftClose, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';

import { Button, Tooltip } from '../../../../shared/view/ui';
import { IS_PLATFORM } from '../../../../constants/config';
import { cn } from '../../../../lib/utils';
import { useBranding } from '../../../../contexts/BrandingContext';
import { useTheme } from '../../../../contexts/ThemeContext';
import type { SidebarSection } from '../../types/types';

type SidebarHeaderProps = {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
  runningTerminalsCount: number;
  onCollapseSidebar: () => void;
  scheduledMessagesCount: number;
  scheduledMessagesEnabled: boolean;
  scheduledMessagesActive: boolean;
  onOpenScheduledMessages: () => void;
  t: TFunction;
};

export default function SidebarHeader({
  activeSection,
  onSectionChange,
  runningTerminalsCount,
  onCollapseSidebar,
  scheduledMessagesCount,
  scheduledMessagesEnabled,
  scheduledMessagesActive,
  onOpenScheduledMessages,
  t,
}: SidebarHeaderProps) {
  const { title: brandingTitle, logoUrl, logoDarkUrl, logoOnly: brandingLogoOnly, nodeIconDataUri, nodeIconPosition, nodeIconHref } = useBranding();
  const { isDarkMode } = useTheme();
  // Dark theme prefers the dedicated dark logo and falls back to the main one.
  const brandingLogoUrl = isDarkMode ? (logoDarkUrl ?? logoUrl) : logoUrl;
  const displayTitle = brandingTitle ?? t('app.title');

  // Projects and Terminals swap the sidebar content; Scheduled is an app route.
  // They intentionally share one navigation row, but are links/actions rather
  // than ARIA tabs: the scheduled center does not control a local tabpanel.
  // Terminals is always listed; non-privileged users see a permission-denied
  // state in SidebarContent rather than having the tab hidden (ADR-063 amend).
  const sectionOptions: { value: SidebarSection; label: string; icon: LucideIcon }[] = [
    { value: 'projects', label: t('sections.projects'), icon: Folder },
    { value: 'terminals', label: t('sections.terminals'), icon: TerminalSquare },
  ];

  const sectionNavigation = (
    <nav
      className={cn(
        'grid h-8 [@media(pointer:coarse)]:h-9 min-w-0 flex-1 items-stretch rounded-lg bg-muted/50',
        scheduledMessagesEnabled ? 'grid-cols-3' : 'grid-cols-2',
      )}
      aria-label={t('sections.navigation')}
    >
      {sectionOptions.map((option) => {
        const isActive = !scheduledMessagesActive && activeSection === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onSectionChange(option.value)}
            className={cn(
              'flex h-full min-w-0 items-center justify-center gap-1 rounded-md px-1 text-xs leading-4 font-medium whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <option.icon className="sidebar-navigation-icon h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{option.label}</span>
            {option.value === 'terminals' && runningTerminalsCount > 0 && (
              <span aria-hidden="true" className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 px-1 text-[10px] font-semibold text-success">
                {runningTerminalsCount > 99 ? '99+' : runningTerminalsCount}
              </span>
            )}
          </button>
        );
      })}
      {scheduledMessagesEnabled && (
        <button
          type="button"
          aria-current={scheduledMessagesActive ? 'page' : undefined}
          onClick={onOpenScheduledMessages}
          className={cn(
            'relative flex h-full min-w-0 items-center justify-center gap-1 rounded-md px-1 text-xs leading-4 font-medium whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            scheduledMessagesActive ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <CalendarClock className="sidebar-navigation-icon h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{t('sections.scheduled')}</span>
          {scheduledMessagesCount > 0 && (
            <span aria-hidden="true" className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
              {scheduledMessagesCount > 99 ? '99+' : scheduledMessagesCount}
            </span>
          )}
        </button>
      )}
    </nav>
  );

  // Small server-identity badge shown next to the logo (null = hidden). With a
  // configured link it becomes a real anchor — and therefore stops being
  // decorative, so it needs an accessible name and an external-link target.
  const nodeIconImage = nodeIconDataUri ? (
    <img
      src={nodeIconDataUri}
      alt=""
      aria-hidden="true"
      className="h-5 w-5 flex-shrink-0 rounded-sm object-contain"
    />
  ) : null;

  const NodeIcon = nodeIconImage && nodeIconHref ? (
    <a
      href={nodeIconHref}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('tooltips.openNodeIconLink', 'Open server link')}
      title={nodeIconHref}
      className="flex flex-shrink-0 items-center rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
    >
      {nodeIconImage}
    </a>
  ) : nodeIconImage;

  // Wordmark mode: a single uploaded logo replaces the icon + title pair. The
  // title still reaches assistive tech through the img alt text.
  const LogoBlock = () => (brandingLogoOnly && brandingLogoUrl) ? (
    <img
      src={brandingLogoUrl}
      alt={displayTitle}
      className="-translate-y-0.5 h-8 w-auto min-w-0 max-w-[180px] object-contain object-left rtl:object-right"
    />
  ) : (
    <div className="-translate-y-0.5 flex min-w-0 items-center gap-2.5">
      {brandingLogoUrl ? (
        <img
          src={brandingLogoUrl}
          alt={displayTitle}
          className="h-7 w-auto max-w-[140px] flex-shrink-0 object-contain object-left rtl:object-right"
        />
      ) : (
        /* شعار نسّاج الافتراضي في الشريط الجانبي — وعي بالثيم */
        <img
          src={isDarkMode ? '/nassaj-logo-on-dark.svg' : '/nassaj-logo-on-light.svg'}
          alt={t('common:brand.logoAlt')}
          className="h-6 w-auto flex-shrink-0"
        />
      )}
      {brandingLogoUrl && (
        <h1 className="truncate text-sm font-semibold text-foreground">{displayTitle}</h1>
      )}
    </div>
  );

  return (
    <div data-app-header-surface style={{ backgroundColor: 'var(--app-header-surface, hsl(var(--background)))' }} className="pwa-header-safe flex-shrink-0 bg-background">
      {/* رأس موحَّد على كل المقاسات — المبدأ: نمط الجوّال أساس،
          ما يتفرّع فعلاً بجهاز الإدخال ينتقل إلى hover media.
          تفرّع مبرَّر يُبقى: زرّ الطيّ وزرّ الويكي على الفأرة فقط
          (جهاز اللمس يُغلق الشريط بسحبة لا بزرّ). */}
      {/* Safe-area padding belongs to this outer wrapper. The 82px sidebar
          rail is the 46px identity row plus a 36px navigation zone, preserving
          its alignment with the participant row below the 46px chat header. */}
      <div className="sidebar-top-rail -mb-2">
        <div className="app-top-rail flex items-center justify-between gap-2 px-3">
          {IS_PLATFORM ? (
            <div className="flex min-w-0 items-center gap-1">
              {nodeIconPosition === 'start' && NodeIcon}
              <a
                href="https://cloudcli.ai/dashboard"
                className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80 active:opacity-70"
                title={t('tooltips.viewEnvironments')}
              >
                <LogoBlock />
              </a>
              {nodeIconPosition === 'end' && NodeIcon}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              {nodeIconPosition === 'start' && NodeIcon}
              <Link
                to="/"
                className="flex min-w-0 items-center gap-2.5 rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:opacity-70"
                aria-label={t('tooltips.goHome', displayTitle)}
                title={t('tooltips.goHome', displayTitle)}
              >
                <LogoBlock />
              </Link>
              {nodeIconPosition === 'end' && NodeIcon}
            </div>
          )}

          <div className="flex flex-shrink-0 items-center gap-1">
            {/* الويكي وظيفةُ محتوى لا علاقة لها بجهاز الإدخال: كان مشروطاً
                بـ`hover:hover` فاختفى كلياً على الجوال والتابلت اللمسي. */}
            <Tooltip content={t('tooltips.openWiki')} position="bottom">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('tooltips.openWiki')}
                className="flex h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                onClick={() => window.open('/wiki', '_blank', 'noopener,noreferrer')}
              >
                <BookOpen className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            {/* الطيّ وحده يتفرّع، وبالمساحة لا بالإدخال: تحت `md` الشريطُ طبقةٌ
                منزلقة تُغلق باختيار جلسة، فلا معنى لطيّه إلى عمود ضيّق. */}
            <Button
              variant="ghost"
              size="sm"
              className="hidden h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground md:flex"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              {/* B-374: أيقونة لوحة اتجاهية — انظر التعليق الأصلي. */}
              <PanelLeftClose className="h-3.5 w-3.5 rtl:-scale-x-100" />
            </Button>
          </div>
        </div>
        <div className="sidebar-navigation-zone flex h-[var(--control-height-compact)] items-center px-3">
          {/* Primary sidebar navigation: three equal, non-wrapping destinations. */}
          {sectionNavigation}
        </div>
      </div>
    </div>
  );
}
