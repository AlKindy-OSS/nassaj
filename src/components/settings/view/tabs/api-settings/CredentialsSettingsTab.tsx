import { useTranslation } from 'react-i18next';

import { useCredentialsSettings } from '../../../hooks/useCredentialsSettings';
import { useExternalApiAccess } from '../../../hooks/useExternalApiAccess';

import ApiKeysSection from './sections/ApiKeysSection';
import ExternalApiSection from './sections/ExternalApiSection';
import NewApiKeyAlert from './sections/NewApiKeyAlert';

export default function CredentialsSettingsTab() {
  const { t } = useTranslation('settings');
  const externalApi = useExternalApiAccess();
  const {
    apiKeys,
    loading,
    showNewKeyForm,
    setShowNewKeyForm,
    newKeyName,
    setNewKeyName,
    copiedKey,
    newlyCreatedKey,
    createApiKey,
    deleteApiKey,
    toggleApiKey,
    copyToClipboard,
    dismissNewlyCreatedKey,
    cancelNewApiKeyForm,
  } = useCredentialsSettings({
    confirmDeleteApiKeyText: t('apiKeys.confirmDelete'),
  });

  // حالة الانتظار بنفس صيغة الفراغ في هذا النطاق كلّه: نصٌّ رمادي متمركز
  // بحشوٍ رأسي — كما يفعل الأصل تحت قوائمه الفارغة.
  if (loading || externalApi.loading) {
    return (
      <p className="py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
        {t('apiKeys.loading')}
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <ExternalApiSection
        enabled={externalApi.enabled}
        canManage={externalApi.canManage}
        saving={externalApi.saving}
        error={externalApi.error}
        onChange={(next) => { void externalApi.setExternalApiEnabled(next); }}
      />

      {/* ‏T-1242: قائمة المفاتيح لا تُعرض والسطح مطفأ. مفتاحٌ يُولَّد على بابٍ
          مغلق يبدو صالحاً ثم يردّ 404 عند أول استعمال — والحالة الوحيدة الصادقة
          هي ألّا يُعرض ما لا يعمل. */}
      {externalApi.enabled && (
        <>
          {newlyCreatedKey && (
            <NewApiKeyAlert
              apiKey={newlyCreatedKey}
              copiedKey={copiedKey}
              onCopy={copyToClipboard}
              onDismiss={dismissNewlyCreatedKey}
            />
          )}

          <ApiKeysSection
            apiKeys={apiKeys}
            showNewKeyForm={showNewKeyForm}
            newKeyName={newKeyName}
            onShowNewKeyFormChange={setShowNewKeyForm}
            onNewKeyNameChange={setNewKeyName}
            onCreateApiKey={createApiKey}
            onCancelCreateApiKey={cancelNewApiKeyForm}
            onToggleApiKey={toggleApiKey}
            onDeleteApiKey={deleteApiKey}
          />
        </>
      )}
    </div>
  );
}
