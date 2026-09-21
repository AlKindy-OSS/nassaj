import { ExternalLink, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../../../shared/view/ui';
import SettingsGroup from '../../../SettingsGroup';
import SettingsRow from '../../../SettingsRow';
import SettingsSection from '../../../SettingsSection';
import type { ApiKeyItem } from '../types';

type ApiKeysSectionProps = {
  apiKeys: ApiKeyItem[];
  showNewKeyForm: boolean;
  newKeyName: string;
  onShowNewKeyFormChange: (value: boolean) => void;
  onNewKeyNameChange: (value: string) => void;
  onCreateApiKey: () => void;
  onCancelCreateApiKey: () => void;
  onToggleApiKey: (keyId: string, isActive: boolean) => void;
  onDeleteApiKey: (keyId: string) => void;
};

export default function ApiKeysSection({
  apiKeys,
  showNewKeyForm,
  newKeyName,
  onShowNewKeyFormChange,
  onNewKeyNameChange,
  onCreateApiKey,
  onCancelCreateApiKey,
  onToggleApiKey,
  onDeleteApiKey,
}: ApiKeysSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <section className="space-y-3">
      {/* الرأس كان منسوخاً بيدٍ من طباعة `SettingsSection` بحجّة أن البدائية لا
          تملك فتحةً للفعل — والنسخ يشيخ بأول تعديل يلمس أحد الطرفين. البدائية
          تُستدعى الآن فعلاً، ويجلس الزرّ **بجانبها** لا داخلها: الرأس نصٌّ
          وأيقونةٌ ووصف، والفعلُ صفٌّ مرنٌ يحويهما معاً.
          و`KeyRound` أيقونةً: هذا تبويب **مفاتيح** نسّاج — مفتاحٌ يقولها قبل
          قراءة العنوان، وهو ما كان يعوز هذا الرأس وحده دون بقيّة الرؤوس. */}
      <div className="flex items-start justify-between gap-4">
        {/* ‏T-1242: هبط من `page` إلى `section`. عنوان الصفحة صار «الوصول
            البرمجي» (مفتاح التشغيل الرئيسي) وقائمةُ المفاتيح تحته لا بجانبه —
            و`page` مرّةً واحدةً في أعلى كل تبويب. */}
        <SettingsSection
          level="section"
          icon={KeyRound}
          title={t('apiKeys.title')}
          description={t('apiKeys.description')}
          className="min-w-0 flex-1"
        >
          <a
            href="/api-docs.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-sm text-[13px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('apiKeys.apiDocsLink')}
            <ExternalLink className="h-3 w-3 rtl:-scale-x-100" aria-hidden="true" />
          </a>
        </SettingsSection>
        <Button
          size="sm"
          className="flex-shrink-0"
          onClick={() => onShowNewKeyFormChange(!showNewKeyForm)}
        >
          <Plus className="me-1 h-4 w-4" />
          {t('apiKeys.newButton')}
        </Button>
      </div>

      {/* النموذج بلا وعاء: كان بطاقةً مؤطَّرة تحوي حقلاً واحداً وزرّين، وإطارٌ
          حول ثلاثة تحكّمات لا يجمّع شيئاً — حدود التحكّمات نفسها تحدّها. */}
      {showNewKeyForm && (
        <div className="space-y-3">
          <Input
            placeholder={t('apiKeys.form.placeholder')}
            value={newKeyName}
            onChange={(event) => onNewKeyNameChange(event.target.value)}
          />
          <div className="flex gap-2">
            <Button onClick={onCreateApiKey}>{t('apiKeys.form.createButton')}</Button>
            <Button variant="outline" onClick={onCancelCreateApiKey}>
              {t('apiKeys.form.cancelButton')}
            </Button>
          </div>
        </div>
      )}

      {/* قائمة صفوف يفصلها خطّ شعري — لا بطاقة حولها ولا حشو أفقي يزيحها عن
          عنوان القسم (§2.2/§2.3). */}
      {apiKeys.length === 0 ? (
        // صيغة الفراغ الواحدة في هذا النطاق: نصٌّ رمادي متمركز كالأصل.
        <p className="py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
          {t('apiKeys.empty')}
        </p>
      ) : (
        <SettingsGroup>
          <ul className="divide-y divide-border">
            {apiKeys.map((key) => (
              <li key={key.id}>
                <SettingsRow
                  label={key.key_name}
                  description={
                    <>
                      <code
                        dir="ltr"
                        style={{ unicodeBidi: 'isolate' }}
                        className="block break-all font-mono text-[13px] text-muted-foreground"
                      >
                        {key.api_key}
                      </code>
                      <span className="mt-0.5 block">
                        {t('apiKeys.list.created')} {new Date(key.created_at).toLocaleDateString()}
                        {key.last_used
                          ? ` - ${t('apiKeys.list.lastUsed')} ${new Date(key.last_used).toLocaleDateString()}`
                          : ''}
                      </span>
                    </>
                  }
                >
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={key.is_active ? 'outline' : 'secondary'}
                      onClick={() => onToggleApiKey(key.id, key.is_active)}
                    >
                      {key.is_active ? t('apiKeys.status.active') : t('apiKeys.status.inactive')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDeleteApiKey(key.id)}
                      aria-label={t('apiKeys.deleteAria', { name: key.key_name })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </SettingsRow>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
    </section>
  );
}
