import { Download, Maximize2, Minimize2, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import DocumentShareButton from '../../../../document-sharing/DocumentShareButton';
import { useBinaryFileDownload } from '../../../hooks/useBinaryFileDownload';
import { useOfficePreview } from '../../../hooks/useOfficePreview';
import type { CodeEditorFile } from '../../../types/types';
import { OFFICE_PREVIEW_MAX_BYTES, type OfficeFormat } from '../../../utils/officeDocument';
import type { OfficePreviewResult } from '../../../utils/office/parseOfficeFile';
import { buildPreviewSrcdoc, type SanitizedDocument } from '../../../utils/office/previewSrcdoc';
import CodeEditorBinaryFile from '../CodeEditorBinaryFile';

import OfficeSlidesView from './OfficeSlidesView';
import OfficeSpreadsheetView from './OfficeSpreadsheetView';
import OfficeTextView from './OfficeTextView';

type CodeEditorOfficePreviewProps = {
  file: CodeEditorFile;
  format: OfficeFormat;
  projectId?: string;
  isSidebar: boolean;
  isFullscreen: boolean;
  isDarkMode: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
};

const ICON_BUTTON =
  'flex min-h-9 min-w-9 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';

function DocumentFrame({ sanitized, dark, fileName }: { sanitized: SanitizedDocument; dark: boolean; fileName: string }) {
  const { t } = useTranslation('codeEditor');
  // Parsed and sanitized once; a theme switch only rebuilds this string.
  const srcdoc = useMemo(() => buildPreviewSrcdoc(sanitized, dark), [sanitized, dark]);
  return (
    // sandbox MUST stay exactly "": no scripts, forms, popups or same-origin
    // access. Never add allow-scripts together with allow-same-origin — that
    // pair lets the document remove its own sandbox. The srcdoc also carries a
    // CSP that blocks every network load.
    <iframe
      sandbox=""
      srcDoc={srcdoc}
      title={t('officePreview.documentFrameTitle', { fileName })}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0"
    />
  );
}

function PreviewBody({ result, fileName, dark }: { result: OfficePreviewResult; fileName: string; dark: boolean }) {
  switch (result.kind) {
    case 'document':
      return <DocumentFrame sanitized={result.document} dark={dark} fileName={fileName} />;
    case 'spreadsheet':
      return <OfficeSpreadsheetView workbook={result.workbook} />;
    case 'text':
      return <OfficeTextView text={result.text} />;
    default:
      return <OfficeSlidesView presentation={result.presentation} />;
  }
}

function PreviewFrame({ isSidebar, isFullscreen, children }: { isSidebar: boolean; isFullscreen: boolean; children: ReactNode }) {
  if (isSidebar) return <div className="flex h-full w-full flex-col bg-background">{children}</div>;
  const container = isFullscreen
    ? 'fixed inset-0 z-[9999] bg-background flex flex-col'
    : 'fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4';
  const inner = isFullscreen
    ? 'bg-background flex flex-col w-full h-full'
    : 'bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]';
  return (
    <div className={container}>
      <div className={inner}>{children}</div>
    </div>
  );
}

/**
 * Read-only preview for Word, spreadsheet, presentation and OpenDocument files. Any size or
 * parse failure falls back to the binary screen, which keeps the download.
 */
export default function CodeEditorOfficePreview({
  file,
  format,
  projectId,
  isSidebar,
  isFullscreen,
  isDarkMode,
  onClose,
  onToggleFullscreen,
}: CodeEditorOfficePreviewProps) {
  const { t } = useTranslation('codeEditor');
  const state = useOfficePreview({ projectId, filePath: file.path, format });
  const { isDownloading, hasError, download } = useBinaryFileDownload(projectId, file.path, file.name);

  if (state.status === 'tooLarge' || state.status === 'error' || state.status === 'secret') {
    const limit = Math.round(OFFICE_PREVIEW_MAX_BYTES / (1024 * 1024));
    const messages = {
      tooLarge: [t('officePreview.unavailableTitle'), t('officePreview.tooLarge', { fileName: file.name, limit })],
      error: [t('officePreview.unavailableTitle'), t('officePreview.failed', { fileName: file.name })],
      secret: [t('common:secretFile.title'), t('officePreview.secretNotPreviewed', { fileName: file.name })],
    } as const;
    const [title, message] = messages[state.status];
    return (
      <CodeEditorBinaryFile
        file={file}
        projectId={projectId}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={onToggleFullscreen}
        title={title}
        message={message}
      />
    );
  }

  return (
    <PreviewFrame isSidebar={isSidebar} isFullscreen={isFullscreen}>
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">{file.name}</h3>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('officePreview.readOnly')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={download}
            disabled={isDownloading || !projectId}
            aria-busy={isDownloading}
            className={ICON_BUTTON}
            aria-label={t('binaryFile.download')}
            title={t('binaryFile.download')}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </button>
          <DocumentShareButton projectId={projectId} filePath={file.path} />
          {!isSidebar && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              className={ICON_BUTTON}
              aria-label={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
              title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
            >
              {isFullscreen
                ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
                : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
            </button>
          )}
          <button type="button" onClick={onClose} className={ICON_BUTTON} aria-label={t('actions.close')} title={t('actions.close')}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {hasError && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">{t('binaryFile.downloadError')}</p>
      )}
      <div className="relative min-h-0 flex-1 bg-muted/30">
        {state.status === 'loading' ? (
          <div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('officePreview.loading')}
          </div>
        ) : (
          <PreviewBody result={state.result} fileName={file.name} dark={isDarkMode} />
        )}
      </div>
    </PreviewFrame>
  );
}
