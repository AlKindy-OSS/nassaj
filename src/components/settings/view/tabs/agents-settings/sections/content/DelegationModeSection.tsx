import { Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { COORDINATION_LEVELS } from '../../../../../../../../shared/coordinationDirectives';
import { useUiPreferences } from '../../../../../../../hooks/useUiPreferences';
import SegmentedControl from '../../../../SegmentedControl';
import SettingsSection from '../../../../SettingsSection';

/**
 * وضع التفويض الافتراضي داخل تبويب «التعليمات» (طلب المالك 2026-10-16).
 *
 * الوضع يحكم كيف يعمل المنسّق — أي ما يُملى عليه — فمكانه بجوار مصادر
 * التعليمات لا أعلى الصفحة. و«التعليمات» فئةٌ لكل وكيل بلا استثناء
 * (‏`visibleCategoriesFor`)، بخلاف «الأذونات» الغائبة عن بعضهم، فيبقى الإعداد
 * في متناول المالك أيّاً كان الوكيل المفتوح.
 *
 * الإعداد **عامّ لا لكل وكيل**: يُخزَّن في `defaultCoordinationLevel` كما كان،
 * والوصف يقول ذلك صراحةً كي لا يُقرأ تفضيلاً للوكيل المفتوح وحده.
 */
export default function DelegationModeSection() {
  const { t } = useTranslation(['settings', 'chat']);
  const { preferences, setPreference } = useUiPreferences();
  const label = t('agents.defaults.coordinationLevel.label');

  return (
    <SettingsSection
      icon={Workflow}
      title={label}
      description={t('agents.defaults.coordinationLevel.description')}
    >
      <SegmentedControl
        options={COORDINATION_LEVELS.map((level) => ({
          value: level,
          label: t(`chat:coordinationLevel.levels.${level}.full`),
        }))}
        value={preferences.defaultCoordinationLevel}
        onChange={(level) => setPreference('defaultCoordinationLevel', level)}
        label={label}
      />
    </SettingsSection>
  );
}
