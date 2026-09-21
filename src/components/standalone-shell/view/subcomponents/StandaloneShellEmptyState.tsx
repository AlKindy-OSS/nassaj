import { useTranslation } from 'react-i18next';

type StandaloneShellEmptyStateProps = {
  className: string;
};

export default function StandaloneShellEmptyState({ className }: StandaloneShellEmptyStateProps) {
  const { t } = useTranslation('terminals');
  return (
    <div className={`flex h-full items-center justify-center ${className}`}>
      <div className="text-center text-muted-foreground">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <svg className="h-8 w-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h3 className="mb-2 text-lg font-semibold">{t('standalone.noProjectTitle')}</h3>
        <p>{t('standalone.noProjectBody')}</p>
      </div>
    </div>
  );
}
