import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../shared/view/ui';
import { COORDINATION_LEVELS } from '../../../../../../../shared/coordinationDirectives';
import SegmentedControl from '../../../SegmentedControl';
import SettingsRow from '../../../SettingsRow';
import type { AgentDefaultsSectionProps } from '../types';

/**
 * تفضيلان عامّان تحت شريط الوكلاء: «جعله الافتراضي» للوكيل المفتوح (أول ما
 * يُعرض عند فتح التبويب)، ووضع التفويض الافتراضي للمحادثات الجديدة.
 *
 * عرضٌ صِرف: القراءة والكتابة والتحقّق من الصلاحية عند `AgentsSettingsTab`.
 */
export default function AgentDefaultsSection({
  selectedAgent,
  canMakeDefault,
  isDefault,
  onMakeDefault,
  coordinationLevel,
  onCoordinationLevelChange,
}: AgentDefaultsSectionProps) {
  const { t } = useTranslation(['settings', 'chat']);
  const levelLabel = t('agents.defaults.coordinationLevel.label');

  return (
    <div className="mt-2 flex flex-col">
      {selectedAgent && canMakeDefault && (
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
      )}
      <SettingsRow label={levelLabel} description={t('agents.defaults.coordinationLevel.description')}>
        <SegmentedControl
          options={COORDINATION_LEVELS.map((level) => ({
            value: level,
            label: t(`chat:coordinationLevel.levels.${level}.full`),
          }))}
          value={coordinationLevel}
          onChange={onCoordinationLevelChange}
          label={levelLabel}
        />
      </SettingsRow>
    </div>
  );
}
