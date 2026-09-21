import { useMemo, useState } from 'react';
import { BrainCircuit, IdCard, Library, ScrollText, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SegmentedControl from '../../SegmentedControl';
import type { SegmentedOption } from '../../SegmentedControl';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsSubNav from '../SettingsSubNav';
import type { SettingsSubNavItem } from '../SettingsSubNav';
import { AGENT_NAMES } from '../agents-settings/sections/AgentSelectorSection';
import { visibleSettingsAgents } from '../agents-settings/visibleAgents';

import GovernanceModeSection from './sections/GovernanceModeSection';
import ReferenceMaterialPanel from './sections/ReferenceMaterialPanel';
import { useReferenceMaterials } from './hooks/useReferenceMaterials';
import type { ReferenceItem, ReferenceMaterial, ReferenceScopeFilter } from './types';

const MATERIAL_PANEL_ID = 'references-material-panel';

/**
 * تبويب «المرجعيّات» — كلُّ ما يقرؤه الوكيل قبل أن يبدأ
 * (‏`docs/design/coordination-levels-ux-2026-08-07.md` §4).
 *
 * **لماذا تبويبٌ رئيسيٌّ جديد ولا توسعةٌ لـ`agents`** (§4.1): محورُ ذلك التبويب
 * هو **الجسم** (claude, codex, …) وفئاتُه الستّ كلُّها لكلِّ جسمٍ على حدة، بينما
 * الذاكرةُ وبطاقاتُ الوكلاء مستقلّتان عن المحرّك تماماً — بطاقةُ `qa-critic`
 * واحدةٌ أياً كان مَن يشغّلها. وحشرُهما في محورٍ مفهرَسٍ بالمحرّك هو الخطأ الذي
 * صحّحه ADR-073 وT-1219 مرّتين.
 *
 * **المحور: المادةُ أوّلاً والنطاقُ مرشِّحاً واحداً ثابتاً فوقها** (§4.2). المستخدم
 * يصل بنيّةٍ من نوع «أريد تعديل تعليمات نسّاج» (مادّة) لا «أريد كلَّ ما هو عامّ»
 * (نطاق)؛ والنطاقُ **خاصيّةٌ يجب أن يراها** لا محورَ تنقُّل. وإبقاؤه مرشِّحاً
 * واحداً فوق الأربع يُعلِّم نموذجَ النطاق مرّةً واحدة بدل أربع.
 *
 * **حدُّ ما يُعرَض اليوم — يُقال ولا يُلفَّق.** لا نقطةَ نهايةٍ تقرأ **محتوى** أيٍّ
 * من المواد الأربع على هذا الخادم. فما وُجد له وصفٌ يُعرَض وصفُه كاملاً (قنواتُ
 * التعليمات من `GET /api/providers/:p/governance`، والمهارات من
 * `GET /api/providers/:p/skills`)، وما لا قناةَ لقراءته يُقال عنه ذلك صراحةً —
 * لا هيكلٌ عظميٌّ دائم ولا محتوىً مُختلَق (‏`feedback_no_fabricated_tool_output`).
 */
export default function ReferencesSettingsTab() {
  const { t } = useTranslation('settings');
  const [material, setMaterial] = useState<ReferenceMaterial>('instructions');
  const [scopeFilter, setScopeFilter] = useState<ReferenceScopeFilter>('all');

  const references = useReferenceMaterials(material, true);

  const materials = useMemo<SettingsSubNavItem<ReferenceMaterial>[]>(() => {
    const LABELS: Record<ReferenceMaterial, string> = {
      instructions: t('references.materials.instructions'),
      memory: t('references.materials.memory'),
      agents: t('references.materials.agents'),
      skills: t('references.materials.skills'),
    };
    return (Object.keys(LABELS) as ReferenceMaterial[]).map((value) => ({
      value,
      label: LABELS[value],
      panelId: MATERIAL_PANEL_ID,
    }));
  }, [t]);

  const scopeOptions = useMemo<SegmentedOption<ReferenceScopeFilter>[]>(
    () => [
      { value: 'all', label: t('references.scope.all') },
      { value: 'global', label: t('references.scope.short.global') },
      { value: 'mine', label: t('references.scope.short.mine') },
      { value: 'project', label: t('references.scope.short.project') },
    ],
    [t],
  );

  const providerOptions = useMemo(
    () => visibleSettingsAgents()
      .filter((provider) => ['claude', 'codex', 'cursor', 'gemini'].includes(provider))
      .map((provider) => ({
      value: provider,
      label: AGENT_NAMES[provider] ?? provider,
      })),
    [],
  );

  const referenceItems = useMemo<ReferenceItem[]>(() => references.items.map((item) => ({
    id: item.id,
    title: item.name,
    titleTechnical: true,
    scope: item.affectedScope === 'all_members'
      ? 'global'
      : item.affectedScope === 'current_user'
        ? 'mine'
        : item.affectedScope === 'project'
          ? 'project'
          : item.affectedScope === 'none'
            ? 'no-channel'
            : 'unknown',
    fields: [
      ...(item.material === 'instructions' && item.status ? [{
        key: 'status',
        label: t('references.fields.status'),
        value: item.status === 'governed'
          ? t('references.status.governed')
          : t('references.status.ungoverned'),
        description: item.reason
          ? t(`references.reason.${item.reason}`, { defaultValue: item.reason })
          : undefined,
      }] : []),
      ...(item.updatedAt ? [{ key: 'updatedAt', label: t('references.fields.updatedAt'), value: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.updatedAt)) }] : []),
      ...(item.size !== null ? [{ key: 'size', label: t('references.fields.size'), value: new Intl.NumberFormat(undefined).format(item.size) }] : []),
      {
        key: 'affectedScope',
        label: t('references.fields.affectedScope'),
        value: item.affectedScope === 'all_members'
          ? t('references.scope.allMembers')
          : item.affectedScope === 'current_user'
            ? t('references.scope.mine')
            : item.affectedScope === 'project'
              ? t('references.scope.project')
              : item.affectedScope === 'none'
                ? t('references.scope.no-channel')
                : t('references.scope.unknown'),
      },
    ],
    body: item.content ?? null,
    bodyPath: null,
    contentNote: item.content === undefined
      ? t('references.content.selectToLoad')
      : item.contentUnavailableReason === 'unreadable'
        ? t('references.content.unreadable')
        : item.reason
          ? t(`references.reason.${item.reason}`, { defaultValue: item.reason })
          : item.contentUnavailableReason === 'no_file'
            ? t('references.content.noFile')
            : undefined,
    canEdit: item.canEdit,
    canCreateSibling: item.canCreateSibling,
  })), [references.items, t]);

  return (
    <div className="space-y-8">
      <SettingsSection
        level="page"
        icon={Library}
        title={t('references.title')}
        description={t('references.pageDescription')}
      >
        {null}
      </SettingsSection>

      <div className="space-y-4">
        <SettingsSubNav
          items={materials}
          value={material}
          onChange={setMaterial}
          label={t('references.materialsLabel')}
        />

        {/* مرشِّحُ النطاق **ثابتٌ عبر المواد الأربع** — لا وسمٌ على كل عنصر (§4.2). */}
        <SettingsRow
          label={t('references.scope.filter')}
          description={t('references.scope.filterHint')}
        >
          <SegmentedControl
            options={scopeOptions}
            value={scopeFilter}
            onChange={setScopeFilter}
            label={t('references.scope.filter')}
          />
        </SettingsRow>

        <div id={MATERIAL_PANEL_ID} role="tabpanel" className="space-y-8 pt-2">
          {material === 'instructions' && (
            <>
              <GovernanceModeSection active />
              <SettingsSection
                icon={ScrollText}
                tone="default"
                title={t('references.instructions.title')}
                description={t('references.instructions.description')}
              >
                <ReferenceMaterialPanel
                  items={referenceItems}
                  isLoading={references.isLoading}
                  failed={references.failed}
                  failureCode={references.failureCode}
                  onRetry={references.reload}
                  materialLabel={t('references.materials.instructions')}
                  scopeFilter={scopeFilter}
                  canManage={references.canManage}
                  canCreate={false}
                  saving={references.saving}
                  saveFailed={references.saveFailed}
                  onSelect={references.loadContent}
                  onSave={references.update}
                  onCreate={references.create}
                />
              </SettingsSection>
            </>
          )}

          {material === 'memory' && (
            <SettingsSection
              icon={BrainCircuit}
              tone="default"
              title={t('references.materials.memory')}
              description={t('references.memory.description')}
            >
              <ReferenceMaterialPanel
                items={referenceItems}
                isLoading={references.isLoading}
                failed={references.failed}
                failureCode={references.failureCode}
                onRetry={references.reload}
                materialLabel={t('references.materials.memory')}
                scopeFilter={scopeFilter}
                canManage={references.canManage}
                canCreate
                saving={references.saving}
                saveFailed={references.saveFailed}
                onSelect={references.loadContent}
                onSave={references.update}
                onCreate={references.create}
              />
            </SettingsSection>
          )}

          {material === 'agents' && (
            <SettingsSection
              icon={IdCard}
              tone="default"
              title={t('references.materials.agents')}
              description={t('references.agentCards.description')}
            >
              <ReferenceMaterialPanel
                items={referenceItems}
                isLoading={references.isLoading}
                failed={references.failed}
                failureCode={references.failureCode}
                onRetry={references.reload}
                materialLabel={t('references.materials.agents')}
                scopeFilter={scopeFilter}
                canManage={references.canManage}
                canCreate={false}
                saving={references.saving}
                saveFailed={references.saveFailed}
                onSelect={references.loadContent}
                onSave={references.update}
                onCreate={references.create}
              />
            </SettingsSection>
          )}

          {material === 'skills' && (
            <SettingsSection
              icon={Sparkles}
              tone="default"
              title={t('references.materials.skills')}
              description={t('references.skills.description')}
            >
              <ReferenceMaterialPanel
                items={referenceItems}
                isLoading={references.isLoading}
                failed={references.failed}
                failureCode={references.failureCode}
                onRetry={references.reload}
                materialLabel={t('references.materials.skills')}
                scopeFilter={scopeFilter}
                canManage={references.canManage}
                canCreate
                saving={references.saving}
                saveFailed={references.saveFailed}
                onSelect={references.loadContent}
                onSave={references.update}
                onCreate={references.create}
                createProviderOptions={providerOptions}
              />
            </SettingsSection>
          )}
        </div>
      </div>
    </div>
  );
}
