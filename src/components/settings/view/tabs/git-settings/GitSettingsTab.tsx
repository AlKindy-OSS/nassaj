import { GitBranch, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useGitSettings } from '../../../hooks/useGitSettings';
import { useGithubCredentials } from '../../../hooks/useGithubCredentials';
import { Button, Input } from '../../../../../shared/view/ui';
import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import StatusBadge from '../../StatusBadge';

import GithubCredentialsSection from './GithubCredentialsSection';

export default function GitSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    gitName,
    setGitName,
    gitEmail,
    setGitEmail,
    isLoading,
    isSaving,
    saveStatus,
    saveGitConfig,
  } = useGitSettings();

  const {
    githubCredentials,
    loading: githubLoading,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  } = useGithubCredentials({
    confirmDeleteText: t('apiKeys.github.confirmDelete'),
  });

  return (
    <div className="space-y-8">
      <SettingsSection
        level="page"
        icon={GitBranch}
        tone="info"
        title={t('git.title')}
        description={t('git.description')}
      >
        {/* قسمٌ مصندَق تحت رأس الصفحة، لا حقولاً معلّقة تحته مباشرة: رأس الصفحة
            لا يُصندَق (بطاقتان متداخلتان = الإفراط الذي اعترض عليه المالك)،
            فالحقول تحتاج حدّاً خاصّاً بها يقول أين تبدأ وأين تنتهي.
            ولصائقها من سلّم الصفوف (`SettingsRow` عند 15px) لا `text-sm` مخترعاً. */}
        <SettingsSection
          boxed
          icon={UserRound}
          title={t('git.identity.title', { defaultValue: 'هوية الالتزام' })}
        >
        <div className="space-y-4 py-2">
          <SettingsGroup>
            <SettingsRow
              stacked
              label={<label htmlFor="settings-git-name">{t('git.name.label')}</label>}
              description={t('git.name.help')}
            >
              <Input
                id="settings-git-name"
                type="text"
                value={gitName}
                onChange={(event) => setGitName(event.target.value)}
                placeholder="John Doe"
                disabled={isLoading}
                className="w-full"
              />
            </SettingsRow>

            <SettingsRow
              stacked
              label={<label htmlFor="settings-git-email">{t('git.email.label')}</label>}
              description={t('git.email.help')}
            >
              <Input
                id="settings-git-email"
                type="email"
                value={gitEmail}
                onChange={(event) => setGitEmail(event.target.value)}
                placeholder="john@example.com"
                disabled={isLoading}
                className="w-full"
              />
            </SettingsRow>
          </SettingsGroup>

          {/* الزرّ في طرف النهاية كنظيره في «الملف الشخصي»: كان محاذياً للبداية
              هنا وحده، فكان فعل الحفظ يقع في مكانين مختلفين على شاشتين تفعلان
              الشيء نفسه. والحالة تسبقه في القراءة لا تتبعه. */}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {/* الزوج المعتمد الوحيد لنبرة النجاح (§6) — لا رمز `--success` في
                `src/index.css`، و`green-600/400` كان زوجاً ثالثاً غيره. */}
            {/* شارةُ نجاحٍ بالبدائية لا صفَّ أيقونةٍ ونصٍّ مصنوعاً باليد: هذه
                حالةٌ لحظية بجوار زرّها، و`StatusBadge tone="success"` هو وعاؤها
                المعتمد — يحمل نقطته الدالّة فلا يقع التمييز على اللون وحده. */}
            {saveStatus === 'success' && (
              <StatusBadge tone="success">{t('git.status.success')}</StatusBadge>
            )}

            <Button
              onClick={saveGitConfig}
              disabled={isSaving || !gitName.trim() || !gitEmail.trim()}
            >
              {isSaving ? t('git.actions.saving') : t('git.actions.save')}
            </Button>
          </div>
        </div>
        </SettingsSection>
      </SettingsSection>

      {/* نمط التحميل الموحَّد في النطاق: نصّ رمادي متمركز بحشوٍ رأسي (نمط
          الأصل)، لا `text-sm` محاذٍ للبداية. */}
      {githubLoading ? (
        <p className="py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
          {t('apiKeys.loading')}
        </p>
      ) : (
        <GithubCredentialsSection
          githubCredentials={githubCredentials}
          showNewGithubForm={showNewGithubForm}
          showNewTokenPlainText={Boolean(showToken.new)}
          newGithubName={newGithubName}
          newGithubToken={newGithubToken}
          newGithubDescription={newGithubDescription}
          onShowNewGithubFormChange={setShowNewGithubForm}
          onNewGithubNameChange={setNewGithubName}
          onNewGithubTokenChange={setNewGithubToken}
          onNewGithubDescriptionChange={setNewGithubDescription}
          onToggleNewTokenVisibility={toggleNewGithubTokenVisibility}
          onCreateGithubCredential={createGithubCredential}
          onCancelCreateGithubCredential={cancelNewGithubForm}
          onToggleGithubCredential={toggleGithubCredential}
          onDeleteGithubCredential={deleteGithubCredential}
        />
      )}
    </div>
  );
}
