import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../shared/view/ui';
import SettingsRow from '../../../SettingsRow';
import type { AgentDefaultsSectionProps } from '../types';

/**
 * «جعله الافتراضي» تحت شريط الوكلاء: الوكيل المفتوح يصير أول ما يُعرض عند فتح
 * التبويب. (وضع التفويض الافتراضي انتقل إلى تبويب «التعليمات»:
 * ‏`content/DelegationModeSection`.)
 *
 * عرضٌ صِرف: القراءة والكتابة والتحقّق من الصلاحية عند `AgentsSettingsTab`.
 */
export default function AgentDefaultsSection({
  selectedAgent,
  canMakeDefault,
  isDefault,
  onMakeDefault,
}: AgentDefaultsSectionProps) {
  const { t } = useTranslation('settings');
  if (!selectedAgent || !canMakeDefault) return null;

  return (
    <div className="mt-2 flex flex-col">
      <SettingsRow
        label={t('agents.defaults.agent.label')}
        description={t('agents.defaults.agent.description')}
      >
        <Button
          type="button"
          variant={isDefault ? 'secondary' : 'outline'}
          size="sm"
          disabled={isDefault}
          onClick={onMakeDefault}
        >
          {isDefault && <Check aria-hidden="true" />}
          {isDefault ? t('agents.defaults.agent.current') : t('agents.defaults.agent.makeDefault')}
        </Button>
      </SettingsRow>
    </div>
  );
}
