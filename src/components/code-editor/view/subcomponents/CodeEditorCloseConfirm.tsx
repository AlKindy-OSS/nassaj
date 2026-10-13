import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';

type CodeEditorCloseConfirmProps = {
  fileName: string;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Esc, overlay click or the keep-editing button: stay on the file. */
  onCancel: () => void;
};

/** Prompt shown when closing a file that still has unsaved edits. */
export default function CodeEditorCloseConfirm({
  fileName,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: CodeEditorCloseConfirmProps) {
  const { t } = useTranslation('codeEditor');
  const titleId = useId();

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent layerClassName="z-[10000]" className="max-w-md p-4" aria-labelledby={titleId}>
        <DialogTitle id={titleId} className="not-sr-only text-[15px] font-medium text-foreground">
          {t('unsavedChanges.title')}
        </DialogTitle>
        <p className="mt-3 text-[13px] leading-relaxed text-foreground">
          {t('unsavedChanges.message')}{' '}
          <span className="font-medium" dir="auto">{fileName}</span>
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            {t('unsavedChanges.keepEditing')}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onDiscard} disabled={saving}>
            {t('unsavedChanges.discard')}
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={saving}>
            {saving ? t('actions.saving') : t('unsavedChanges.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
