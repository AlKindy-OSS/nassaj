import { useTranslation } from 'react-i18next';
import { FileTextIcon, FileSpreadsheetIcon, FileIcon, XIcon, AlertCircleIcon } from 'lucide-react';

interface FileAttachmentProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

/**
 * Chip-style attachment preview for non-image files (PDF, Excel, CSV, …).
 * Mirror of ImageAttachment — same remove-button pattern, same RTL-safe structure.
 */
const FileAttachment = ({ file, onRemove, uploadProgress, error }: FileAttachmentProps) => {
  const { t } = useTranslation('chat');

  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  const Icon = (() => {
    if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) {
      return FileSpreadsheetIcon;
    }
    if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) {
      return FileTextIcon;
    }
    return FileIcon;
  })();

  const formattedSize = (() => {
    const bytes = file.size ?? 0;
    if (bytes === 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  })();

  const isUploading = uploadProgress !== undefined && uploadProgress < 100;

  return (
    <div className="group relative flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 pe-7 text-start">
      {/* File-type icon */}
      <span
        className={`shrink-0 ${error ? 'text-destructive' : isUploading ? 'text-muted-foreground' : 'text-primary'}`}
        aria-hidden="true"
      >
        {error ? (
          <AlertCircleIcon className="h-4 w-4" />
        ) : (
          <Icon className="h-4 w-4" />
        )}
      </span>

      {/* Name + size / status */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium leading-tight text-foreground" title={file.name}>
          {file.name}
        </p>
        {error ? (
          <p className="truncate text-xs leading-tight text-destructive">{error}</p>
        ) : isUploading ? (
          <p className="text-xs leading-tight text-muted-foreground">
            {t('fileAttachment.uploading')} {uploadProgress}%
          </p>
        ) : formattedSize ? (
          <p className="text-xs leading-tight text-muted-foreground">{formattedSize}</p>
        ) : null}
      </div>

      {/* Upload progress bar */}
      {isUploading && !error && (
        <div className="absolute bottom-0 start-0 end-0 h-0.5 overflow-hidden rounded-b-lg bg-muted">
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      )}

      {/* Remove button — top-end corner, RTL-safe via `absolute -end-2 -top-2` */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -end-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={t('fileAttachment.removeFile')}
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
};

export default FileAttachment;
