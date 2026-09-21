import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';
import type { CreatedApiKey } from '../types';

type NewApiKeyAlertProps = {
  apiKey: CreatedApiKey;
  copiedKey: string | null;
  onCopy: (text: string, id: string) => void;
  onDismiss: () => void;
};

export default function NewApiKeyAlert({
  apiKey,
  copiedKey,
  onCopy,
  onDismiss,
}: NewApiKeyAlertProps) {
  const { t } = useTranslation('settings');

  return (
    // صندوق نبرة `warning`: الإطار الملوّن محجوزٌ للحالة التي تحمل معلومة —
    // وهذه أوضح مثال عليها في التبويب. السرّ يُعرَض **مرّة واحدة** ثم لا سبيل
    // إلى استرجاعه، فالكتلة التي تحمله ليست كبقيّة الصفحة، وقول ذلك بنصٍّ ملوّن
    // بين نصوصٍ رمادية يضيع في تدفّقٍ يمرّ عليه القارئ مرّاً.
    <SettingsCard tone="warning">
    <section className="space-y-3" role="status">
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-snug text-warning">
            {t('apiKeys.newKey.alertTitle')}
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {t('apiKeys.newKey.alertMessage')}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* ‏`bg-muted` هنا كتلةٌ تقنية داخل صفّ لا وعاء تجميع — وهو الاستعمال
            الذي يبقى مسموحاً بنصّ §1. */}
        <code
          dir="ltr"
          style={{ unicodeBidi: 'isolate' }}
          className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-[13px] text-foreground"
        >
          {apiKey.apiKey}
        </code>
        <Button
          size="sm"
          variant="outline"
          className="flex-shrink-0"
          onClick={() => onCopy(apiKey.apiKey, 'new')}
          aria-label={t('apiKeys.newKey.copyAria')}
        >
          {copiedKey === 'new' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>

      <Button size="sm" variant="ghost" onClick={onDismiss}>
        {t('apiKeys.newKey.iveSavedIt')}
      </Button>
    </section>
    </SettingsCard>
  );
}
