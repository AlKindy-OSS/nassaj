/**
 * AnthropicApiSpendSection — «إنفاق Anthropic API» (ADR-214 / T-2066).
 *
 * حقل مفتاح Admin الخاص بالمستخدم نفسه، ليقرأ الخادم إنفاق API منذ بداية الشهر
 * ويعرضه في الهيدر بجانب شارات الاشتراك. يسكن هذا التبويب لأن قاعدته «كل حقل
 * مفتاحٍ يُصيَّر من هنا» (`VendorsSettingsTab`).
 *
 * لا يُعرض المفتاح بعد حفظه أبداً — الحالة «مُعدّ/غير مُعدّ» وحدها — ويُفرَّغ
 * الحقل فور نجاح الحفظ. ولا مبالغ يدوية: المصدر الوحيد هو واجهة Anthropic.
 */
import { useState } from 'react';
import { Check, Loader2, Receipt, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import { isolateBidi } from '../../../../quick-settings-panel/subscriptionHelpers';
import { useAnthropicApiSpendKey } from '../../../hooks/useAnthropicApiSpendKey';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import StatusBadge from '../../StatusBadge';

const INPUT_ID = 'anthropic-admin-key';

/** رموز لاتينية داخل جملة عربية: معزولة bidi كي لا تنقلب النقاط/الأقواس حولها. */
const LATIN_TOKENS = {
  prefix: isolateBidi('sk-ant-admin…'),
  console: isolateBidi('platform.claude.com'),
};

export default function AnthropicApiSpendSection() {
  const { t } = useTranslation('settings');
  const { configured, loading, saving, error, saveKey, deleteKey } = useAnthropicApiSpendKey();
  const [draftKey, setDraftKey] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  const busy = loading || saving;

  const handleSave = async () => {
    setJustSaved(false);
    const ok = await saveKey(draftKey);
    if (ok) {
      setDraftKey('');
      setJustSaved(true);
    }
  };

  const handleDelete = () => {
    setJustSaved(false);
    void deleteKey();
  };

  return (
    <SettingsSection
      boxed
      icon={Receipt}
      title={t('apiSpend.settings.title')}
      description={t('apiSpend.settings.description')}
    >
      <div className="space-y-4 py-2">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('apiSpend.settings.help', LATIN_TOKENS)}
        </p>

        <SettingsRow stacked label={t('apiSpend.settings.keyLabel')}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px] leading-relaxed">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
              ) : configured ? (
                <StatusBadge tone="success">{t('apiSpend.settings.configured')}</StatusBadge>
              ) : (
                <StatusBadge>{t('apiSpend.settings.notConfigured')}</StatusBadge>
              )}
              {configured && !loading && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDelete}
                  disabled={busy}
                  aria-label={t('apiSpend.settings.removeAria')}
                  className="ms-auto text-danger hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span className="ms-1.5">{t('apiSpend.settings.remove')}</span>
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={INPUT_ID}>
                {t('apiSpend.settings.keyLabel')}
              </label>
              {/* قيمة تقنية داخل صفحة عربية: جزيرة ltr معزولة bidi، وpassword
                  فلا يلتقطه مُكمِّل المتصفح ولا من فوق الكتف. */}
              <input
                id={INPUT_ID}
                type="password"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                value={draftKey}
                disabled={busy}
                onChange={(event) => setDraftKey(event.target.value)}
                placeholder={
                  configured
                    ? t('apiSpend.settings.placeholderStored')
                    : t('apiSpend.settings.placeholder')
                }
                aria-invalid={error === 'INVALID_ADMIN_KEY' || undefined}
                aria-describedby={error ? `${INPUT_ID}-error` : undefined}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] text-foreground placeholder:font-sans placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              />
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={busy || draftKey.trim().length === 0}
                aria-label={t('apiSpend.settings.saveAria')}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="h-4 w-4" aria-hidden="true" />
                )}
                <span className="ms-1.5">{t('apiSpend.settings.save')}</span>
              </Button>
            </div>

            <SettingsCard tone="warning">
              <p className="text-[13px] leading-relaxed text-warning">
                {t('apiSpend.settings.warning')}
              </p>
            </SettingsCard>

            {error && (
              <SettingsCard tone="danger">
                <p id={`${INPUT_ID}-error`} role="alert" className="text-[13px] leading-relaxed text-danger">
                  {t(`apiSpend.settings.errors.${error}`, LATIN_TOKENS)}
                </p>
              </SettingsCard>
            )}

            {justSaved && (
              <p className="text-[13px] leading-relaxed text-success" aria-live="polite">
                {t('apiSpend.settings.saved')}
              </p>
            )}
          </div>
        </SettingsRow>
      </div>
    </SettingsSection>
  );
}
