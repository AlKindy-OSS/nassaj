import { useState } from 'react';
import { AlertTriangle, ShieldAlert, ShieldCheck, ShieldX, SlidersHorizontal, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../../shared/view/ui';
import FieldWithAction from '../../../../FieldWithAction';
import SegmentedControl, { type SegmentedOption } from '../../../../SegmentedControl';
import SettingsCard from '../../../../SettingsCard';
import SettingsCollapsible from '../../../../SettingsCollapsible';
import SettingsGroup from '../../../../SettingsGroup';
import SettingsRow from '../../../../SettingsRow';
import SettingsSection from '../../../../SettingsSection';
import SettingsToggle from '../../../../SettingsToggle';
import type { CodexPermissionMode } from '../../../../../types/types';

/**
 * لوحة الأذونات — لغة سطوح الإعدادات v3
 * (`docs/design/SETTINGS-SURFACE-LANGUAGE.md`). لا يتغيّر هنا سلوكٌ ولا دلالةٌ
 * أمنية: نفس الأوضاع، ونفس الافتراضات، ونفس العقود مع الخادم.
 *
 * ما كان وما صار، وسببُ كلٍّ:
 *
 * - **ستّ عائلات ألوان خامّة** (برتقالي/أخضر/أحمر/أزرق/بنفسجي/زمردي) على شاشة
 *   واحدة، ولا واحدةَ منها رمزٌ في `src/index.css`. النبرة الآن بالرموز حصراً
 *   (`--success`/`--warning`/`--danger`) وهي محروسة باختبار تباين.
 * - **الإطار عاد محجوزاً للنبرة** (v3 §1): ‏`SettingsCard` بنبرتها حول التحذير
 *   وحده — كصندوق «تخطّي طلبات الإذن» البرتقالي الوحيد في لقطة الأصل. أمّا
 *   القوائم فصفوفٌ عارية في `SettingsGroup`. ‏v2 ألغت الإطار عن كل شيء فألغت
 *   معه الإشارة، وصار التحذير بوزن «حجم الخطّ».
 * - **أيقونة دلالية لكل قسم** كالأصل: مثلثٌ فوق الأذونات، ودرعٌ مصدَّق أخضر فوق
 *   المسموح، ودرعٌ مشطوب أحمر فوق الممنوع — فيُعرَف القسم قبل قراءة عنوانه.
 * - **`h3.text-lg`** كان أكبر من رأس القسم الذي يعلوه — الابن أكبر من أبيه.
 *   صارت الرؤوس `SettingsSection` على سلّم §3.
 *
 * **لماذا `SegmentedControl` لأوضاع Codex بعد `TierMatrix`:** المصفوفة
 * وضعت أسماء الأوضاع في رؤوس أعمدة وتركت الخلايا صامتة، فخرجت على الشاشة اثني
 * عشر مربّعاً فارغاً — تشخيصٌ مقيسٌ على لقطة لا مستنتَج (v2 §0-2). المنتقي
 * المجزّأ يحمل نصّه داخله، فلا خيارَ يُعرَف بموضعه. **التصعيد الأمني لا يضيع**:
 * ترتيب الخيارات هو ترتيبه (Codex: الموثوقة ← مساحة العمل ← تجاوز)، والخيار الذي يرفع الحاجز وحده يُصبغ `bg-destructive`،
 * ووصفُ الوضع المحدَّد مكتوبٌ تحته دائماً لا مدفوناً في `title`.
 */

const COMMON_CLAUDE_TOOLS = [
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Write',
  'Read',
  'Edit',
  'Glob',
  'Grep',
  'MultiEdit',
  'Task',
  'TodoWrite',
  'TodoRead',
  'WebFetch',
  'WebSearch',
];

const COMMON_CURSOR_COMMANDS = [
  'Shell(ls)',
  'Shell(mkdir)',
  'Shell(cd)',
  'Shell(cat)',
  'Shell(echo)',
  'Shell(git status)',
  'Shell(git diff)',
  'Shell(git log)',
  'Shell(npm install)',
  'Shell(npm run)',
  'Shell(python)',
  'Shell(node)',
];

const addUnique = (items: string[], value: string): string[] => {
  const normalizedValue = value.trim();
  if (!normalizedValue || items.includes(normalizedValue)) {
    return items;
  }

  return [...items, normalizedValue];
};

const removeValue = (items: string[], value: string): string[] => (
  items.filter((item) => item !== value)
);

/**
 * حالة «لا شيء بعد» — صيغةٌ واحدة في هذا النطاق كلّه: نصٌّ رمادي متمركز، وهو
 * بعينه ما يفعله الأصل («‏No allowed tools configured» في وسط الفراغ تحت
 * القائمة). كانت أربع صيغ متجاورة: نصٌّ محاذٍ للبداية هنا، ودوّارة مع نصّ هناك،
 * وسطرٌ بلا حشو في ثالث.
 */
const EMPTY_STATE_CLASS = 'py-6 text-center text-[13px] leading-relaxed text-muted-foreground';

/**
 * قائمة قيم تقنية: صفوف متجانسة يفصلها خطٌّ شعري بلا صندوق حولها (§2.2) —
 * البديل المباشر عن جعل كل صفٍّ صندوقاً مؤطَّراً ملوّناً. القيمة `dir="ltr"`
 * معزولة: نمطُ أداة أو أمر لا يرث الأساس العربي.
 */
function PatternList({
  items,
  onRemove,
  emptyLabel,
  removeLabel,
}: {
  items: string[];
  onRemove: (value: string) => void;
  emptyLabel: string;
  removeLabel: string;
}) {
  if (items.length === 0) {
    return <p className={EMPTY_STATE_CLASS}>{emptyLabel}</p>;
  }

  return (
    <SettingsGroup>
      {items.map((item) => (
        <div key={item} className="flex items-center justify-between gap-3 py-2.5">
          <span
            dir="ltr"
            style={{ unicodeBidi: 'isolate' }}
            className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground"
          >
            {item}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRemove(item)}
            aria-label={`${removeLabel}: ${item}`}
            className="w-9 flex-shrink-0 p-0 text-muted-foreground hover:text-danger"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
    </SettingsGroup>
  );
}

/** صفّ «إضافة سريعة»: أزرار الأنماط الشائعة. */
function QuickAdd({
  label,
  items,
  isAdded,
  onAdd,
}: {
  label: string;
  items: string[];
  isAdded: (value: string) => boolean;
  onAdd: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[13px] leading-relaxed text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <Button
            key={item}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAdd(item)}
            disabled={isAdded(item)}
          >
            <span dir="ltr" style={{ unicodeBidi: 'isolate' }} className="font-mono">
              {item}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

type ClaudePermissionsProps = {
  agent: 'claude';
  skipPermissions: boolean;
  onSkipPermissionsChange: (value: boolean) => void;
  allowedTools: string[];
  onAllowedToolsChange: (value: string[]) => void;
  disallowedTools: string[];
  onDisallowedToolsChange: (value: string[]) => void;
  allowVendorDelegation: boolean;
  onAllowVendorDelegationChange: (value: boolean) => void;
};

function ClaudePermissions({
  skipPermissions,
  onSkipPermissionsChange,
  allowedTools,
  onAllowedToolsChange,
  disallowedTools,
  onDisallowedToolsChange,
  allowVendorDelegation,
  onAllowVendorDelegationChange,
}: Omit<ClaudePermissionsProps, 'agent'>) {
  const { t } = useTranslation('settings');
  const [newAllowedTool, setNewAllowedTool] = useState('');
  const [newDisallowedTool, setNewDisallowedTool] = useState('');

  const handleAddAllowedTool = (tool: string) => {
    const updated = addUnique(allowedTools, tool);
    if (updated.length === allowedTools.length) {
      return;
    }

    onAllowedToolsChange(updated);
    setNewAllowedTool('');
  };

  const handleAddDisallowedTool = (tool: string) => {
    const updated = addUnique(disallowedTools, tool);
    if (updated.length === disallowedTools.length) {
      return;
    }

    onDisallowedToolsChange(updated);
    setNewDisallowedTool('');
  };

  const removeLabel = t('permissions.actions.remove');

  return (
    <div className="space-y-8">
      {/* الأصل يسبق «إعدادات الأذونات» بمثلث تحذير: القسم يحمل المفتاح الذي
          يرفع حاجز الموافقة، فنبرته `warning` لا `default`. */}
      {/* ‏`boxed` — مفتاحان وتحذيرٌ مشروط تحتهما: حدٌّ واحد يقول أين ينتهي هذا
          القسم وأين يبدأ «الأدوات المسموحة» بعده. */}
      <SettingsSection icon={ShieldAlert} tone="warning" title={t('permissions.title')} boxed>
        <SettingsGroup>
          <SettingsRow
            label={t('permissions.skipPermissions.label')}
            description={t('permissions.skipPermissions.claudeDescription')}
          >
            <SettingsToggle
              checked={skipPermissions}
              onChange={onSkipPermissionsChange}
              ariaLabel={t('permissions.skipPermissions.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('permissions.allowVendorDelegation.label')}
            description={t('permissions.allowVendorDelegation.description')}
          >
            <SettingsToggle
              checked={allowVendorDelegation}
              onChange={onAllowVendorDelegationChange}
              ariaLabel={t('permissions.allowVendorDelegation.label')}
            />
          </SettingsRow>
        </SettingsGroup>

        {/* تحذيرٌ مشروطٌ بحالة قائمة: يبقى ظاهراً ولا يُطوى أبداً (§2.9). */}
        {skipPermissions && <SkipPermissionsWarning />}
      </SettingsSection>

      {/* درعٌ أخضر فوق «الأدوات المسموحة» كالأصل: `success` = سماح. */}
      <SettingsSection
        icon={ShieldCheck}
        tone="success"
        title={t('permissions.allowedTools.title')}
        description={t('permissions.allowedTools.description')}
        // حقلُ إضافةٍ وقائمةُ اقتراحاتٍ وقائمةُ الأنماط المُضافة — ثلاث كتل.
        boxed
      >
        <FieldWithAction
          id="claude-allowed-tool"
          technical
          label={t('permissions.allowedTools.addLabel')}
          value={newAllowedTool}
          onChange={setNewAllowedTool}
          onSubmit={() => handleAddAllowedTool(newAllowedTool)}
          actionLabel={t('permissions.actions.add')}
          placeholder={t('permissions.allowedTools.placeholder')}
        />
        <QuickAdd
          label={t('permissions.allowedTools.quickAdd')}
          items={COMMON_CLAUDE_TOOLS}
          isAdded={(tool) => allowedTools.includes(tool)}
          onAdd={handleAddAllowedTool}
        />
        <PatternList
          items={allowedTools}
          onRemove={(tool) => onAllowedToolsChange(removeValue(allowedTools, tool))}
          emptyLabel={t('permissions.allowedTools.empty')}
          removeLabel={removeLabel}
        />
      </SettingsSection>

      {/* المنع نبرتُه `danger` بنصّ الخريطة، ودرعٌ مشطوب مقابل الدرع المُصدَّق
          فوقه — فالفرق مقروءٌ بالشكل لا باللون وحده (WCAG 1.4.1). */}
      <SettingsSection
        icon={ShieldX}
        tone="danger"
        title={t('permissions.blockedTools.title')}
        description={t('permissions.blockedTools.description')}
        boxed
      >
        <FieldWithAction
          id="claude-blocked-tool"
          technical
          label={t('permissions.blockedTools.addLabel')}
          value={newDisallowedTool}
          onChange={setNewDisallowedTool}
          onSubmit={() => handleAddDisallowedTool(newDisallowedTool)}
          actionLabel={t('permissions.actions.add')}
          placeholder={t('permissions.blockedTools.placeholder')}
        />
        <PatternList
          items={disallowedTools}
          onRemove={(tool) => onDisallowedToolsChange(removeValue(disallowedTools, tool))}
          emptyLabel={t('permissions.blockedTools.empty')}
          removeLabel={removeLabel}
        />
      </SettingsSection>

      {/* الأمثلة شرحٌ يحتاجه بعض القرّاء بعض الوقت — سطحٌ مطويّ بلا إطار (§2.9). */}
      <SettingsCollapsible summary={t('permissions.toolExamples.title')}>
        <ul className="space-y-1">
          <li><PatternSample value='"Bash(git log:*)"' /> {t('permissions.toolExamples.bashGitLog')}</li>
          <li><PatternSample value='"Bash(git diff:*)"' /> {t('permissions.toolExamples.bashGitDiff')}</li>
          <li><PatternSample value='"Write"' /> {t('permissions.toolExamples.write')}</li>
          <li><PatternSample value='"Bash(rm:*)"' /> {t('permissions.toolExamples.bashRm')}</li>
        </ul>
      </SettingsCollapsible>
    </div>
  );
}

/**
 * نمطٌ مثالي داخل سطح مطويّ. بلا خلفية خاصّة به: السطح المطويّ هو `bg-muted`
 * (S2)، وسطحٌ ثالث فوقه ممنوع منعاً باتاً (§1).
 */
function PatternSample({ value }: { value: string }) {
  return (
    <code dir="ltr" style={{ unicodeBidi: 'isolate' }} className="font-mono text-foreground">
      {value}
    </code>
  );
}

/**
 * الحاجز مرفوعٌ الآن — **صندوق نبرة** لا نصٌّ ملوّن عارٍ.
 *
 * هذا هو الإطار الوحيد في لقطة الأصل: مربّعٌ برتقالي حول «تخطّي طلبات الإذن»،
 * وما حوله صفوفٌ عارية. الإطار هنا يحمل معلومة — «هذه المنطقة ليست كبقيّتها» —
 * وهو ما أسقطته النسخة التي جعلت التحذير سطراً ملوّناً بين سطور: على شاشةٍ فيها
 * مفتاح «نفّذ أي أمر بلا سؤال» لا يكفي أن يتلوّن النصّ.
 */
function SkipPermissionsWarning() {
  const { t } = useTranslation('settings');

  return (
    <SettingsCard tone="warning">
      <p role="status" className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        {t('permissions.skipPermissions.activeWarning')}
      </p>
    </SettingsCard>
  );
}

type CursorPermissionsProps = {
  agent: 'cursor';
  skipPermissions: boolean;
  onSkipPermissionsChange: (value: boolean) => void;
  allowedCommands: string[];
  onAllowedCommandsChange: (value: string[]) => void;
  disallowedCommands: string[];
  onDisallowedCommandsChange: (value: string[]) => void;
};

function CursorPermissions({
  skipPermissions,
  onSkipPermissionsChange,
  allowedCommands,
  onAllowedCommandsChange,
  disallowedCommands,
  onDisallowedCommandsChange,
}: Omit<CursorPermissionsProps, 'agent'>) {
  const { t } = useTranslation('settings');
  const [newAllowedCommand, setNewAllowedCommand] = useState('');
  const [newDisallowedCommand, setNewDisallowedCommand] = useState('');

  const handleAddAllowedCommand = (command: string) => {
    const updated = addUnique(allowedCommands, command);
    if (updated.length === allowedCommands.length) {
      return;
    }

    onAllowedCommandsChange(updated);
    setNewAllowedCommand('');
  };

  const handleAddDisallowedCommand = (command: string) => {
    const updated = addUnique(disallowedCommands, command);
    if (updated.length === disallowedCommands.length) {
      return;
    }

    onDisallowedCommandsChange(updated);
    setNewDisallowedCommand('');
  };

  const removeLabel = t('permissions.actions.remove');

  return (
    <div className="space-y-8">
      <SettingsSection icon={ShieldAlert} tone="warning" title={t('permissions.title')}>
        <SettingsGroup>
          <SettingsRow
            label={t('permissions.skipPermissions.label')}
            description={t('permissions.skipPermissions.cursorDescription')}
          >
            <SettingsToggle
              checked={skipPermissions}
              onChange={onSkipPermissionsChange}
              ariaLabel={t('permissions.skipPermissions.label')}
            />
          </SettingsRow>
        </SettingsGroup>

        {skipPermissions && <SkipPermissionsWarning />}
      </SettingsSection>

      <SettingsSection
        icon={ShieldCheck}
        tone="success"
        title={t('permissions.allowedCommands.title')}
        description={t('permissions.allowedCommands.description')}
        boxed
      >
        <FieldWithAction
          id="cursor-allowed-command"
          technical
          label={t('permissions.allowedCommands.addLabel')}
          value={newAllowedCommand}
          onChange={setNewAllowedCommand}
          onSubmit={() => handleAddAllowedCommand(newAllowedCommand)}
          actionLabel={t('permissions.actions.add')}
          placeholder={t('permissions.allowedCommands.placeholder')}
        />
        <QuickAdd
          label={t('permissions.allowedCommands.quickAdd')}
          items={COMMON_CURSOR_COMMANDS}
          isAdded={(command) => allowedCommands.includes(command)}
          onAdd={handleAddAllowedCommand}
        />
        <PatternList
          items={allowedCommands}
          onRemove={(command) => onAllowedCommandsChange(removeValue(allowedCommands, command))}
          emptyLabel={t('permissions.allowedCommands.empty')}
          removeLabel={removeLabel}
        />
      </SettingsSection>

      <SettingsSection
        icon={ShieldX}
        tone="danger"
        title={t('permissions.blockedCommands.title')}
        description={t('permissions.blockedCommands.description')}
        boxed
      >
        <FieldWithAction
          id="cursor-blocked-command"
          technical
          label={t('permissions.blockedCommands.addLabel')}
          value={newDisallowedCommand}
          onChange={setNewDisallowedCommand}
          onSubmit={() => handleAddDisallowedCommand(newDisallowedCommand)}
          actionLabel={t('permissions.actions.add')}
          placeholder={t('permissions.blockedCommands.placeholder')}
        />
        <PatternList
          items={disallowedCommands}
          onRemove={(command) => onDisallowedCommandsChange(removeValue(disallowedCommands, command))}
          emptyLabel={t('permissions.blockedCommands.empty')}
          removeLabel={removeLabel}
        />
      </SettingsSection>

      <SettingsCollapsible summary={t('permissions.shellExamples.title')}>
        <ul className="space-y-1">
          <li><PatternSample value='"Shell(ls)"' /> {t('permissions.shellExamples.ls')}</li>
          <li><PatternSample value='"Shell(git status)"' /> {t('permissions.shellExamples.gitStatus')}</li>
          <li><PatternSample value='"Shell(npm install)"' /> {t('permissions.shellExamples.npmInstall')}</li>
          <li><PatternSample value='"Shell(rm -rf)"' /> {t('permissions.shellExamples.rmRf')}</li>
        </ul>
      </SettingsCollapsible>
    </div>
  );
}

/**
 * وصفُ الوضع المحدَّد، تحت المنتقي مباشرة.
 *
 * المنتقي يُظهر **الاسم والترتيب**، وهذا السطر يُبقي **المعنى** ظاهراً: في شاشة
 * قرارُها أمني لا يُدفن شرحُ الوضع الجاري في `title` لا يقرؤه إلا مَن حوّم بفأرة.
 * وحين يكون الوضع المحدَّد هو الذي يرفع الحاجز يصير السطر **صندوق نبرة**
 * `warning` كصندوق «تخطّي طلبات الإذن»: الحالتان واحدة، فليكن سطحُهما واحداً.
 */
function SelectedModeNote({ description, danger }: { description: string; danger: boolean }) {
  if (!danger) {
    return <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>;
  }

  return (
    <SettingsCard tone="warning">
      <p role="status" className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        {description}
      </p>
    </SettingsCard>
  );
}

type CodexPermissionsProps = {
  agent: 'codex';
  permissionMode: CodexPermissionMode;
  onPermissionModeChange: (value: CodexPermissionMode) => void;
};

function CodexPermissions({ permissionMode, onPermissionModeChange }: Omit<CodexPermissionsProps, 'agent'>) {
  const { t } = useTranslation('settings');

  // الترتيب تصاعديٌّ بالاستقلالية: الموثوقة ← مساحة العمل ← تجاوز. ترتيب الخيارات
  // في المنتقي هو ما يحمل هذا التصعيد الآن، والاسم مكتوبٌ داخل كل خيار.
  const options: readonly SegmentedOption<CodexPermissionMode>[] = [
    {
      value: 'default',
      label: t('permissions.codex.modesShort.default'),
    },
    {
      value: 'acceptEdits',
      label: t('permissions.codex.modesShort.acceptEdits'),
    },
    {
      value: 'bypassPermissions',
      label: t('permissions.codex.modesShort.bypassPermissions'),
      // الخيار الذي يرفع حاجز الموافقة — هو وحده يُصبغ، ولو صُبغ غيرُه لضاعت
      // الإشارة (§2.4).
      danger: true,
    },
  ];

  const selected = options.find((option) => option.value === permissionMode) ?? options[0];
  const descriptionByMode: Record<CodexPermissionMode, string> = {
    default: t('permissions.codex.modes.default.description'),
    acceptEdits: t('permissions.codex.modes.acceptEdits.description'),
    bypassPermissions: t('permissions.codex.modes.bypassPermissions.description'),
  };

  return (
    <div className="space-y-8">
      {/* اختيارُ وضعٍ من ثلاثة إعدادٌ محايد بارز، والخطرُ في **الخيار** لا في
          القسم — فهو يُصبغ وحده (`bg-destructive`) ويُلَفّ وصفُه بصندوق نبرة. */}
      <SettingsSection
        icon={SlidersHorizontal}
        tone="info"
        title={t('permissions.codex.permissionMode')}
        description={t('permissions.codex.description')}
        // صفُّ الاختيار ومعه ملاحظةُ الوضع المختار ثم تفاصيلٌ مطويّة — لا سطرٌ واحد.
        boxed
      >
        <SettingsGroup>
          <SettingsRow stacked label={t('permissions.modeRowLabel')}>
            <div className="space-y-2.5">
              <SegmentedControl
                options={options}
                value={permissionMode}
                onChange={onPermissionModeChange}
                label={t('permissions.codex.permissionMode')}
              />
              <SelectedModeNote
                description={descriptionByMode[selected.value]}
                danger={Boolean(selected.danger)}
              />
            </div>
          </SettingsRow>
        </SettingsGroup>

        <SettingsCollapsible summary={t('permissions.codex.technicalDetails')}>
          <p>
            <strong>{t('permissions.codex.modes.default.title')}:</strong>{' '}
            {t('permissions.codex.technicalInfo.default')}
          </p>
          <p>
            <strong>{t('permissions.codex.modes.acceptEdits.title')}:</strong>{' '}
            {t('permissions.codex.technicalInfo.acceptEdits')}
          </p>
          <p>
            <strong>{t('permissions.codex.modes.bypassPermissions.title')}:</strong>{' '}
            {t('permissions.codex.technicalInfo.bypassPermissions')}
          </p>
          <p>{t('permissions.codex.technicalInfo.overrideNote')}</p>
        </SettingsCollapsible>
      </SettingsSection>
    </div>
  );
}

type AntigravityPermissionsProps = {
  agent: 'antigravity';
};

/*
 * agy (Antigravity CLI) does not expose configurable allow/deny tool lists or a
 * selectable permission mode the way Claude/Cursor/Codex do. The server
 * always spawns agy with `--dangerously-skip-permissions` and the agent's
 * autonomy is governed inside agy's own CLI settings, not from this UI. We
 * surface that reality here so the Permissions tab is never blank and matches
 * the informational style used for the Antigravity account panel.
 */
function AntigravityPermissions() {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-8">
      <SettingsSection
        icon={ShieldAlert}
        tone="warning"
        title={t('permissions.antigravity.title')}
        description={t('permissions.antigravity.description')}
        // صندوقُ النبرة وصفُّ ملاحظة الطرفية تحته — كتلتان لا سطر.
        boxed
      >
        {/* حاجزٌ مرفوعٌ **دائماً** على هذا المزوّد — لا مفتاحَ يُطفئه. فهو أولى
            بصندوق النبرة من الحالة المشروطة عند كلود: تلك يستطيع القارئ إسقاطها
            بضغطة، وهذه واقعٌ يعيش معه. صفٌّ عارٍ بلصيقة ملوّنة كان يجعله بوزن
            «ملاحظة الطرفية» تحته، وهما ليسا سواءً. */}
        <SettingsCard tone="warning">
          <div role="status" className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium">
                {t('permissions.antigravity.skipPermissions.label')}
              </p>
              <p className="mt-0.5">
                {t('permissions.antigravity.skipPermissions.description')}
              </p>
            </div>
          </div>
        </SettingsCard>

        <SettingsGroup>
          <SettingsRow
            label={
              <span className="flex items-center gap-1.5">
                <Terminal className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                {t('permissions.antigravity.cliNote.title')}
              </span>
            }
            description={t('permissions.antigravity.cliNote.description')}
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

type PermissionsContentProps =
  | ClaudePermissionsProps
  | CursorPermissionsProps
  | CodexPermissionsProps
  | AntigravityPermissionsProps;

export default function PermissionsContent(props: PermissionsContentProps) {
  if (props.agent === 'claude') {
    return <ClaudePermissions {...props} />;
  }

  if (props.agent === 'cursor') {
    return <CursorPermissions {...props} />;
  }

  if (props.agent === 'antigravity') {
    return <AntigravityPermissions />;
  }

  return <CodexPermissions {...props} />;
}
