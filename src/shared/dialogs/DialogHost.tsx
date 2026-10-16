import { ConfirmDialog } from '../view/ui/ConfirmDialog';

import { useDialogs } from './dialogService';

/**
 * Renders the head of the dialog queue (T-2039). Mount once, above the auth
 * gate, so dialogs raised on login screens are shown too.
 */
export function DialogHost() {
  const { current, settle } = useDialogs();
  if (!current) return null;
  return (
    <ConfirmDialog
      key={current.id}
      variant={current.kind}
      title={current.title}
      message={current.message}
      code={current.code}
      confirmLabel={current.confirmLabel}
      cancelLabel={current.cancelLabel}
      tone={current.tone}
      onConfirm={() => settle(current.id, true)}
      onCancel={() => settle(current.id, false)}
    />
  );
}

export default DialogHost;
