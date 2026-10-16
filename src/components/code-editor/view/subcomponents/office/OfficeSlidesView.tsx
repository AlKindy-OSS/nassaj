import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { MAX_SLIDES, type PresentationData } from '../../../utils/office/previewModel';

/** Read-only presentation preview: the text of each slide, in order. */
export default function OfficeSlidesView({ presentation }: { presentation: PresentationData }) {
  const { t } = useTranslation('codeEditor');
  const idPrefix = useId();
  return (
    <div className="h-full w-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        <p className="text-xs text-muted-foreground">{t('officePreview.slidesNotice')}</p>
        {presentation.slides.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('officePreview.noSlides')}</p>
        )}
        {presentation.slides.map((slide) => (
          <section
            key={slide.number}
            aria-labelledby={`${idPrefix}-slide-${slide.number}`}
            className="rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <h4 id={`${idPrefix}-slide-${slide.number}`} className="mb-2 text-xs font-medium text-muted-foreground">
              {t('officePreview.slide', { number: slide.number })}
            </h4>
            {slide.paragraphs.length === 0 ? (
              <p className="text-sm italic text-muted-foreground">{t('officePreview.emptySlide')}</p>
            ) : (
              slide.paragraphs.map((text, index) => (
                <p
                  // Paragraph order is fixed; duplicates are legitimate.
                  key={index}
                  className={`whitespace-pre-wrap text-start [unicode-bidi:plaintext] ${
                    index === 0 ? 'text-base font-semibold text-foreground' : 'mt-1 text-sm text-foreground'
                  }`}
                >
                  {text}
                </p>
              ))
            )}
          </section>
        ))}
        {presentation.truncated && (
          <p className="text-xs text-muted-foreground">{t('officePreview.slidesTruncated', { count: MAX_SLIDES })}</p>
        )}
      </div>
    </div>
  );
}
