import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';
import { IS_PLATFORM } from '../../../../constants/config';
import {
  SOURCE_REPO_URL,
  SOURCE_REPO_LABEL,
  SOURCE_REPO_OWNER,
  SOURCE_REPO_NAME,
  SOURCE_RELEASES_AVAILABLE,
} from '../../../../constants/sourceRepo';

// AGPL-3.0 §13: this tab is where a user finds the source of the instance they
// are using, so the destination comes from the shared configured constant — never
// a repo hardcoded in a component.
const NASSAJ_GITHUB_URL = SOURCE_REPO_URL;
const SOURCE_LABEL = SOURCE_REPO_LABEL;
const UPSTREAM_GITHUB_URL = 'https://github.com/siteboon/claudecodeui';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

export default function AboutTab() {
  const { t } = useTranslation('settings');
  const { isDarkMode } = useTheme();
  // The release watcher polls the repo named by VITE_SOURCE_URL. It is disabled
  // when that source has no GitHub releases endpoint (a private or non-GitHub
  // source), so the browser never logs a 404 for a repository it cannot read.
  const { updateAvailable, latestVersion, currentVersion, releaseInfo } = useVersionCheck(SOURCE_REPO_OWNER, SOURCE_REPO_NAME, SOURCE_RELEASES_AVAILABLE);
  const releasesUrl = releaseInfo?.htmlUrl || `${NASSAJ_GITHUB_URL}/releases`;

  return (
    <div className="space-y-6">
      {/* شعار + اسم + إصدار */}
      <div className="flex items-center gap-4">
        <img
          src={isDarkMode ? '/nassaj-logo-on-dark.svg' : '/nassaj-logo-on-light.svg'}
          alt="نسّاج"
          className="h-8 w-auto flex-shrink-0"
        />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={releasesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              v{currentVersion}
            </a>
            {updateAvailable && latestVersion && (
              <a
                href={releasesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400"
              >
                {t('apiKeys.version.updateAvailable', { version: latestVersion })}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            مساحة عمل الوكلاء
          </p>
        </div>
      </div>

      {/* رابط GitHub */}
      <a
        href={NASSAJ_GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <GitHubIcon className="h-4 w-4" />
        <span>{SOURCE_LABEL.split('/').pop()} على GitHub</span>
      </a>

      {/* الإسناد القانوني الإلزامي — AGPL-3.0 §13 */}
      <div className="space-y-2 rounded-xl border border-border/50 bg-muted/20 p-4">
        {/* لا tracking/uppercase: التباعد الحرفي يكسر التحام الحروف العربية، والأحرف الكبيرة لا معنى لها فيها */}
        <h3 className="text-xs font-semibold text-foreground/70">
          إسناد المصدر الأصلي
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          نسّاج فورك من{' '}
          <a
            href={UPSTREAM_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground/80 underline-offset-2 hover:underline"
          >
            claudecodeui
          </a>
          {' '}بقلم siteboon، مُرخَّص تحت{' '}
          <a
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground/80 underline-offset-2 hover:underline"
          >
            AGPL-3.0
          </a>
          .
        </p>
        <p className="text-xs text-muted-foreground/70">
          وفق المادة 13 من AGPL-3.0، يُتاح كود المصدر المشغَّل عبر الشبكة على:{' '}
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

      {/* روابط */}
      <div className="flex flex-wrap gap-4 text-sm">
        <a
          href={NASSAJ_GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <GitHubIcon className="h-4 w-4" />
          {SOURCE_LABEL.split('/').pop()}
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

      {/* الرخصة */}
      {!IS_PLATFORM && (
        <div className="border-t border-border/50 pt-4">
          <p className="text-xs text-muted-foreground/60">
            Licensed under AGPL-3.0 &mdash; Source available at{' '}
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
      )}
    </div>
  );
}
