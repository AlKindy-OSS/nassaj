import { useTranslation } from 'react-i18next';

import type { TextDocumentData } from '../../../utils/office/previewModel';

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-semibold',
  2: 'text-lg font-semibold',
  3: 'text-base font-semibold',
};

/**
 * Read-only OpenDocument text preview: headings and paragraphs only. Each
 * block takes its direction from its own first strong character, so Arabic
 * and Latin paragraphs both align to their natural start.
 */
export default function OfficeTextView({ text }: { text: TextDocumentData }) {
  const { t } = useTranslation('codeEditor');
  return (
    <div className="h-full w-full overflow-auto">
      <article className="mx-auto flex max-w-3xl flex-col gap-3 p-4 text-foreground">
        <p className="text-xs text-muted-foreground">{t('officePreview.textNotice')}</p>
        {text.blocks.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('officePreview.emptyDocument')}</p>
        )}
        {text.blocks.map((block, index) => {
          const className = `whitespace-pre-wrap text-start [unicode-bidi:plaintext] ${
            block.heading ? HEADING_CLASS[block.heading] ?? 'text-sm font-semibold' : 'text-sm leading-relaxed'
          }`;
          // Block order is fixed and duplicates are legitimate, so the index is the key.
          // Levels sit below the file-name heading (h3) of the preview header.
          return block.heading ? (
            <p key={index} role="heading" aria-level={Math.min(block.heading + 3, 6)} className={className}>{block.text}</p>
          ) : (
            <p key={index} className={className}>{block.text}</p>
          );
        })}
        {text.truncated && <p className="text-xs text-muted-foreground">{t('officePreview.textTruncated')}</p>}
      </article>
    </div>
  );
}
