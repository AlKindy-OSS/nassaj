import { useTranslation } from 'react-i18next';
import { useCredentialsSettings } from '../../../hooks/useCredentialsSettings';
import ApiKeysSection from './sections/ApiKeysSection';
import NewApiKeyAlert from './sections/NewApiKeyAlert';

export default function CredentialsSettingsTab() {
  const { t } = useTranslation('settings');
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

  if (loading) {
    return <div className="text-muted-foreground">{t('apiKeys.loading')}</div>;
  }

  return (
    <div className="space-y-8">
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
    </div>
  );
}
