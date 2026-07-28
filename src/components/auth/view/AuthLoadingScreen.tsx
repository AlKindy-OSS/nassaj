import { useTranslation } from 'react-i18next';

import { useBranding } from '../../../contexts/BrandingContext';
import { useTheme } from '../../../contexts/ThemeContext';

const loadingDotAnimationDelays = ['0s', '0.1s', '0.2s'];

/**
 * First-paint splash shown while the auth status is being resolved.
 * Carries the custom branding (logo + title) when configured; while branding is
 * still loading it shows a neutral placeholder instead of flashing the stock
 * name for a frame.
 */
export default function AuthLoadingScreen() {
  const { t } = useTranslation('sidebar');
  const { isDarkMode } = useTheme();
  const {
    title: brandingTitle,
    logoUrl: brandingLogoUrl,
    logoDarkUrl: brandingLogoDarkUrl,
    splashHideTitle,
    isLoading: isBrandingLoading,
  } = useBranding();
  // على الشاشة الداكنة نفضّل النسخة الداكنة من الشعار المخصّص
  const effectiveBrandingLogoUrl = isDarkMode ? (brandingLogoDarkUrl ?? brandingLogoUrl) : brandingLogoUrl;

  // Owner opt-in: show the logo alone on the splash. Only honored when a
  // custom logo exists — otherwise the title stays so the screen is never
  // anonymous. The name is kept for screen readers via an sr-only heading.
  const hideTitle = !isBrandingLoading && splashHideTitle && Boolean(effectiveBrandingLogoUrl);

  // The placeholder is U+00A0 so the heading keeps its line box while loading.
  const displayTitle = isBrandingLoading
    ? ' '
    : brandingTitle ?? t('app.title', { defaultValue: 'ـنسَّاجـ' });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="text-center">
        <div className="mb-4 flex justify-center">
          {effectiveBrandingLogoUrl ? (
            <img src={effectiveBrandingLogoUrl} alt="" className="h-16 w-auto max-w-[160px] object-contain" />
          ) : (
            /* شعار نسّاج الافتراضي على شاشة التحميل */
            <img
              src={isDarkMode ? '/nassaj-logo-on-dark.svg' : '/nassaj-logo-on-light.svg'}
              alt="نسّاج"
              className="h-10 w-auto"
            />
          )}
        </div>

        <h1 className={hideTitle ? 'sr-only' : 'mb-2 text-2xl font-bold text-foreground'}>
          {displayTitle}
        </h1>

        <div className="flex items-center justify-center space-x-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full"
              style={{ animationDelay: delay, backgroundColor: 'hsl(var(--brand-accent, var(--primary)))' }}
            />
          ))}
        </div>

        <p className="mt-2 text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}
