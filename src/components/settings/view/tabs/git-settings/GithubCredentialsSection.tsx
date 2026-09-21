/**
 * GitHub Personal Access Token credential management section.
 *
 * Moved from api-settings/sections/ to git-settings/ as part of ADR-076
 * Wave-1b (2026-07-28): GitHub tokens belong to the Git context — they are
 * consumed exclusively by git operations (clone, push, pull on private repos),
 * not by the Nassaj API key mechanism.
 */
import { Eye, EyeOff, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../../shared/view/ui';
import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import type { GithubCredentialItem } from '../api-settings/types';

type GithubCredentialsSectionProps = {
  githubCredentials: GithubCredentialItem[];
  showNewGithubForm: boolean;
  showNewTokenPlainText: boolean;
  newGithubName: string;
  newGithubToken: string;
  newGithubDescription: string;
  onShowNewGithubFormChange: (value: boolean) => void;
  onNewGithubNameChange: (value: string) => void;
  onNewGithubTokenChange: (value: string) => void;
  onNewGithubDescriptionChange: (value: string) => void;
  onToggleNewTokenVisibility: () => void;
  onCreateGithubCredential: () => void;
  onCancelCreateGithubCredential: () => void;
  onToggleGithubCredential: (credentialId: string, isActive: boolean) => void;
  onDeleteGithubCredential: (credentialId: string) => void;
};

export default function GithubCredentialsSection({
  githubCredentials,
  showNewGithubForm,
  showNewTokenPlainText,
  newGithubName,
  newGithubToken,
  newGithubDescription,
  onShowNewGithubFormChange,
  onNewGithubNameChange,
  onNewGithubTokenChange,
  onNewGithubDescriptionChange,
  onToggleNewTokenVisibility,
  onCreateGithubCredential,
  onCancelCreateGithubCredential,
  onToggleGithubCredential,
  onDeleteGithubCredential,
}: GithubCredentialsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    /* رأسٌ بالبدائية لا مكتوباً باليد. كان `h3 text-base font-semibold` نسخةً
       يدوية من طباعة `SettingsSection` بمقاسٍ **أصغر درجةً** من أقسام التبويب
       نفسه — فيقرأ القسمُ مرؤوساً لما يجاوره وهو نظيره. والأيقونة عادت لأن
       النظام صار يوجبها على كل قسم: حين تحملها الأقسام كلها لا يعود حملُها
       تمييزاً، وحين يخلو منها قسمٌ واحد يصير خلوّه هو التمييز.
       والفعل نزل تحت الرأس (كما في «مفاتيح المرور») لأن البدائية المشتركة لا
       تملك فتحةً للفعل، وشقُّ فتحةٍ فيها خارج نطاق ترحيلٍ بصري. */
    <SettingsSection
      boxed
      icon={KeyRound}
      title={t('apiKeys.github.title')}
      description={t('apiKeys.github.descriptionAlt')}
    >
      {/* لوحٌ داخلي: الفعل ثم النموذج ثم القائمة — ثلاثة أبناء متجاورين. */}
      <div className="space-y-3 py-2">
      <div className="flex justify-end">
        <Button
          size="sm"
          className="flex-shrink-0"
          onClick={() => onShowNewGithubFormChange(!showNewGithubForm)}
        >
          <Plus className="me-1 h-4 w-4" />
          {t('apiKeys.github.addButton')}
        </Button>
      </div>

      {/* النموذج بلا وعاء: ثلاثة حقول وزرّان، وحدود التحكّمات تحدّها — والإطار
          حولها كان صندوقاً حول صناديق (§1). */}
      {showNewGithubForm && (
        <div className="space-y-3">
          <Input
            placeholder={t('apiKeys.github.form.namePlaceholder')}
            value={newGithubName}
            onChange={(event) => onNewGithubNameChange(event.target.value)}
          />

          <div className="relative">
            <Input
              type={showNewTokenPlainText ? 'text' : 'password'}
              placeholder={t('apiKeys.github.form.tokenPlaceholder')}
              value={newGithubToken}
              onChange={(event) => onNewGithubTokenChange(event.target.value)}
              className="pe-10"
            />
            <button
              type="button"
              onClick={onToggleNewTokenVisibility}
              aria-label={
                showNewTokenPlainText
                  ? t('apiKeys.github.form.hideToken')
                  : t('apiKeys.github.form.showToken')
              }
              className="absolute end-3 top-2.5 rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showNewTokenPlainText ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <Input
            placeholder={t('apiKeys.github.form.descriptionPlaceholder')}
            value={newGithubDescription}
            onChange={(event) => onNewGithubDescriptionChange(event.target.value)}
          />

          <div className="flex gap-2">
            <Button onClick={onCreateGithubCredential}>{t('apiKeys.github.form.addButton')}</Button>
            <Button variant="outline" onClick={onCancelCreateGithubCredential}>
              {t('apiKeys.github.form.cancelButton')}
            </Button>
          </div>

          <a
            href="https://github.com/settings/tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-sm text-[13px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('apiKeys.github.form.howToCreate')}
          </a>
        </div>
      )}

      {/* قائمة صفوف يفصلها خطّ شعري، بلا صندوق حولها ولا حشو أفقي يزيحها عن
          عنوان القسم (§2.2/§2.3). */}
      {githubCredentials.length === 0 ? (
        <p className="py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
          {t('apiKeys.github.empty')}
        </p>
      ) : (
        <SettingsGroup>
          <ul className="divide-y divide-border">
            {githubCredentials.map((credential) => (
              <li key={credential.id}>
                <SettingsRow
                  label={credential.credential_name}
                  description={
                    <>
                      {credential.description && <span className="block">{credential.description}</span>}
                      <span className="block">
                        {t('apiKeys.github.added')}{' '}
                        {new Date(credential.created_at).toLocaleDateString()}
                      </span>
                    </>
                  }
                >
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={credential.is_active ? 'outline' : 'secondary'}
                      onClick={() => onToggleGithubCredential(credential.id, credential.is_active)}
                    >
                      {credential.is_active
                        ? t('apiKeys.status.active')
                        : t('apiKeys.status.inactive')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDeleteGithubCredential(credential.id)}
                      aria-label={t('apiKeys.github.deleteAria', {
                        name: credential.credential_name,
                      })}
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
      </div>
    </SettingsSection>
  );
}
