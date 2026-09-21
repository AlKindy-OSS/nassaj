import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsSubNav from '../../SettingsSubNav';
import type { SettingsSubNavItem } from '../../SettingsSubNav';
import type { AgentCategory } from '../../../../types/types';
import type { AgentCategoryTabsSectionProps } from '../types';

/** معرّف اللوح الذي تحكمه هذه التبويبات — مشتركٌ مع `AgentCategoryContentSection`. */
export const AGENT_CATEGORY_PANEL_ID = 'agent-category-panel';

export default function AgentCategoryTabsSection({
  categories,
  selectedCategory,
  onSelectCategory,
}: AgentCategoryTabsSectionProps) {
  const { t } = useTranslation('settings');

  // ‏`Record<AgentCategory, …>` لا سلسلة ثلاثيات: كان ذيلُها `: 'Setup'` —
  // إنجليزيةً حرفيةً بلا ترجمة بين ستّ لصيقاتٍ مترجَمة، في تطبيقٍ عربيّ الأساس —
  // ولمّا حُذفت فئة «الإعداد» (‏B-414) صار ذلك الذيل يبتلع صامتاً أيّ فئةٍ تُضاف
  // لاحقاً. الخريطة تجعل الفئة الجديدة **خطأ تصريفٍ** لا لصيقةً إنجليزية.
  const items = useMemo<SettingsSubNavItem<AgentCategory>[]>(() => {
    const LABELS: Record<AgentCategory, string> = {
      account: t('tabs.account'),
      engines: t('mainTabs.engines', { defaultValue: 'Engines' }),
      permissions: t('tabs.permissions'),
      instructions: t('tabs.instructions', { defaultValue: 'Instructions' }),
      mcp: t('tabs.mcpServers'),
      skills: t('tabs.skills'),
    };

    return categories.map((category) => ({
      value: category,
      label: LABELS[category],
      panelId: AGENT_CATEGORY_PANEL_ID,
    }));
  }, [categories, t]);

  // Coming-soon providers (e.g. deepseek) have no category tabs — the content
  // section renders a coming-soon panel instead, so the tab bar is hidden.
  if (items.length === 0) return null;

  return (
    <SettingsSubNav
      items={items}
      value={selectedCategory}
      onChange={onSelectCategory}
      label={t('mainTabs.agents')}
      className="flex-shrink-0"
    />
  );
}
