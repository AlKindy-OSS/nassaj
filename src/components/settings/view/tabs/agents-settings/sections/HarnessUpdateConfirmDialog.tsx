import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { HarnessRequiredAck, HarnessSuppliedAck } from '../../../../../../../shared/harness-update.contract';
import type { HarnessPendingConfirmation } from '../../../../../../hooks/useHarnessVersion';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../../../shared/view/ui';

/**
 * The 409 CONFIRMATION_REQUIRED dialog (T-1871 stage 4, spec §9). Every
 * consequence line is the SERVER's own `textAr`/`textEn` — this component
 * never composes its own wording for a risky action, only the chrome
 * (title, checkbox, buttons) around it.
 */
export default function HarnessUpdateConfirmDialog({
  confirmation, submitting, onConfirm, onCancel, onRefresh,
}: {
  confirmation: HarnessPendingConfirmation;
  submitting: boolean;
  onConfirm: (acks: HarnessSuppliedAck[]) => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setChecked({});
  }, [confirmation]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const required = confirmation.required;
  const expired = required.some(ack => ack.expiresAt <= now);
  const allChecked = required.length > 0 && required.every(ack => checked[ack.kind]);
  const textOf = (ack: HarnessRequiredAck) => (i18n.language?.startsWith('ar') ? ack.textAr : ack.textEn) || ack.textAr;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md p-4" aria-labelledby="harness-confirm-title">
        <DialogTitle id="harness-confirm-title" className="not-sr-only text-[15px] font-medium text-foreground">
          {t('harnessVersion.confirm.title', { defaultValue: 'تأكيد إجراء حسّاس' })}
        </DialogTitle>
        <div className="mt-3 space-y-3">
          {required.map(ack => (
            <label key={ack.kind} className="flex min-h-11 items-start gap-2 text-[13px] leading-relaxed text-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={Boolean(checked[ack.kind])}
                onChange={(event) => setChecked(previous => ({ ...previous, [ack.kind]: event.target.checked }))}
                disabled={submitting || expired}
                aria-describedby={`harness-ack-${ack.kind}`}
              />
              <span id={`harness-ack-${ack.kind}`}>{textOf(ack)}</span>
            </label>
          ))}
          {expired && (
            <p role="alert" className="text-[13px] text-destructive">
              {t('harnessVersion.confirm.expired', { defaultValue: 'انتهت صلاحية طلب التأكيد. أعد الطلب للحصول على تأكيد جديد.' })}
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            {t('harnessVersion.confirm.cancel', { defaultValue: 'إلغاء' })}
          </Button>
          {expired
            ? <Button type="button" size="sm" onClick={onRefresh} disabled={submitting}>{t('harnessVersion.confirm.refresh', { defaultValue: 'تحديث الطلب' })}</Button>
            : <Button
                type="button"
                size="sm"
                onClick={() => onConfirm(required.map(ack => ({ kind: ack.kind, token: ack.token })))}
                disabled={submitting || !allChecked}
              >
                {t('harnessVersion.confirm.confirm', { defaultValue: 'تأكيد' })}
              </Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
