import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SettingsGroup from '../../../SettingsGroup';
import SettingsRow from '../../../SettingsRow';
import SettingsSection from '../../../SettingsSection';
import SettingsToggle from '../../../SettingsToggle';
import StatusBadge from '../../../StatusBadge';
import { AGENT_NAMES } from '../../agents-settings/sections/AgentSelectorSection';
import { useGovernancePreferences } from '../hooks/useGovernancePreferences';
import type { AgentProvider } from '../../../../types/types';

/**
 * مفتاح «يتبع تعليمات نسّاج» لكل محرّك.
 *
 * حالتان لا ثالثة: **محكوم** (تصله تعليمات نسّاج) و**معفى** (يعمل بوضعه
 * الافتراضي). واسمُ الحالة يُقال نصّاً في كل صفّ — لا يُترك للمفتاح وحده، فمفتاحٌ
 * مطفأ لا يقول أهو «معفى بقرار» أم «لم يُبنَ بعد».
 *
 * **‏`canManage` من الخادم ولا يُشتقّ هنا** (سابقة B-362،
 * `provider.routes.ts:170-176`): الاشتقاق العميلي يجعل الزرّ ونقطةَ النهاية
 * يختلفان في الحكم، وهو عطبٌ أمني لا تفاوتُ عرض.
 *
 * **ولا زرَّ معطَّلاً** (ADR-093 §4.4، والسابقة المنفَّذة في
 * `InstructionSourcesContent.tsx:175-209`): حين لا يملك المُنادي التبديل تحلّ
 * محلَّ المفتاح **شارةُ الحالة** — فيبقى الجواب مقروءاً — وتحتها جملةٌ تقول لماذا
 * لا مفتاح. الإعفاء للمالك والمدير حصراً، وذلك ما تقوله الجملة.
 *
 * **‏fail-HIDDEN:** حين لا يعرف الخادم `‎/api/governance/preferences` (‏404) أو
 * يردّ شكلاً غير معروف، يُرجع الخطّاف `null` و**لا يُرسم هذا القسم إطلاقاً** —
 * لا رسالةَ خطأٍ مخيفة عن ميزةٍ لم تصل بعد.
 */
export default function GovernanceModeSection({ active }: { active: boolean }) {
  const { t } = useTranslation('settings');
  const { channels, saving, writeError, setMode } = useGovernancePreferences(active);

  if (!channels || channels.length === 0) {
    return null;
  }

  return (
    <SettingsSection
      icon={ShieldCheck}
      tone="info"
      title={t('references.governance.title')}
      description={t('references.governance.description')}
    >
      <SettingsGroup>
        {channels.map((channel) => {
          const isGoverned = channel.mode === 'governed';
          const providerName = AGENT_NAMES[channel.provider as AgentProvider] ?? channel.provider;
          // مفرداتُ `reason` ثلاثُ عائلات: رفضُ إعفاءٍ بنيوي (`shared_tree`)،
          // وأسبابُ القرص السبعة **المترجَمة أصلاً** تحت `instructionSources`،
          // و`material_present`. فتُقرأ الخاصّةُ أوّلاً ثم تُستعاد العامّة القائمة
          // بدل نسخِها — ولا يُطبع معرّفٌ خام أبداً حين لا تُعرف الكلمة.
          const reasonText = channel.reason
            ? t(`references.governance.reason.${channel.reason}`, {
              defaultValue: t(`agents.instructionSources.reason.${channel.reason}`, {
                defaultValue: '',
              }),
            })
            : '';

          return (
            <SettingsRow
              key={channel.provider}
              label={providerName}
              description={(
                <span className="block space-y-1">
                  <span className="block">
                    {isGoverned
                      ? t('references.governance.stateGoverned')
                      : t('references.governance.stateExempt')}
                  </span>
                  <span className="block">
                    {t(`agents.instructionSources.enforcement.${channel.enforcement}`)}
                  </span>
                  {/* السببُ حالةٌ لا إذن: `material_present` يقع على قناةٍ
                      يملكها المُنادي أيضاً، فلا يُشرَط بـ`canManage`. وجملةُ
                      «للمالك والمدير» تُقال حين لا يملك ولا سببَ أخصّ منها. */}
                  {reasonText && <span className="block">{reasonText}</span>}
                  {!channel.canManage && !reasonText && (
                    <span className="block">{t('references.governance.ownerOnly')}</span>
                  )}
                  {writeError === channel.provider && (
                    <span role="alert" className="block text-danger">
                      {t('references.governance.writeFailed')}
                    </span>
                  )}
                </span>
              )}
            >
              <div className="flex min-h-10 shrink-0 items-center gap-2">
                {saving === channel.provider && (
                  <Loader2
                    className="h-4 w-4 animate-spin text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                {channel.canManage ? (
                  <SettingsToggle
                    checked={isGoverned}
                    onChange={(next) =>
                      void setMode(channel.provider, next ? 'governed' : 'exempt')}
                    disabled={saving !== null}
                    ariaLabel={t('references.governance.toggleLabel', { provider: providerName })}
                  />
                ) : (
                  <StatusBadge tone={isGoverned ? 'success' : 'warning'}>
                    {isGoverned
                      ? t('references.governance.modeGoverned')
                      : t('references.governance.modeExempt')}
                  </StatusBadge>
                )}
              </div>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
