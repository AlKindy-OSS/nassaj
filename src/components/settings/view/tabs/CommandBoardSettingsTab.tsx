import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Inbox,
  ListChecks,
  Loader2,
  Lock,
  Pencil,
  Plus,
  ShieldAlert,
  Terminal,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { useAuth } from '../../../auth';
import { authenticatedFetch } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import FieldWithAction from '../FieldWithAction';
import SettingsCard from '../SettingsCard';
import SettingsCardHeader from '../SettingsCardHeader';
import SettingsCollapsible from '../SettingsCollapsible';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import StatusBadge from '../StatusBadge';
import SegmentedControl from '../SegmentedControl';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import type { TierMatrixTier } from '../TierMatrix';
// Type only: the review dialog itself is mounted by the sidebar command board,
// which is now the single place a queued command is shown and run (T-1036).
import type { RawCommand } from '../../../command-board/ExecReviewDialog';
import { deniedCommandMessage } from '../../../command-board/denyRuleSeverity';
import { invalidateRawExecConfig } from '../../../../hooks/useRawExecConfig';

// T-948 / ADR-067 — owner-only Command Board management.
// Phase 1: role modes + action toggles (below).
// Phase 2: owner-defined custom commands (CustomCommandsSection, below).

type RoleMode = 'none' | 'safe' | 'custom' | 'raw';
type CatalogAction = {
  actionType: string;
  label: string;
  commandPreview: string | null;
  minRole: string;
};
type BoardConfig = {
  roleModes: Record<string, RoleMode>;
  disabledActions: string[];
  /** Highest tier the owner may assign to each role (ADR-072; from server). */
  maxAssignableTier?: Record<string, string>;
  /** Whether the raw-exec ceiling is currently armed (true = 'raw' effective). */
  rawExecEnabled?: boolean;
  /** Symbolic codes blocking arming (e.g. 'is_platform'). Empty = no blocker. */
  rawExecBlockedReasons?: string[];
};
type Feedback = { kind: 'success' | 'error'; message: string } | null;

/** Graceful degradation: 'general' (old server vocab) → 'custom'; unknown → 'none'. */
function normalizeMode(mode: unknown): RoleMode {
  if (mode === 'general') return 'custom';
  if (mode === 'none' || mode === 'safe' || mode === 'custom' || mode === 'raw') return mode;
  return 'none';
}

/**
 * Fail-safe fallback used ONLY when the server omits maxAssignableTier — i.e. a
 * pre-ADR-072 build, whose route floor was owner-only anyway. Offering admin/user
 * a raw column there would render a button the server would refuse, so the
 * fallback stays conservative. A current server sends the real map (raw for every
 * role since the 2026-07-26 amendment) and the UI follows it, not this constant.
 */
const DEFAULT_MAX_ASSIGNABLE_TIER: Record<string, string> = {
  owner: 'raw',
  admin: 'custom',
  user: 'custom',
};

// ADR-072: every row is editable and every tier — raw included — is assignable to
// every role (owner decision 2026-07-26). The single visual restriction left is
// 'none' for the owner (server floors it to safe: the owner cannot lock themselves
// out). Whether 'raw' is offered comes from the server's maxAssignableTier.
const MANAGED_ROLES: ReadonlyArray<{ role: string; editable: boolean }> = [
  { role: 'owner', editable: true },
  { role: 'admin', editable: true },
  { role: 'user', editable: true },
];

const CFG_URL = '/api/system/command-board-config';
const CUSTOM_URL = '/api/system/command-board-custom';

// ── Custom Commands section (T-948 Phase 2) ──────────────────────────────────

type CustomCommand = {
  key: string;
  label: string;
  cmd: string | null;
  args: string[];
  minRole: string;
  valid: boolean;
  commandPreview: string | null;
  error: string | null;
};

type FormState = {
  key: string;
  label: string;
  cmd: string;
  args: string[];
  minRole: string;
};

type CustomFeedback = { kind: 'success' | 'error'; message: string } | null;

const VALID_ROLES = ['owner', 'admin', 'user'] as const;

/** Maps a server error code (possibly with :<suffix>) to an i18n key. */
function resolveCustomErrorKey(code: string): string {
  if (code.startsWith('interpreter_forbidden')) return 'interpreter_forbidden';
  if (code.startsWith('cmd_not_allowlisted')) return 'cmd_not_allowlisted';
  if (code.startsWith('npm_script_missing')) return 'npm_script_missing';
  if (code.startsWith('npm_script_denylisted') || code.startsWith('npm_')) return 'denylisted';
  if (['invalid_key','key_reserved','key_exists','invalid_label','invalid_min_role',
       'flag_arg_forbidden','invalid_arg','too_many_commands','not_found','internal'].includes(code)) {
    return code;
  }
  return 'internal';
}

/**
 * صياغةُ حقلٍ واحدة لكل حقول هذا التبويب (§2.7).
 *
 * كانت خمسة حقول تحمل خمس نسخٍ من نفس السلسلة الطويلة، فاختلفت بينها الحشوات
 * (`py-1.5`) والمقاسات (`text-sm` مقابل `text-[13px]`) بلا قصد — والحقلُ الذي
 * يختلف ارتفاعه عن جاره في نفس النموذج يُقرأ عطلاً لا تنويعاً.
 */
const FIELD_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** قيمة تقنية (مفتاح، تنفيذي، معامل): خطّ أحادي المسافة ومقاسٌ من السلّم. */
const FIELD_TECHNICAL_CLASS = 'font-mono text-[13px]';

/** لصيقة حقلٍ + تحكّمه + شرحه — الثلاثة بإيقاعٍ واحد ومربوطةٌ بـ`htmlFor`. */
function FormField({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-[13px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function CustomCommandsSection({ onCountChange }: { onCountChange?: (count: number) => void }) {
  const { t } = useTranslation('settings');
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [serverMax, setServerMax] = useState(20);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<CustomFeedback>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    key: '', label: '', cmd: 'npm', args: ['run', ''], minRole: 'owner',
  });
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<{ code: string; message: string } | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const resolveMsg = useCallback((code: string): string => {
    const key = resolveCustomErrorKey(code);
    return t(`commandBoardSettings.customCommands.errors.${key}`, { defaultValue: code }) as string;
  }, [t]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await (authenticatedFetch as (url: string) => Promise<Response>)(CUSTOM_URL);
      if (!res.ok) throw new Error('load');
      const data = (await res.json()) as { commands: CustomCommand[]; maxCommands: number };
      setCommands(data.commands ?? []);
      onCountChange?.((data.commands ?? []).length);
      if (typeof data.maxCommands === 'number') setServerMax(data.maxCommands);
    } catch {
      setFeedback({ kind: 'error', message: t('commandBoardSettings.customCommands.loadError') });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const atCap = commands.length >= serverMax;

  const openAdd = () => {
    setEditingKey(null);
    setForm({ key: '', label: '', cmd: 'npm', args: ['run', ''], minRole: 'owner' });
    setFormError(null);
    setFeedback(null);
    setShowForm(true);
  };

  const openEdit = (cmd: CustomCommand) => {
    setEditingKey(cmd.key);
    setForm({
      key: cmd.key,
      label: cmd.label,
      cmd: cmd.cmd ?? 'npm',
      args: cmd.args.length ? [...cmd.args] : ['run', ''],
      minRole: cmd.minRole,
    });
    setFormError(null);
    setFeedback(null);
    setShowForm(true);
  };

  const cancelForm = () => {
    setShowForm(false);
    setFormError(null);
  };

  const updateArg = (idx: number, value: string) => {
    setForm(prev => {
      const newArgs = [...prev.args];
      newArgs[idx] = value;
      return { ...prev, args: newArgs };
    });
  };

  const addArg = () => {
    if (form.args.length >= 8) return;
    setForm(prev => ({ ...prev, args: [...prev.args, ''] }));
  };

  const removeArg = (idx: number) => {
    setForm(prev => ({ ...prev, args: prev.args.filter((_, i) => i !== idx) }));
  };

  const handleSaveForm = async () => {
    setFormSaving(true);
    setFormError(null);
    try {
      const isEdit = editingKey !== null;
      const body = {
        key: form.key,
        label: form.label,
        cmd: form.cmd,
        args: form.args.filter(a => a.trim() !== ''),
        minRole: form.minRole,
      };
      const url = isEdit ? `${CUSTOM_URL}/${editingKey}` : CUSTOM_URL;
      const method = isEdit ? 'PUT' : 'POST';
      const res = await (authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>)(
        url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const code = String(data.code ?? 'internal');
        setFormError({ code, message: resolveMsg(code) });
        return;
      }
      setShowForm(false);
      setFeedback({ kind: 'success', message: t('commandBoardSettings.saved') });
      void load();
    } catch {
      setFormError({ code: 'internal', message: resolveMsg('internal') });
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async (key: string) => {
    try {
      await (authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>)(
        `${CUSTOM_URL}/${key}`, { method: 'DELETE' },
      );
      setConfirmDeleteKey(null);
      void load();
    } catch {
      setFeedback({ kind: 'error', message: resolveMsg('internal') });
    }
  };

  return (
    /* قسمٌ لا بطاقة. كان `SettingsCard` بنبرة `default` — أي معبرٌ شفّاف لا يرسم
       شيئاً — يحمل `SettingsCardHeader` بمقاس `text-base`، بينما جاراه في
       التبويب («صلاحية الأدوار» و«الأوامر المتاحة») أقسامٌ بمقاس `text-lg`
       وأيقونة. فكان القسم الوحيد الذي يقرأ مرؤوساً لأنداده بلا سبب. */
    <SettingsSection
      boxed
      icon={Wrench}
      title={t('commandBoardSettings.customCommands.title')}
      description={t('commandBoardSettings.customCommands.description')}
    >
      {/* الإيقاع الداخلي في لوحٍ واحد: البطاقة (`boxed`) تحمل حشوها فقط، فأبناؤها
          المباشرون بلا فجوة بينهم — والقسم هنا ليس قائمة صفوف بل عدّاد وتنبيه
          وقائمة ونموذج، فيلزمها لوحٌ يتباعد أبناؤه. */}
      <div className="space-y-3 py-2">
      {/* العدّاد ونموذج الحفظ والفعل في صفٍّ واحد تحت الرأس: البدائية المشتركة
          لا تملك فتحة `trailing`، وشقُّ فتحةٍ فيها خارج نطاق ترحيلٍ بصري. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge>
            {t('commandBoardSettings.customCommands.counter', {
              count: commands.length,
              max: serverMax,
            })}
          </StatusBadge>
          <StatusBadge>{t('commandBoardSettings.savesImmediately')}</StatusBadge>
        </div>
        {!showForm && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={atCap || loading}
            onClick={openAdd}
            className="gap-1 px-2.5"
            aria-label={t('commandBoardSettings.customCommands.addCommand')}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('commandBoardSettings.customCommands.addCommand')}
          </Button>
        )}
      </div>

      {/* Section feedback — صندوقُ نبرة بنفس صياغة بقيّة الحصائل في هذه الجولة. */}
      {feedback && !showForm && (
        <SettingsCard tone={feedback.kind === 'success' ? 'success' : 'danger'}>
          <p
            role="status"
            className={cn(
              'text-[13px] leading-relaxed',
              feedback.kind === 'success' ? 'text-success' : 'text-danger',
            )}
          >
            {feedback.message}
          </p>
        </SettingsCard>
      )}

      {/* التحميل بالنمط الموحَّد: نصّ رمادي متمركز (نمط الأصل). */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('commandBoardSettings.loading')}
        </div>
      )}

      {/* **صفوفُ الأمر المخصّص صفوفٌ كبقيّة صفوف التبويب.** كانت تخطيطاً
          مبنيّاً بيد داخل قائمةٍ مسطَّرة (`divide-y`): فاصلٌ أفقي لا يوجد له
          نظير في أي قسمٍ آخر من التبويب، ومقاسات (`text-sm`) خارج سلّم اللصائق،
          وأزرار أيقونة بحشوٍ خاصّ. فقُرئ القسم كأنه من تطبيقٍ ثانٍ لُصق هنا.
          الآن: `SettingsGroup` + `SettingsRow` — اللصيقة والوصف والتحكّم بنفس
          الإيقاع الذي عليه «الأوامر المتاحة» فوقه بالضبط.
          والخطّ لا يعود هنا: القارئ لا يقارن أمراً بأمر عموداً، والحدّ المكتوب
          في §2.2 يحصر الخطّ في جدول الأعضاء وحده. */}
      {!loading && (
        <>
          {commands.length === 0 && !showForm && (
            <p className="py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
              {t('commandBoardSettings.customCommands.empty')}
            </p>
          )}

          <SettingsGroup>
            {commands.map(cmd => (
              <SettingsRow
                key={cmd.key}
                className={cn(!cmd.valid && 'border-s-2 border-destructive ps-3')}
                label={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate">{cmd.label}</span>
                    <StatusBadge>{cmd.minRole}</StatusBadge>
                    {/* Invalid badge — شارةٌ بالبدائية لا نصّاً أحمر عارياً بجوار
                        شارةٍ محايدة: كانتا تؤدّيان عمل الشارة نفسه بوعاءين. */}
                    {!cmd.valid && (
                      <StatusBadge tone="danger">
                        {t('commandBoardSettings.customCommands.invalidRow')}
                      </StatusBadge>
                    )}
                  </span>
                }
                description={
                  <>
                    {/* المفتاح ومعاينة الأمر قيمتان تقنيتان: سطرٌ واحد معزول
                        الاتجاه بدل سطرين، فالوصفُ وصفٌ لا كتلة. */}
                    <span className="block truncate font-mono" dir="ltr" style={{ unicodeBidi: 'isolate' }}>
                      {cmd.commandPreview ? `${cmd.key} · ${cmd.commandPreview}` : cmd.key}
                    </span>
                    {!cmd.valid && cmd.error && (
                      <span className="mt-0.5 block text-danger">
                        {t('commandBoardSettings.customCommands.invalidRowReason', {
                          error: resolveMsg(cmd.error),
                        })}
                      </span>
                    )}
                  </>
                }
              >
                {/* Delete confirm inline */}
                {confirmDeleteKey === cmd.key ? (
                  <div className="flex min-h-9 flex-wrap items-center justify-end gap-1.5">
                    <span className="text-[13px] text-muted-foreground">
                      {t('commandBoardSettings.customCommands.deleteConfirm', { key: cmd.key })}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="px-3"
                      onClick={() => void handleDelete(cmd.key)}
                    >
                      {t('commandBoardSettings.customCommands.deleteConfirmYes')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="px-3"
                      onClick={() => setConfirmDeleteKey(null)}
                    >
                      {t('commandBoardSettings.customCommands.deleteConfirmNo')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-h-9 items-center justify-end gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="w-9 p-0"
                      aria-label={`${t('commandBoardSettings.customCommands.form.editTitle')} ${cmd.key}`}
                      onClick={() => openEdit(cmd)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="w-8 hover:text-danger"
                      aria-label={`${t('commandBoardSettings.customCommands.deleteConfirmYes')} ${cmd.key}`}
                      onClick={() => setConfirmDeleteKey(cmd.key)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </SettingsRow>
            ))}
          </SettingsGroup>
        </>
      )}

      {/* Add/Edit form — كتلةٌ داخل البطاقة لا صندوقاً مؤطَّراً: صندوق `p-4` داخل
          بطاقة `p-4` كان الإطار الثالث على نفس الشاشة (§1). التمييز بالسطح لا بالحدّ. */}
      {showForm && (
        <div className="rounded-md bg-muted p-3">
          {/* لصيقةُ لوحٍ لا عنوانُ قسم: مقاسها من سلّم اللصائق
              (`text-[15px] font-medium`)، لا `text-sm font-semibold` الذي لا موضع
              له في السلّم فيقرأ عنواناً رابعاً بمقاسٍ مخترع. */}
          <p className="mb-3 text-[15px] font-medium leading-relaxed text-foreground">
            {editingKey
              ? t('commandBoardSettings.customCommands.form.editTitle')
              : t('commandBoardSettings.customCommands.form.title')}
          </p>

          <div className="space-y-3">
            {/* حدّ القائمة البيضاء **حيث يقع الفعل** لا فوق القائمة دائماً.
                كان صندوق تحذيرٍ ثابتاً في رأس القسم يقول «npm فقط» بينما يقول
                حقلُ `cmd` في النموذج الشيءَ نفسه بنبرةٍ ملوّنة — تحذيران
                لقاعدةٍ واحدة، أحدهما معروضٌ على من يقرأ القائمة ولا يضيف شيئاً.
                القاعدة قيدٌ على **الإضافة**، فموضعها النموذج. */}
            <SettingsCard tone="warning">
              <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                {t('commandBoardSettings.customCommands.allowlistNote')}
              </p>
            </SettingsCard>

            {/* Key field (immutable when editing) */}
            <FormField
              id="custom-cmd-key"
              label={t('commandBoardSettings.customCommands.form.key')}
              hint={t('commandBoardSettings.customCommands.form.keyHint')}
            >
              <input
                id="custom-cmd-key"
                type="text"
                value={form.key}
                disabled={editingKey !== null}
                onChange={e => setForm(prev => ({ ...prev, key: e.target.value }))}
                placeholder="my-command"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                className={cn(
                  FIELD_CLASS,
                  FIELD_TECHNICAL_CLASS,
                  editingKey !== null && 'cursor-not-allowed opacity-60',
                )}
              />
            </FormField>

            {/* Label field */}
            <FormField
              id="custom-cmd-label"
              label={t('commandBoardSettings.customCommands.form.label')}
            >
              <input
                id="custom-cmd-label"
                type="text"
                value={form.label}
                onChange={e => setForm(prev => ({ ...prev, label: e.target.value }))}
                placeholder={t('commandBoardSettings.customCommands.form.labelHint')}
                className={FIELD_CLASS}
              />
            </FormField>

            {/* cmd field */}
            <FormField
              id="custom-cmd-cmd"
              label={t('commandBoardSettings.customCommands.form.cmd')}
              hint={t('commandBoardSettings.customCommands.form.cmdHint')}
            >
              <input
                id="custom-cmd-cmd"
                type="text"
                value={form.cmd}
                onChange={e => setForm(prev => ({ ...prev, cmd: e.target.value }))}
                placeholder="npm"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                className={cn(FIELD_CLASS, FIELD_TECHNICAL_CLASS)}
              />
            </FormField>

            {/* args fields (dynamic list) */}
            <FormField
              id="custom-cmd-arg-0"
              label={t('commandBoardSettings.customCommands.form.args')}
              hint={t('commandBoardSettings.customCommands.form.argsHint')}
            >
              <div className="space-y-1.5">
                {form.args.map((arg, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <input
                      id={`custom-cmd-arg-${idx}`}
                      type="text"
                      value={arg}
                      onChange={e => updateArg(idx, e.target.value)}
                      placeholder={`arg ${idx + 1}`}
                      dir="ltr"
                      style={{ unicodeBidi: 'isolate' }}
                      className={cn(FIELD_CLASS, FIELD_TECHNICAL_CLASS, 'min-w-0 flex-1')}
                    />
                    {/* زرٌّ بالبدائية لا `<button>` عارياً: مقاسه من مقاس الأزرار
                        ولا يخترع حشوه (نفس علّة صفوف القائمة أعلاه). */}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="w-8 flex-shrink-0 hover:text-danger"
                      onClick={() => removeArg(idx)}
                      aria-label={t('commandBoardSettings.customCommands.form.removeArg')}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                {form.args.length < 8 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="gap-1 px-2.5"
                    onClick={addArg}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('commandBoardSettings.customCommands.form.addArg')}
                  </Button>
                )}
              </div>
            </FormField>

            {/* minRole select */}
            <FormField
              id="custom-cmd-min-role"
              label={t('commandBoardSettings.customCommands.form.minRole')}
            >
              <select
                id="custom-cmd-min-role"
                value={form.minRole}
                onChange={e => setForm(prev => ({ ...prev, minRole: e.target.value }))}
                className={FIELD_CLASS}
              >
                {VALID_ROLES.map(role => (
                  <option key={role} value={role}>
                    {t(`commandBoardSettings.roleNames.${role}`, { defaultValue: role }) as string}
                  </option>
                ))}
              </select>
            </FormField>

            {/* Form-level error from server */}
            {formError && (
              <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-danger" role="alert">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                {formError.message}
              </p>
            )}

            {/* Form action buttons */}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={cancelForm}
                disabled={formSaving}
                className="px-3"
              >
                {t('commandBoardSettings.customCommands.form.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSaveForm()}
                disabled={formSaving}
                className="px-3"
              >
                {formSaving && <Loader2 className="me-1 h-3 w-3 animate-spin" aria-hidden="true" />}
                {formSaving
                  ? t('commandBoardSettings.customCommands.form.saving')
                  : t('commandBoardSettings.customCommands.form.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>
    </SettingsSection>
  );
}

// ── T-962 / T-948 Phase 3 / ADR-070 — Raw-exec UI ───────────────────────────
//
// ⚖️ DOCUMENTED VETO OVERRIDE. The owner explicitly chose to build this after
// qa-critic placed a final veto (2026-07-24). The UI's entire job is to make
// the HUMAN REVIEW guarantee technically reliable, not merely cosmetic:
//   • Every command renders with dir="ltr" + unicode-bidi: isolate so the owner
//     reads exactly the bytes that will run (Trojan Source visual spoofing
//     prevention in an RTL page).
//   • The execute button is gated behind an explicit, per-command, non-remembered
//     checkbox — not a single click, not a toggle that persists.
//   • confirmationDigest = sha256 computed HERE, over the exact string this
//     component rendered. Echoing the server's own digest back would only prove
//     "the row id still resolves", which the server knows already; hashing the
//     rendered bytes is what ties the execution to what a human actually read.
//   • No inline "Execute" buttons anywhere outside the review dialog.
//
// T-1036 (2026-07-28) moved WHERE a queued command is shown, and nothing else.
// The rows, the review dialog and the dismiss control now live only in the
// sidebar command board; this tab enqueues and configures. Every guarantee above
// still holds because it was never implemented here — it lives in
// ExecReviewDialog, which the board mounts and this tab no longer does.

const RAW_URL = '/api/system/command-board-raw';

// RawCommand is imported from ExecReviewDialog (shared component).

type RawData = {
  rawExecEnabled: boolean;
  /** Effective tier for the owner; 'raw'|'general' enable the queue ('general' = old server) */
  mode: string;
  maxCommands: number;
  commands: RawCommand[];
};

function resolveAddError(
  code: string,
  position: number | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const base = 'commandBoardSettings.rawExec.queue.addError';
  if (code === 'forbidden_control_char') {
    return t(`${base}.forbidden_control_char`, {
      position: position ?? '?',
      defaultValue: `Forbidden character at position ${position ?? '?'}`,
    });
  }
  // B-260: arrives as `denied_command:<rule>`; without the prefix match it fell
  // through to 'internal' and a deliberate denylist refusal read as a breakage.
  // B-1278: the wording follows the rule's severity (denyRuleSeverity).
  const denied = deniedCommandMessage(t, code, base);
  if (denied !== null) return denied;
  const known = [
    'empty_command', 'command_too_long', 'too_many_commands',
    'raw_exec_disabled', 'config_denied', 'invalid_command',
    // New server codes (multi-line support lift):
    'carriage_return_forbidden', 'too_many_lines',
  ];
  return t(`${base}.${known.includes(code) ? code : 'internal'}`, { defaultValue: code });
}


// ── Raw-exec section (enable toggle + enqueue) ───────────────────────────────
//
// Design rules enforced here:
//   • The rawExecEnabled toggle requires a TWO-STEP confirmation (show warning
//     panel → check ack checkbox → press confirm button). A single click is
//     never enough to enable. Disabling is direct (safe).
//   • The enqueue card is only rendered when BOTH enabled AND the caller holds
//     the raw tier. If either condition is false the section explains why.
//   • This tab renders NO command rows and NO execution control of any kind
//     (T-1036). A command that is waiting is shown in one place — the sidebar
//     command board — because two views of one queue is how a command sat unseen
//     for two days (B-247): each list could look settled while the other wasn't.
//   • The rawExecEnabled flag is saved separately from roleModes/disabledActions
//     via the same PUT /api/system/command-board-config endpoint (partial merge).

function RawExecSection({ blockedReasons = [] }: { blockedReasons?: string[] }) {
  const { t } = useTranslation('settings');

  const [rawData, setRawData] = useState<RawData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');

  // Enable toggle inline confirmation state
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [enableAck, setEnableAck] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Add command
  const [addCmd, setAddCmd] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await (authenticatedFetch as (url: string) => Promise<Response>)(RAW_URL);
      if (!res.ok) throw new Error('load');
      const data = (await res.json()) as RawData;
      setRawData(data);
      setLoadState('ok');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Show inline enable confirmation panel (no confirmation needed to disable).
  const handleEnableToggle = (enable: boolean) => {
    if (enable) {
      setShowEnableConfirm(true);
      setEnableAck(false);
      setToggleError(null);
    } else {
      void doToggle(false);
    }
  };

  const doToggle = async (enable: boolean) => {
    setToggling(true);
    setToggleError(null);
    try {
      const res = await (
        authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
      )(CFG_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Partial update — only the flag. roleModes/disabledActions are merged
        // server-side from the current stored config (no accidental clobber).
        body: JSON.stringify({ rawExecEnabled: enable }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(data.code ?? 'save'));
      // Arming/disarming changes the answer the chat code blocks cached (30s TTL).
      // Without this, disarming leaves Execute buttons on screen that the server
      // would refuse — two views of the same permission disagreeing.
      invalidateRawExecConfig();
      setShowEnableConfirm(false);
      setEnableAck(false);
      await load();
    } catch {
      setToggleError(t('commandBoardSettings.saveError', { defaultValue: 'Failed to save' }));
    } finally {
      setToggling(false);
    }
  };

  const handleAdd = async () => {
    const cmd = addCmd;
    if (!cmd.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await (
        authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
      )(RAW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        code?: string;
        position?: number;
      };
      if (!res.ok) {
        setAddError(
          resolveAddError(
            String(data.code ?? 'internal'),
            data.position,
            t as (key: string, opts?: Record<string, unknown>) => string,
          ),
        );
        return;
      }
      setAddCmd('');
      await load();
    } catch {
      setAddError(
        t('commandBoardSettings.rawExec.queue.addError.internal', { defaultValue: 'Internal error' }),
      );
    } finally {
      setAdding(false);
    }
  };

  // Graceful degradation: old server returns 'general', new server returns 'raw'.
  const isRawMode = rawData?.mode === 'raw' || rawData?.mode === 'general';
  const isArmed = rawData?.rawExecEnabled === true;
  // Arming is blocked when the prop carries reasons (from config) OR server toggle fails.
  const isArmingBlocked = blockedReasons.length > 0;
  const atCap = rawData ? rawData.commands.length >= rawData.maxCommands : false;

  return (
    <>
      {/* ── Toggle card — Dangerous tier breaker ───────────────────────────
          §2.6: **البطاقة نفسها هي منطقة الخطر.** كانت خمس طبقات على شاشة واحدة —
          مودال ← بطاقة ← صفّ حالة مؤطَّر ← لوح `border-2 border-destructive/50`
          ← صندوق إقرار مؤطَّر. الآن: مودال ← بطاقة خطر، ولا شيء بعدها؛ صفّ الحالة
          بلا إطار، والإقرار صفٌّ يفصله خطٌّ شعري لا صندوقٌ ثالث. */}
      {/* `p-4` سقط: الحشو صار **داخل** البدائية، فكتابته هنا حشوٌ فوق حشو —
          `p-4` من `SettingsCard` و`p-4` من المستهلك على العنصر نفسه، أحدهما
          يبتلع الآخر بترتيب الملف المولَّد لا بالنيّة. */}
      {/* **الرأس خرج من البطاقة، والبطاقة بقيت وحدها صندوقاً.** كان عنوان
          «الطبقة الخطرة» بمقاس `SettingsCardHeader` (‏`text-base`) بينما جاراه في
          التبويب — «صلاحية الأدوار» و«الأوامر المتاحة» — عنوانا قسمٍ بـ`text-lg`
          وأيقونة، فيقرأ الأخطرُ فيها مرؤوساً لأنداده. صار قسماً كإخوته بنبرة
          `danger` (رفعُ حاجزٍ أمني بنصّ الخريطة) وبلا `boxed`: صندوق النبرة تحته
          هو الحدّ، وصندوقان حول شيءٍ واحد هو الإفراط الذي اعترض عليه المالك. */}
      <SettingsSection
        icon={ShieldAlert}
        tone="danger"
        title={t('commandBoardSettings.rawExec.toggle.title', {
          defaultValue: 'الطبقة الخطرة — تنفيذ أي أمر',
        })}
        description={t('commandBoardSettings.rawExec.toggle.description', {
          defaultValue:
            'تفعيل هذه الطبقة في المصفوفة أعلاه لا يكفي — يجب تسليح المفتاح الرئيسي هنا. إطفاؤه يُسقط «تنفيذ أي أمر» عن كل الأدوار فوراً.',
        })}
      >
      <SettingsCard tone="danger" className="space-y-4">
        {/* التحميل بالنمط الموحَّد. والفشل يبقى نصّاً هنا لا صندوقاً: هو
            **داخل** بطاقة الخطر أصلاً، وصندوقٌ مُنبَّر داخل صندوقٍ مُنبَّر
            يُعيد طبقات الإطار التي أسقطها النظام (§1). */}
        {loadState === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('commandBoardSettings.loading', { defaultValue: 'Loading…' })}
          </div>
        )}

        {loadState === 'error' && (
          <p className="text-[13px] leading-relaxed text-danger" role="alert">
            {t('commandBoardSettings.loadError', { defaultValue: 'Failed to load settings' })}
          </p>
        )}

        {loadState === 'ok' && rawData && (
          <>
            {/* Environment blocker notice — arming is impossible while any blocker holds */}
            {isArmingBlocked && (
              <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                {blockedReasons.map((r) =>
                  t(`commandBoardSettings.rawExec.toggle.blocked_${r}`, {
                    defaultValue:
                      r === 'is_platform'
                        ? 'التسليح غير متاح في وضع المنصة (is_platform) — البيئة تُلغي ضمانة المراجعة البشرية.'
                        : `التسليح محجوب: ${r}`,
                  }),
                ).join(' ')}
              </p>
            )}

            {/* ── Armed / Unarmed toggle row — بلا إطار: البطاقة هي الوحدة ────
                وشارة «يُحفظ فوراً» **في هذا الصفّ** لا في سطرٍ فوقه: كانت وحدها
                على سطرٍ كاملٍ بعرض البطاقة تقول حقيقةً عن الزرّ الذي يبعد عنها
                سطرين. الحالةُ ونموذجُ الحفظ والفعل ثلاثتُها عن الشيء نفسه،
                فتُقرأ في مسحةٍ واحدة لا في ثلاث. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={isArmed ? 'danger' : 'neutral'}>
                  {isArmed
                    ? t('commandBoardSettings.rawExec.toggle.statusEnabled', { defaultValue: 'مسلَّح' })
                    : t('commandBoardSettings.rawExec.toggle.statusDisabled', { defaultValue: 'غير مسلَّح' })}
                </StatusBadge>
                <StatusBadge>{t('commandBoardSettings.savesImmediately')}</StatusBadge>
              </div>
              <div className="flex-shrink-0">
                {isArmed ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="px-2.5 text-[13px] text-danger hover:border-destructive hover:bg-destructive/5"
                    onClick={() => handleEnableToggle(false)}
                    disabled={toggling}
                  >
                    {toggling && (
                      <Loader2 className="me-1 h-3 w-3 animate-spin" aria-hidden="true" />
                    )}
                    {t('commandBoardSettings.rawExec.toggle.disableButton', {
                      defaultValue: 'إطفاء رئيسي (يُسقط الطبقة عن الجميع)',
                    })}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="px-3"
                    onClick={() => handleEnableToggle(true)}
                    disabled={toggling || showEnableConfirm || isArmingBlocked}
                    aria-expanded={showEnableConfirm}
                  >
                    {t('commandBoardSettings.rawExec.toggle.enableButton', { defaultValue: 'تسليح' })}
                  </Button>
                )}
              </div>
            </div>

            {/* ── Inline arm confirmation panel ─────────────────────────────── */}
            {/* Shown after the owner clicks «تسليح». Requires an explicit checkbox.
                A single click on «تسليح» is never sufficient. Disarming is 1-click. */}
            {showEnableConfirm && !isArmed && (
              <div
                className="space-y-3"
                role="region"
                aria-label={t('commandBoardSettings.rawExec.toggle.warningTitle', { defaultValue: 'Security warning' })}
              >
                <div className="flex items-start gap-2.5">
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger"
                    aria-hidden="true"
                  />
                  <div className="space-y-1">
                    <p className="text-[15px] font-semibold leading-relaxed text-danger">
                      {t('commandBoardSettings.rawExec.toggle.warningTitle', {
                        defaultValue: 'Security warning — read before enabling',
                      })}
                    </p>
                    <p className="text-[13px] leading-relaxed text-foreground">
                      {t('commandBoardSettings.rawExec.toggle.warning', {
                        defaultValue:
                          'This feature allows running any shell command on the server with the service user\'s privileges. There is no allowlist — the only safeguard is your personal review of each command before pressing Execute. A single wrong command can corrupt data or take the server down.',
                      })}
                    </p>
                  </div>
                </div>

                {/* Acknowledgment — MUST be checked before confirm button enables.
                    صفٌّ يفصله خطٌّ شعري، لا صندوقٌ مؤطَّر داخل منطقة الخطر (§2.6).

                    والتحكّم `SettingsToggle` لا `input type="checkbox"` خام: كان
                    مربّعَ نظامٍ بـ`accent-primary` على شاشةٍ كلُّ مفاتيحها الأخرى
                    — بما فيها مفاتيح «الأوامر المتاحة» في هذا الملف نفسه —
                    مفاتيحُ بالبدائية. مربّعان بشكلين لفعلٍ واحد يجعل المستخدم
                    يسأل أيّهما يفعل ماذا، وهذا آخر ما يُسأل في شاشةٍ تفتح shell.
                    الحالة والشرط لم يتغيّرا: `enableAck` هو نفسه، وزرّ التأكيد
                    ما زال معطَّلاً حتى يصير `true`. */}
                <div className="flex items-start gap-2.5 border-t border-destructive/20 pt-3">
                  <SettingsToggle
                    checked={enableAck}
                    onChange={setEnableAck}
                    disabled={toggling}
                    ariaLabel={t('commandBoardSettings.rawExec.toggle.ackLabel', {
                      defaultValue:
                        'I understand this grants full shell access to the server and I accept full responsibility',
                    })}
                  />
                  <span className="select-none text-[13px] leading-relaxed text-foreground">
                    {t('commandBoardSettings.rawExec.toggle.ackLabel', {
                      defaultValue:
                        'I understand this grants full shell access to the server and I accept full responsibility',
                    })}
                  </span>
                </div>

                {toggleError && (
                  <p className="text-[13px] leading-relaxed text-danger" role="alert">
                    {toggleError}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="px-3"
                    onClick={() => { setShowEnableConfirm(false); setEnableAck(false); }}
                    disabled={toggling}
                  >
                    {t('commandBoardSettings.rawExec.toggle.cancelEnable', { defaultValue: 'Cancel' })}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="px-3"
                    disabled={!enableAck || toggling}
                    onClick={() => { void doToggle(true); }}
                  >
                    {toggling && (
                      <Loader2 className="me-1 h-3 w-3 animate-spin" aria-hidden="true" />
                    )}
                    {t('commandBoardSettings.rawExec.toggle.confirmEnable', { defaultValue: 'Confirm enabling' })}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </SettingsCard>

      {/* ── Enqueue block (only when armed + owner on raw tier) ─────────────
          T-1036: this block ENQUEUES, it does not hold a waiting list. The queue
          itself lives in the sidebar command board — one place where a command
          waits, one place where it is reviewed, and settings back to being only
          where the board is configured.

          **مرؤوسٌ لا نِدّ.** كان قسماً بمقاس أقسام التبويب (`text-lg` + أيقونة +
          `boxed`)، فيقرأ الخامسَ في صفٍّ من أنداد بينما هو **فرعٌ عن الطبقة
          الخطرة**: لا يظهر أصلاً إلا وهي مسلَّحة، ويختفي بإطفائها. رأسٌ بمقاس
          `SettingsCardHeader` (‏`text-base`) **داخل** قسم الخطر يقول ذلك بالمكان
          والمقاس معاً، ويُسقط صندوقاً كاملاً من الشاشة.
          والعدّاد ونموذجُ الحفظ في الرأس نفسه (`trailing` + `saveMode`) بدل صفّ
          شارتين تحته — وهي البدائية التي وُجدت لهذا بعينه. */}
      {loadState === 'ok' && rawData && isArmed && isRawMode && (
        <div className="space-y-3 ps-7">
          <SettingsCardHeader
            title={t('commandBoardSettings.rawExec.queue.title', { defaultValue: 'Queue a command' })}
            description={t('commandBoardSettings.rawExec.queue.description', {
              defaultValue:
                'A command added here waits in the sidebar command board and is reviewed there. Nothing runs automatically.',
            })}
            /* بلا `saveMode`: بطاقةُ الخطر فوقه — وهي أبوه لا جاره — تحمل
               الشارة نفسها على بعد سطرين. «يُحفظ فوراً» مرّتين في مسحةٍ واحدة
               لا تضيف يقيناً، تضيف ضجيجاً. */
            trailing={
              <StatusBadge>
                {t('commandBoardSettings.rawExec.queue.counter', {
                  count: rawData.commands.length,
                  max: rawData.maxCommands,
                  defaultValue: `${rawData.commands.length} / ${rawData.maxCommands} commands`,
                })}
              </StatusBadge>
            }
          />

          {/* Add command — الحقل والإجراء بصياغة واحدة (§2.7): `dir=ltr` +
              عزل bidi على القيمة التقنية، وحدّ الحقل خارج ميزانية الإطارات. */}
          <FieldWithAction
            id="raw-exec-enqueue"
            technical
            label={t('commandBoardSettings.rawExec.queue.addLabel', { defaultValue: 'الأمر' })}
            value={addCmd}
            onChange={(value) => { setAddCmd(value); setAddError(null); }}
            onSubmit={() => { void handleAdd(); }}
            placeholder={t('commandBoardSettings.rawExec.queue.addPlaceholder', { defaultValue: 'ls -la /tmp' })}
            disabled={adding || atCap}
            actionLabel={t('commandBoardSettings.rawExec.queue.addButton', { defaultValue: 'Add' })}
            error={addError}
          />

          {/* Where the command went.
              No rows, no review dialog, no dismiss button here: a command that
              is waiting is shown in ONE place, and this is not it. Keeping a
              second list would recreate exactly the split that hid a command
              for two days (B-247) — two views of one queue, each able to look
              empty while the other is not. */}
          <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
            <Inbox className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {rawData.commands.length > 0
              ? t('commandBoardSettings.rawExec.queue.waitingElsewhere', {
                  count: rawData.commands.length,
                  defaultValue: `${rawData.commands.length} command(s) waiting in the sidebar command board.`,
                })
              : t('commandBoardSettings.rawExec.queue.reviewedElsewhere', {
                  defaultValue: 'Queued commands appear in the sidebar command board, where they are reviewed and run.',
                })}
          </p>
        </div>
      )}
      </SettingsSection>
    </>
  );
}

export default function CommandBoardSettingsTab() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();

  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [actions, setActions] = useState<CatalogAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [roleModes, setRoleModes] = useState<Record<string, RoleMode>>({});
  const [disabledActions, setDisabledActions] = useState<string[]>([]);
  const [customCount, setCustomCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await (
        authenticatedFetch as (url: string) => Promise<Response>
      )(CFG_URL);
      if (!res.ok) throw new Error('load');
      const data = (await res.json()) as { config: Record<string, unknown>; actions: CatalogAction[] };
      const rawCfg = (data.config ?? {}) as Record<string, unknown>;
      // Normalize role modes: 'general' (old server vocab) → 'custom'; unknown → 'none'.
      // Graceful degradation: missing maxAssignableTier/rawExecEnabled/rawExecBlockedReasons
      // fall back to safe defaults so the UI doesn't crash on old server contract.
      const rawStoredModes = (rawCfg.roleModes as Record<string, unknown> | undefined) ?? {};
      const normalizedRoleModes: Record<string, RoleMode> = {};
      for (const r of ['owner', 'admin', 'user']) {
        normalizedRoleModes[r] = normalizeMode(rawStoredModes[r]);
      }
      const normalizedConfig: BoardConfig = {
        roleModes: normalizedRoleModes,
        disabledActions: Array.isArray(rawCfg.disabledActions)
          ? (rawCfg.disabledActions as string[])
          : [],
        maxAssignableTier:
          (rawCfg.maxAssignableTier as Record<string, string> | undefined) ??
          DEFAULT_MAX_ASSIGNABLE_TIER,
        rawExecEnabled: rawCfg.rawExecEnabled === true,
        rawExecBlockedReasons: Array.isArray(rawCfg.rawExecBlockedReasons)
          ? (rawCfg.rawExecBlockedReasons as string[])
          : [],
      };
      setConfig(normalizedConfig);
      setActions((data.actions as CatalogAction[] | undefined) ?? []);
      setRoleModes({ ...normalizedConfig.roleModes });
      setDisabledActions([...normalizedConfig.disabledActions]);
    } catch {
      setFeedback({
        kind: 'error',
        message: t('commandBoardSettings.loadError', { defaultValue: 'تعذّر تحميل الإعدادات' }),
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!config) return false;
    const modesChanged = MANAGED_ROLES.some(
      ({ role }) => (roleModes[role] ?? 'none') !== (config.roleModes[role] ?? 'none'),
    );
    const disabledChanged =
      disabledActions.length !== config.disabledActions.length ||
      disabledActions.some((a) => !config.disabledActions.includes(a));
    return modesChanged || disabledChanged;
  }, [config, roleModes, disabledActions]);

  const setRole = useCallback((role: string, mode: RoleMode) => {
    setRoleModes((prev) => ({ ...prev, [role]: mode }));
    setFeedback(null);
  }, []);

  // الطبقات الأربع مرتّبةً تراكمياً. اللصيقة القصيرة هي رأس العمود (تعمل على
  // 375px بلا تمرير أفقي)، والاسم الكامل يعيش في `aria-label` و`title` والشرح.
  const TIERS = useMemo<TierMatrixTier<RoleMode>[]>(
    () => [
      {
        value: 'none',
        shortLabel: t('commandBoardSettings.modesShort.none', { defaultValue: 'معطّل' }),
        label: t('commandBoardSettings.modes.none', { defaultValue: 'معطّل' }),
      },
      {
        value: 'safe',
        shortLabel: t('commandBoardSettings.modesShort.safe', { defaultValue: 'آمنة' }),
        label: t('commandBoardSettings.modes.safe', { defaultValue: 'القائمة الآمنة' }),
      },
      {
        value: 'custom',
        shortLabel: t('commandBoardSettings.modesShort.custom', { defaultValue: 'مخصّصة' }),
        label: t('commandBoardSettings.modes.custom', { defaultValue: 'الأوامر المخصّصة' }),
      },
      {
        value: 'raw',
        shortLabel: t('commandBoardSettings.modesShort.raw', { defaultValue: 'أي أمر' }),
        label: t('commandBoardSettings.modes.raw', { defaultValue: 'تنفيذ أي أمر' }),
        danger: true,
      },
    ],
    [t],
  );

  // نفس `roleModes[role] ?? 'none'` السابق: دورٌ بلا قيمة مخزَّنة يُقرأ «معطّلاً»
  // لا صفّاً بلا اختيار — وهي حالة مسار الفشل قبل أن يصل ردّ الخادم.
  const matrixValue = useMemo(
    () =>
      Object.fromEntries(
        MANAGED_ROLES.map(({ role }) => [role, roleModes[role] ?? 'none']),
      ) as Record<string, RoleMode>,
    [roleModes],
  );

  const matrixRows = useMemo(
    () =>
      MANAGED_ROLES.map(({ role }) => ({
        key: role,
        label: t(`commandBoardSettings.roleNames.${role}`, { defaultValue: role }) as string,
      })),
    [t],
  );

  // نفس شروط المنع الأربعة السابقة حرفياً، وقد صار لكلٍّ منها سببٌ يُقرأ في
  // `title` بدل زرٍّ باهتٍ بلا تفسير.
  const blockedReason = useCallback(
    (role: string, tier: RoleMode): string | null => {
      const editable = MANAGED_ROLES.find((r) => r.role === role)?.editable ?? false;
      if (!editable) {
        return t('commandBoardSettings.roles.laterPhase', {
          defaultValue: 'يتوفّر في مرحلة لاحقة',
        }) as string;
      }
      // 'none' blocked for owner (server floor = safe).
      if (role === 'owner' && tier === 'none') {
        return t('commandBoardSettings.roles.ownerNoneDisabled', {
          defaultValue: 'لا يمكن للمالك تعطيل نفسه',
        }) as string;
      }
      // 'raw' blocked when the server's maxAssignableTier for the role is lower.
      const maxTier =
        config?.maxAssignableTier?.[role] ?? DEFAULT_MAX_ASSIGNABLE_TIER[role] ?? 'custom';
      if (tier === 'raw' && maxTier !== 'raw') {
        return t('commandBoardSettings.modes.rawDangerHint', {
          defaultValue: 'الطبقة الخطرة متاحة للمالك فقط',
        }) as string;
      }
      if (isSaving) {
        return t('commandBoardSettings.saving', { defaultValue: 'جارٍ الحفظ…' }) as string;
      }
      return null;
    },
    [config, isSaving, t],
  );

  const toggleAction = useCallback((actionType: string) => {
    setDisabledActions((prev) =>
      prev.includes(actionType) ? prev.filter((a) => a !== actionType) : [...prev, actionType],
    );
    setFeedback(null);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const res = await (
        authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
      )(CFG_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleModes, disabledActions }),
      });
      const data = (await res.json().catch(() => ({}))) as { config?: Record<string, unknown>; code?: string };
      if (!res.ok || !data.config) throw new Error(data.code ?? 'save');
      const savedCfg = data.config;
      const savedModes = (savedCfg.roleModes as Record<string, unknown> | undefined) ?? {};
      const normalizedSaved: BoardConfig = {
        roleModes: Object.fromEntries(
          ['owner', 'admin', 'user'].map((r) => [r, normalizeMode(savedModes[r])]),
        ) as Record<string, RoleMode>,
        disabledActions: Array.isArray(savedCfg.disabledActions)
          ? (savedCfg.disabledActions as string[])
          : [],
        maxAssignableTier:
          (savedCfg.maxAssignableTier as Record<string, string> | undefined) ??
          DEFAULT_MAX_ASSIGNABLE_TIER,
        rawExecEnabled: savedCfg.rawExecEnabled === true,
        rawExecBlockedReasons: Array.isArray(savedCfg.rawExecBlockedReasons)
          ? (savedCfg.rawExecBlockedReasons as string[])
          : [],
      };
      // A tier change (e.g. dropping the owner from raw) must reach the chat code
      // blocks immediately, not after the 30s cache TTL.
      invalidateRawExecConfig();
      setConfig(normalizedSaved);
      setRoleModes({ ...normalizedSaved.roleModes });
      setDisabledActions([...normalizedSaved.disabledActions]);
      setFeedback({
        kind: 'success',
        message: t('commandBoardSettings.saved', { defaultValue: 'حُفِظت الإعدادات' }),
      });
    } catch {
      setFeedback({
        kind: 'error',
        message: t('commandBoardSettings.saveError', { defaultValue: 'تعذّر الحفظ' }),
      });
    } finally {
      setIsSaving(false);
    }
  }, [roleModes, disabledActions, t]);

  // All hooks are declared above; owner-gate return is safe here.
  if (user?.role !== 'owner') return null;

  return (
    <SettingsSection
      // عنوان التبويب فوق عناوين أقسامه: «لوحة الأوامر» و«صلاحية الأدوار» كانا
      // بنفس الحجم والوزن على بعد ستين بكسلاً، فلا شيء يقول أيّهما يحتوي الآخر.
      level="page"
      icon={Terminal}
      tone="info"
      title={t('commandBoardSettings.title', { defaultValue: 'لوحة الأوامر' })}
      description={t('commandBoardSettings.description', {
        defaultValue:
          'تحكّم بمن يستطيع تشغيل أوامر «لوحة الأوامر» وأيّ الأوامر مفعّلة. التنفيذ يتمّ بهوية مالك السيرفر.',
      })}
    >
      {/* التحميل بالنمط الموحَّد. و`p-4` سقط: حشوٌ أفقي على صفٍّ داخل منطقة
          المحتوى يزيحه عن محاذاة عنوان القسم فوقه (§2.3 يمنع الأفقي على
          الصفوف). */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('commandBoardSettings.loading', { defaultValue: 'جارٍ التحميل…' })}
        </div>
      ) : (
        /* `space-y-8` بين الأقسام لا `space-y-4`: الفصل مسافةٌ لا خطّ، فإن ضاقت
           المسافة إلى نصفها عاد القسمُ يلتصق بجاره ولم يبقَ ما يفصلهما. */
        <div className="space-y-8">
          {/* Role access */}
          <SettingsSection
            boxed
            icon={Users}
            title={t('commandBoardSettings.roles.title', { defaultValue: 'صلاحية الأدوار' })}
            description={t('commandBoardSettings.roles.description', {
              defaultValue: 'من يستطيع تشغيل أوامر القائمة الآمنة. المالك دائماً مفعّل.',
            })}
          >
            <div className="space-y-3 py-2">
            {/* صفٌّ لكل دور، وفي طرفه منتقٍ **نصّه ظاهر داخله**. الشبكة السابقة
                وضعت الأسماء في رؤوس أعمدة وتركت الخلايا فارغة، فخرجت على الشاشة
                اثني عشر مربّعاً صامتاً — لا خيارَ يُعرَف بموضعه (§2.4). */}
            <SettingsGroup>
              {matrixRows.map((row) => (
                <SettingsRow
                  key={row.key}
                  label={row.label}
                  className="gap-3"
                >
                  <SegmentedControl
                    label={row.label}
                    value={matrixValue[row.key]}
                    onChange={(tier) => setRole(row.key, tier)}
                    options={TIERS.map((tier) => ({
                      value: tier.value,
                      label: tier.shortLabel,
                      danger: tier.danger,
                      blockedReason: blockedReason(row.key, tier.value),
                    }))}
                  />
                </SettingsRow>
              ))}
            </SettingsGroup>

            {/* Unarmed note: owner has 'raw' tier but main switch is off → tier is inactive */}
            {/* «اخترتَ طبقةً لا تسري» تنبيهٌ لا يمنع — صندوق `warning` لا نصّاً
                ملوّناً عارياً. هذا هو الفارق الذي جعل الأصل مقروءاً: منطقةٌ
                ليست كبقيّتها تُؤطَّر، وما عداها عارٍ. */}
            {roleModes['owner'] === 'raw' && !(config?.rawExecEnabled) && (
              <SettingsCard tone="warning">
                <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                  <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  {t('commandBoardSettings.modes.rawUnarmedNote', {
                    defaultValue:
                      'الطبقة الخطرة غير مسلَّحة — اختيارها هنا لا يسري حتى تُسلَّح من القسم أدناه',
                  })}
                </p>
              </SettingsCard>
            )}

            {/* Hint: custom tier set but no custom commands defined yet.
                يبقى خارج الطيّ: تحذيرٌ مشروطٌ بحالة قائمة لا يجوز أن يختفي خلف طيّ. */}
            {customCount === 0 && Object.values(roleModes).some((m) => m === 'custom') && (
              <SettingsCard tone="warning">
                <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  {t('commandBoardSettings.roles.customHint', {
                    defaultValue:
                      '«الأوامر المخصّصة» لا يُضيف أثراً فعلياً ما لم تُعرِّف أوامر مخصّصة في قسم «الأوامر المخصّصة» أدناه.',
                  })}
                </p>
              </SettingsCard>
            )}

            {/* Mode legend: one line per tier (تراكمي — كلٌّ يشمل ما قبله).
                يبقى الشرح مطويّاً واختيارياً: التراكم صار مرئياً بالتعبئة في
                المصفوفة، فلم يعد النصّ هو ما يحمله.
                و«اختر طبقةً من الأربع أعلاه» انضمّ إليه: كان سطراً عائماً تحت
                المصفوفة يقول ما تقوله المصفوفةُ نفسها (أربعة أزرار، واحدٌ منها
                مختار) وما يقوله وصفُ القسم فوقها («المالك دائماً مفعّل») —
                شرحٌ ثالث لمعلومةٍ مرئية. موضعه الطبيعي مع بقيّة الشرح. */}
            <SettingsCollapsible
              summary={t('commandBoardSettings.roles.legendHint', {
                defaultValue: 'الطبقات تراكمية — كلٌّ منها يشمل ما قبلها',
              })}
            >
              <p>
                {t('commandBoardSettings.roles.ownerSelectableHint', {
                  defaultValue: 'اختر طبقةً من الأربع أعلاه — تعطيل الوصول الذاتي غير مسموح',
                })}
              </p>
              <dl className="space-y-1.5">
                {TIERS.map((tier) => (
                  <div key={tier.value}>
                    <dt
                      className={cn(
                        'inline font-medium',
                        tier.danger ? 'text-danger' : 'text-foreground',
                      )}
                    >
                      {tier.label}
                    </dt>
                    <dd className="inline">
                      {' — '}
                      {t(`commandBoardSettings.modes.${tier.value}Desc`, {
                        defaultValue:
                          tier.value === 'raw'
                            ? 'جميع الطبقات أعلاه + تنفيذ أي نصّ shell حرّ. للمالك فقط. يستلزم تسليح المفتاح الرئيسي.'
                            : tier.value === 'custom'
                              ? 'القائمة الآمنة + الأوامر المخصّصة التي عرّفتَها (محصورة بتنفيذيات مجمّدة بالكود، لا تنفيذ نصّ حرّ).'
                              : tier.value === 'safe'
                                ? 'تشغيل أوامر القائمة الآمنة المدرجة مع التطبيق فقط.'
                                : 'لا وصول للوحة الأوامر لهذا الدور.',
                      })}
                    </dd>
                  </div>
                ))}
              </dl>
            </SettingsCollapsible>
            </div>
          </SettingsSection>

          {/* 2. الطبقة الخطرة — ADR-072 (immediately after matrix per spec order) */}
          <RawExecSection blockedReasons={config?.rawExecBlockedReasons ?? []} />

          {/* 3. القائمة الآمنة — Safe list actions enable/disable */}
          {/* قائمة متجانسة: قسمٌ فبدائيّة صفوف. كانت تُبنى يدوياً داخل
              `SettingsCard divided` — وتلك الخاصيّة لم تكن تُرسم أصلاً (‏B-398)،
              فالفواصل الموعودة لم توجد يوماً، وبقي `px-4` حشواً أفقياً يحظره §2.3. */}
          {/* `boxed` بلا لوحٍ داخلي: محتواه قائمة صفوف واحدة، وحشو `SettingsRow`
              يكفيها — لا أبناء متجاورين تحتاج فجوةً بينهم. */}
          <SettingsSection
            boxed
            icon={ListChecks}
            title={t('commandBoardSettings.actions.title', { defaultValue: 'الأوامر المتاحة' })}
            description={t('commandBoardSettings.actions.description', {
              defaultValue: 'فعّل أو عطّل كل أمر في القائمة الآمنة.',
            })}
          >
            {actions.length === 0 ? (
              <p className="py-6 text-center text-[13px] leading-relaxed text-muted-foreground">
                {t('commandBoardSettings.actions.empty', { defaultValue: 'لا أوامر.' })}
              </p>
            ) : (
              <SettingsGroup>
                {actions.map((action) => (
                  <SettingsRow
                    key={action.actionType}
                    label={
                      <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
                        {action.actionType}
                      </span>
                    }
                    description={
                      action.commandPreview ? (
                        <span
                          className="block truncate font-mono"
                          dir="ltr"
                          style={{ unicodeBidi: 'isolate' }}
                        >
                          {action.commandPreview}
                        </span>
                      ) : undefined
                    }
                  >
                    <SettingsToggle
                      checked={!disabledActions.includes(action.actionType)}
                      onChange={() => toggleAction(action.actionType)}
                      ariaLabel={action.actionType}
                      disabled={isSaving}
                    />
                  </SettingsRow>
                ))}
              </SettingsGroup>
            )}
          </SettingsSection>

          {/* 4. الأوامر المخصّصة — Custom commands (T-948 Phase 2) */}
          <CustomCommandsSection onCountChange={setCustomCount} />

          {/* ── شريط الحفظ ─────────────────────────────────────────────────────
              كان زرّاً حرّاً في منتصف الصفحة، يليه قسمٌ يحفظ فوراً بلا زرّ — فيقرأ
              كأنه يحفظ ما تحته أيضاً. وهو في الحقيقة لا يحفظ إلا بطاقتين:
              «صلاحية الأدوار» و«الأوامر المتاحة». صار الآن شريطاً لاصقاً بأسفل
              المحتوى يقول نطاقه نصّاً، ويلتصق ما دام قسمه على الشاشة ثم يزول عند
              مغادرته — فتُقرأ حدوده بالمكان لا بالتخمين. */}
          {/* خلفية معتمة لا شبه‑شفافة: صنفان بنفس الخاصية (`bg-*` عاديّ +
              `supports-[]:bg-*`) يتنازعان بترتيب الملف المولَّد لا بالنيّة. */}
          <div className="sticky bottom-0 z-10 -mx-4 mt-1 border-t border-border bg-background px-4 py-3 md:-mx-6 md:px-6">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p
                role="status"
                className={cn(
                  'min-w-0 text-[13px] leading-relaxed',
                  feedback?.kind === 'error'
                    ? 'text-danger'
                    : feedback?.kind === 'success'
                      ? 'text-success'
                      : 'text-muted-foreground',
                )}
              >
                {feedback
                  ? feedback.message
                  : dirty
                    ? t('commandBoardSettings.saveScopeDirty', {
                        defaultValue: 'تغييرات غير محفوظة في «صلاحية الأدوار» و«الأوامر المتاحة»',
                      })
                    : t('commandBoardSettings.saveScope', {
                        defaultValue: 'يحفظ «صلاحية الأدوار» و«الأوامر المتاحة» فقط',
                      })}
              </p>
              <Button
                type="button"
                size="sm"
                className="flex-shrink-0"
                onClick={handleSave}
                disabled={!dirty || isSaving}
              >
                {isSaving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
                {isSaving
                  ? t('commandBoardSettings.saving', { defaultValue: 'جارٍ الحفظ…' })
                  : t('commandBoardSettings.save', { defaultValue: 'حفظ' })}
              </Button>
            </div>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
