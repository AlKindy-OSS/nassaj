import { Info, Scale } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';
import { IS_PLATFORM } from '../../../../constants/config';
import {
  SOURCE_REPO_URL,
  SOURCE_REPO_LABEL,
} from '../../../../constants/sourceRepo';
import SettingsSection from '../SettingsSection';
import StatusBadge from '../StatusBadge';

// AGPL-3.0 §13: this tab is where a user finds the source of the instance they
// are using, so the destination comes from the shared configured constant — never
// a repo hardcoded in a component.
const NASSAJ_GITHUB_URL = SOURCE_REPO_URL;
const SOURCE_LABEL = SOURCE_REPO_LABEL;
const UPSTREAM_GITHUB_URL = 'https://github.com/siteboon/claudecodeui';

const LINK_CLASS = 'font-medium text-foreground/80 underline-offset-2 hover:underline';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

/**
 * تبويب «عن».
 *
 * **كل نصّه صار مفتاحاً.** كان الشعار الفرعي وعنوان الإسناد وفقرتاه مكتوبةً
 * عربيةً في المكوّن حرفياً، فكانت تظهر عربيةً فوق واجهةٍ إنجليزية — وهو العيب
 * الثالث في §0 من الـBrief بعينه، وإن لم يدخل عبر `defaultValue`.
 *
 * وفقرة الإسناد تُترجَم كاملةً بـ`Trans` لا مقطّعةً حول الروابط: تقطيع الجملة
 * إلى شذرات يجعل ترتيب الكلمات فرضاً لاتينياً على تسع لغات، والعربية أوّل من
 * ينكسر به.
 */
export default function AboutTab() {
  const { t } = useTranslation('settings');
  const { isDarkMode } = useTheme();
  // The source link remains public and independent; release discovery uses the
  // authenticated server endpoint backed by the configured private channel.
  const { updateAvailable, latestVersion, currentVersion } = useVersionCheck();
  const repoName = SOURCE_LABEL.split('/').pop() ?? SOURCE_LABEL;

  return (
    /* عنوان صفحةٍ كبقيّة التبويبات. كان هذا التبويب وحده بلا `level="page"`،
       فيبدأ بشعارٍ عائم بينما يبدأ جاراه بعنوانٍ وأيقونة — والشعار الفرعي
       (`about.tagline`) كان يؤدّي عمل الوصف من غير أن يكون وصفاً، فصار وصف
       الصفحة نفسه ولم يعد يُكرَّر تحت الشعار. */
    <SettingsSection
      level="page"
      icon={Info}
      tone="info"
      title={t('mainTabs.about')}
      description={t('about.tagline')}
    >
      {/* الإيقاع في لوحٍ داخلي لا في `className` على البدائية: `space-y-8`
          و`space-y-3` يضبطان هامش الأبناء نفسه، فالفائز ترتيبُ الملف المولَّد لا
          ترتيب الأصناف (فخّ التصادم المشروط المرصود). */}
      <div className="space-y-8 pt-1">
      {/* شعار + اسم + إصدار */}
      <div className="flex items-center gap-4">
        <img
          src={isDarkMode ? '/nassaj-logo-on-dark.svg' : '/nassaj-logo-on-light.svg'}
          alt={t('common:brand.logoAlt')}
          className="h-8 w-auto flex-shrink-0"
        />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {/* شارتان بمقاس واحد من `StatusBadge`: كانتا 11px و10px — كلتاهما دون
                حدّ 13px (‏STYLE_LOCK §1) — وكانت الثانية بأخضر خام لا رمز له في
                `src/index.css`. */}
            <span className="rounded-full">
              <StatusBadge>v{currentVersion}</StatusBadge>
            </span>
            {updateAvailable && latestVersion && (
              <span className="rounded-full">
                {/* تحديثٌ متاح = معلومةٌ بارزة لا حالةٌ محايدة: نبرة `info`
                    بالرمز، لا تجاوزُ لونٍ يدويّ فوق الشارة المحايدة. */}
                <StatusBadge tone="info">
                  {t('apiKeys.version.updateAvailable', { version: latestVersion })}
                </StatusBadge>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* رابط GitHub — حدّه حدُّ تحكّم (‏WCAG 1.4.11) لا طبقةَ تجميع. */}
      <a
        href={NASSAJ_GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GitHubIcon className="h-4 w-4" />
        <span>{t('about.githubLink', { repo: repoName })}</span>
      </a>

      {/* الإسناد القانوني الإلزامي — AGPL-3.0 §13.
          قسمٌ بعنوانه لا بطاقةٌ مؤطَّرة: عنوان القسم يجمّع الفقرتين، والإطار حولهما
          كان الطبقة الزائدة التي أسقطتها v2. */}
      {/* `boxed`: فقرتان تُقرآن كتلةً واحدة إلزامية (‏AGPL-3.0 §13) وسط صفحةٍ
          روابطُها وشعارُها سائبان — الحدّ هنا يقول أين تبدأ الكتلة وأين تنتهي. */}
      <SettingsSection boxed icon={Scale} title={t('about.attribution.title')}>
        <div className="space-y-2 py-2">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            <Trans
              t={t}
              i18nKey="about.attribution.forkOf"
              components={{
                upstream: (
                  <a
                    href={UPSTREAM_GITHUB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={LINK_CLASS}
                  />
                ),
                license: (
                  <a
                    href="https://www.gnu.org/licenses/agpl-3.0.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={LINK_CLASS}
                  />
                ),
              }}
            />
          </p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('about.attribution.networkSource')}{' '}
            <a
              href={NASSAJ_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-2 hover:underline"
            >
              {SOURCE_LABEL}
            </a>
          </p>
        </div>
      </SettingsSection>

      {/* روابط */}
      <div className="flex flex-wrap gap-4 text-sm">
        <a
          href={NASSAJ_GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <GitHubIcon className="h-4 w-4" />
          {repoName}
        </a>
        <a
          href={UPSTREAM_GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <GitHubIcon className="h-4 w-4" />
          claudecodeui (upstream)
        </a>
      </div>

      {/* الرخصة — الفصل مسافةٌ لا خطّ (§1): الخطّ الشعري داخل قائمة الصفوف وحدها. */}
      {!IS_PLATFORM && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('about.license')}{' '}
          <a
            href={NASSAJ_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {SOURCE_LABEL}
          </a>
        </p>
      )}
      </div>
    </SettingsSection>
  );
}
