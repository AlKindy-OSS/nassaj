import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Inbox, Lock, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { useAuth } from '../../../auth';
import { authenticatedFetch } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
// Type only: the review dialog itself is mounted by the sidebar command board,
// which is now the single place a queued command is shown and run (T-1036).
import type { RawCommand } from '../../../command-board/ExecReviewDialog';
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
    <SettingsCard className="space-y-4 p-4">
      {/* Section header + counter + Add button */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t('commandBoardSettings.customCommands.title')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('commandBoardSettings.customCommands.description')}
          </p>
          {/* Allowlist safety note */}
          <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
            {t('commandBoardSettings.customCommands.allowlistNote')}
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          <span className="text-[11px] text-muted-foreground">
            {t('commandBoardSettings.customCommands.counter', {
              count: commands.length,
              max: serverMax,
            })}
          </span>
          {!showForm && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={atCap || loading}
              onClick={openAdd}
              className="h-7 gap-1 px-2.5 text-xs"
              aria-label={t('commandBoardSettings.customCommands.addCommand')}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('commandBoardSettings.customCommands.addCommand')}
            </Button>
          )}
        </div>
      </div>

      {/* Section feedback */}
      {feedback && !showForm && (
        <p
          role="status"
          className={cn(
            'text-xs',
            feedback.kind === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
          )}
        >
          {feedback.message}
        </p>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t('commandBoardSettings.loading')}
        </div>
      )}

      {/* Command list */}
      {!loading && (
        <div className="space-y-2">
          {commands.length === 0 && !showForm && (
            <p className="text-xs text-muted-foreground">
              {t('commandBoardSettings.customCommands.empty')}
            </p>
          )}

          {commands.map(cmd => (
            <div
              key={cmd.key}
              className={cn(
                'flex items-start gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2',
                !cmd.valid && 'border-destructive/40 bg-destructive/5',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Key (always LTR) */}
                  <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                    {cmd.key}
                  </span>
                  {/* minRole badge */}
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {cmd.minRole}
                  </span>
                  {/* Invalid badge */}
                  {!cmd.valid && (
                    <span className="text-[10px] font-medium text-destructive">
                      {t('commandBoardSettings.customCommands.invalidRow')}
                    </span>
                  )}
                </div>
                {/* Label */}
                <p className="mt-0.5 text-sm font-medium text-foreground">{cmd.label}</p>
                {/* Preview */}
                {cmd.commandPreview && (
                  <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">
                    {cmd.commandPreview}
                  </p>
                )}
                {/* Invalid reason */}
                {!cmd.valid && cmd.error && (
                  <p className="mt-0.5 text-[11px] text-destructive">
                    {t('commandBoardSettings.customCommands.invalidRowReason', {
                      error: resolveMsg(cmd.error),
                    })}
                  </p>
                )}
              </div>

              {/* Delete confirm inline */}
              {confirmDeleteKey === cmd.key ? (
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('commandBoardSettings.customCommands.deleteConfirm', { key: cmd.key })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => void handleDelete(cmd.key)}
                  >
                    {t('commandBoardSettings.customCommands.deleteConfirmYes')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setConfirmDeleteKey(null)}
                  >
                    {t('commandBoardSettings.customCommands.deleteConfirmNo')}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={`${t('commandBoardSettings.customCommands.form.editTitle')} ${cmd.key}`}
                    onClick={() => openEdit(cmd)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('commandBoardSettings.customCommands.deleteConfirmYes')} ${cmd.key}`}
                    onClick={() => setConfirmDeleteKey(cmd.key)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div className="mt-2 rounded-lg border border-border bg-muted/10 p-4">
          <p className="mb-3 text-sm font-medium text-foreground">
            {editingKey
              ? t('commandBoardSettings.customCommands.form.editTitle')
              : t('commandBoardSettings.customCommands.form.title')}
          </p>

          <div className="space-y-3">
            {/* Key field (immutable when editing) */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('commandBoardSettings.customCommands.form.key')}
              </label>
              <input
                type="text"
                value={form.key}
                disabled={editingKey !== null}
                onChange={e => setForm(prev => ({ ...prev, key: e.target.value }))}
                placeholder="my-command"
                dir="ltr"
                className={cn(
                  'w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground',
                  'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring',
                  editingKey !== null && 'cursor-not-allowed opacity-60',
                )}
              />
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t('commandBoardSettings.customCommands.form.keyHint')}
              </p>
            </div>

            {/* Label field */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('commandBoardSettings.customCommands.form.label')}
              </label>
              <input
                type="text"
                value={form.label}
                onChange={e => setForm(prev => ({ ...prev, label: e.target.value }))}
                placeholder={t('commandBoardSettings.customCommands.form.labelHint')}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* cmd field */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('commandBoardSettings.customCommands.form.cmd')}
              </label>
              <input
                type="text"
                value={form.cmd}
                onChange={e => setForm(prev => ({ ...prev, cmd: e.target.value }))}
                placeholder="npm"
                dir="ltr"
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                {t('commandBoardSettings.customCommands.form.cmdHint')}
              </p>
            </div>

            {/* args fields (dynamic list) */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('commandBoardSettings.customCommands.form.args')}
              </label>
              <p className="mb-1.5 text-[11px] text-muted-foreground">
                {t('commandBoardSettings.customCommands.form.argsHint')}
              </p>
              <div className="space-y-1.5">
                {form.args.map((arg, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={arg}
                      onChange={e => updateArg(idx, e.target.value)}
                      placeholder={`arg ${idx + 1}`}
                      dir="ltr"
                      className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      type="button"
                      onClick={() => removeArg(idx)}
                      aria-label={t('commandBoardSettings.customCommands.form.removeArg')}
                      className="flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              {form.args.length < 8 && (
                <button
                  type="button"
                  onClick={addArg}
                  className="mt-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t('commandBoardSettings.customCommands.form.addArg')}
                </button>
              )}
            </div>

            {/* minRole select */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('commandBoardSettings.customCommands.form.minRole')}
              </label>
              <select
                value={form.minRole}
                onChange={e => setForm(prev => ({ ...prev, minRole: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {VALID_ROLES.map(role => (
                  <option key={role} value={role}>
                    {t(`commandBoardSettings.roleNames.${role}`, { defaultValue: role }) as string}
                  </option>
                ))}
              </select>
            </div>

            {/* Form-level error from server */}
            {formError && (
              <p className="flex items-center gap-1 text-xs text-destructive" role="alert">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
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
                className="h-7 px-3 text-xs"
              >
                {t('commandBoardSettings.customCommands.form.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSaveForm()}
                disabled={formSaving}
                className="h-7 px-3 text-xs"
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
    </SettingsCard>
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
  if (code.startsWith('denied_command:')) {
    return t(`${base}.denied_command`, {
      rule: code.slice('denied_command:'.length),
      defaultValue: 'This command is blocked because it disrupts a live service. Run it in your own terminal.',
    });
  }
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
      {/* ── Toggle card — Dangerous tier breaker ─────────────────────────── */}
      <SettingsCard className="space-y-4 p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {t('commandBoardSettings.rawExec.toggle.title', {
              defaultValue: 'الطبقة الخطرة — تنفيذ أي أمر',
            })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('commandBoardSettings.rawExec.toggle.description', {
              defaultValue:
                'تفعيل هذه الطبقة في المصفوفة أعلاه لا يكفي — يجب تسليح المفتاح الرئيسي هنا. إطفاؤه يُسقط «تنفيذ أي أمر» عن كل الأدوار فوراً.',
            })}
          </p>
        </div>

        {loadState === 'loading' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t('commandBoardSettings.loading', { defaultValue: 'Loading…' })}
          </div>
        )}

        {loadState === 'error' && (
          <p className="text-sm text-destructive">
            {t('commandBoardSettings.loadError', { defaultValue: 'Failed to load settings' })}
          </p>
        )}

        {loadState === 'ok' && rawData && (
          <>
            {/* Environment blocker notice — arming is impossible while any blocker holds */}
            {isArmingBlocked && (
              <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
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

            {/* ── Armed / Unarmed toggle row ─────────────────────────────── */}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  isArmed
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {isArmed
                  ? t('commandBoardSettings.rawExec.toggle.statusEnabled', { defaultValue: 'مسلَّح' })
                  : t('commandBoardSettings.rawExec.toggle.statusDisabled', { defaultValue: 'غير مسلَّح' })}
              </span>
              <div className="flex-shrink-0">
                {isArmed ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs text-destructive hover:border-destructive hover:bg-destructive/5"
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
                    className="h-7 px-2.5 text-xs"
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
                className="space-y-3 rounded-lg border-2 border-destructive/50 bg-destructive/5 p-4"
                role="region"
                aria-label={t('commandBoardSettings.rawExec.toggle.warningTitle', { defaultValue: 'Security warning' })}
              >
                <div className="flex items-start gap-2.5">
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive"
                    aria-hidden="true"
                  />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-destructive">
                      {t('commandBoardSettings.rawExec.toggle.warningTitle', {
                        defaultValue: 'Security warning — read before enabling',
                      })}
                    </p>
                    <p className="text-sm leading-relaxed text-foreground">
                      {t('commandBoardSettings.rawExec.toggle.warning', {
                        defaultValue:
                          'This feature allows running any shell command on the server with the service user\'s privileges. There is no allowlist — the only safeguard is your personal review of each command before pressing Execute. A single wrong command can corrupt data or take the server down.',
                      })}
                    </p>
                  </div>
                </div>

                {/* Acknowledgment — MUST be checked before confirm button enables */}
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-destructive/30 bg-background/50 p-3 transition-colors hover:bg-background/80">
                  <input
                    type="checkbox"
                    checked={enableAck}
                    onChange={(e) => setEnableAck(e.target.checked)}
                    disabled={toggling}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 accent-primary"
                  />
                  <span className="select-none text-sm text-foreground">
                    {t('commandBoardSettings.rawExec.toggle.ackLabel', {
                      defaultValue:
                        'I understand this grants full shell access to the server and I accept full responsibility',
                    })}
                  </span>
                </label>

                {toggleError && (
                  <p className="text-xs text-destructive" role="alert">
                    {toggleError}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => { setShowEnableConfirm(false); setEnableAck(false); }}
                    disabled={toggling}
                  >
                    {t('commandBoardSettings.rawExec.toggle.cancelEnable', { defaultValue: 'Cancel' })}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
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

      {/* ── Enqueue card (only when armed + owner on raw tier) ─────────────
          T-1036: this card ENQUEUES, it does not hold a waiting list. The queue
          itself lives in the sidebar command board — one place where a command
          waits, one place where it is reviewed, and settings back to being only
          where the board is configured. */}
      {loadState === 'ok' && rawData && isArmed && isRawMode && (
        <SettingsCard className="space-y-4 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('commandBoardSettings.rawExec.queue.title', { defaultValue: 'Queue a command' })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('commandBoardSettings.rawExec.queue.description', {
                  defaultValue:
                    'A command added here waits in the sidebar command board and is reviewed there. Nothing runs automatically.',
                })}
              </p>
            </div>
            <span className="flex-shrink-0 text-[11px] text-muted-foreground">
              {t('commandBoardSettings.rawExec.queue.counter', {
                count: rawData.commands.length,
                max: rawData.maxCommands,
                defaultValue: `${rawData.commands.length} / ${rawData.maxCommands} commands`,
              })}
            </span>
          </div>

          {/* Add command — dir=ltr + bidi-isolate on the input field */}
          <div className="flex items-start gap-2">
            <input
              type="text"
              value={addCmd}
              onChange={(e) => { setAddCmd(e.target.value); setAddError(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !adding && !atCap) void handleAdd();
              }}
              placeholder={t('commandBoardSettings.rawExec.queue.addPlaceholder', { defaultValue: 'ls -la /tmp' })}
              disabled={adding || atCap}
              dir="ltr"
              style={{ unicodeBidi: 'isolate' }}
              className={cn(
                'min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5',
                'font-mono text-sm text-foreground',
                'placeholder:text-muted-foreground',
                'focus:outline-none focus:ring-1 focus:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
              aria-label={t('commandBoardSettings.rawExec.queue.addPlaceholder', { defaultValue: 'Command to add' })}
            />
            <Button
              type="button"
              size="sm"
              disabled={adding || atCap || !addCmd.trim()}
              onClick={() => { void handleAdd(); }}
              className="h-9 flex-shrink-0 px-3 text-sm"
            >
              {adding && <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('commandBoardSettings.rawExec.queue.addButton', { defaultValue: 'Add' })}
            </Button>
          </div>

          {addError && (
            <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              {addError}
            </p>
          )}

          {/* Where the command went.
              No rows, no review dialog, no dismiss button here: a command that
              is waiting is shown in ONE place, and this is not it. Keeping a
              second list would recreate exactly the split that hid a command
              for two days (B-247) — two views of one queue, each able to look
              empty while the other is not. */}
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
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
        </SettingsCard>
      )}
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
      title={t('commandBoardSettings.title', { defaultValue: 'لوحة الأوامر' })}
      description={t('commandBoardSettings.description', {
        defaultValue:
          'تحكّم بمن يستطيع تشغيل أوامر «لوحة الأوامر» وأيّ الأوامر مفعّلة. التنفيذ يتمّ بهوية مالك السيرفر.',
      })}
    >
      {loading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('commandBoardSettings.loading', { defaultValue: 'جارٍ التحميل…' })}
        </div>
      ) : (
        <div className="space-y-5">
          {/* Role access */}
          <SettingsCard className="space-y-4 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('commandBoardSettings.roles.title', { defaultValue: 'صلاحية الأدوار' })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('commandBoardSettings.roles.description', {
                  defaultValue: 'من يستطيع تشغيل أوامر القائمة الآمنة. المالك دائماً مفعّل.',
                })}
              </p>
            </div>

            <div className="space-y-2.5">
              {MANAGED_ROLES.map(({ role, editable }) => {
                const mode = roleModes[role] ?? 'none';
                return (
                  <div
                    key={role}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {t(`commandBoardSettings.roleNames.${role}`, { defaultValue: role })}
                      </p>
                      {role === 'owner' ? (
                        <p className="text-xs text-muted-foreground">
                          {t('commandBoardSettings.roles.ownerSelectableHint', {
                            defaultValue:
                              'اختر طبقةً من الأربع أعلاه — تعطيل الوصول الذاتي غير مسموح',
                          })}
                        </p>
                      ) : null}
                    </div>

                    {/* 4-tier ordered picker: معطّل · القائمة الآمنة · الأوامر المخصّصة · تنفيذ أي أمر */}
                    <div className="flex flex-shrink-0 items-center gap-1 rounded-md border border-border p-0.5">
                      {(['none', 'safe', 'custom', 'raw'] as const).map((opt) => {
                        const active = mode === opt;
                        const maxTier =
                          config?.maxAssignableTier?.[role] ??
                          DEFAULT_MAX_ASSIGNABLE_TIER[role] ??
                          'custom';
                        // 'none' blocked for owner (server floor = safe).
                        // 'raw' blocked for non-owners (maxAssignableTier = custom).
                        const isOwnerNoneBlocked = role === 'owner' && opt === 'none';
                        const isRawBlockedForRole =
                          opt === 'raw' && maxTier !== 'raw';
                        const btnDisabled =
                          !editable || isSaving || isOwnerNoneBlocked || isRawBlockedForRole;
                        return (
                          <button
                            key={opt}
                            type="button"
                            disabled={btnDisabled}
                            onClick={() => setRole(role, opt as RoleMode)}
                            title={
                              isOwnerNoneBlocked
                                ? t('commandBoardSettings.roles.ownerNoneDisabled', {
                                    defaultValue: 'لا يمكن للمالك تعطيل نفسه',
                                  })
                                : isRawBlockedForRole
                                  ? t('commandBoardSettings.modes.rawDangerHint', {
                                      defaultValue: 'الطبقة الخطرة متاحة للمالك فقط',
                                    })
                                  : undefined
                            }
                            aria-disabled={btnDisabled || undefined}
                            className={cn(
                              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                              active
                                ? opt === 'raw'
                                  ? 'bg-destructive text-destructive-foreground'
                                  : opt === 'custom'
                                    ? 'bg-primary text-primary-foreground'
                                    : opt === 'safe'
                                      ? 'bg-primary/70 text-primary-foreground'
                                      : 'bg-muted text-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                              btnDisabled && 'cursor-not-allowed opacity-60',
                            )}
                          >
                            {t(`commandBoardSettings.modes.${opt}`, {
                              defaultValue:
                                opt === 'raw'
                                  ? 'تنفيذ أي أمر'
                                  : opt === 'custom'
                                    ? 'الأوامر المخصّصة'
                                    : opt === 'safe'
                                      ? 'القائمة الآمنة'
                                      : 'معطّل',
                            })}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Unarmed note: owner has 'raw' tier but main switch is off → tier is inactive */}
            {roleModes['owner'] === 'raw' && !(config?.rawExecEnabled) && (
              <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <Lock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                {t('commandBoardSettings.modes.rawUnarmedNote', {
                  defaultValue:
                    'الطبقة الخطرة غير مسلَّحة — اختيارها هنا لا يسري حتى تُسلَّح من القسم أدناه',
                })}
              </p>
            )}

            {/* Mode legend: one line per tier (تراكمي — كلٌّ يشمل ما قبله) */}
            <div className="space-y-1 rounded-md bg-muted/30 px-3 py-2">
              <p className="mb-1 text-[10px] text-muted-foreground/60">
                {t('commandBoardSettings.roles.legendHint', {
                  defaultValue: 'الطبقات تراكمية — كلٌّ منها يشمل ما قبلها',
                })}
              </p>
              {(['none', 'safe', 'custom', 'raw'] as const).map((opt) => (
                <p key={opt} className="text-xs text-muted-foreground">
                  <strong
                    className={cn(
                      'font-medium',
                      opt === 'raw' ? 'text-destructive' : 'text-foreground',
                    )}
                  >
                    {t(`commandBoardSettings.modes.${opt}`, {
                      defaultValue:
                        opt === 'raw'
                          ? 'تنفيذ أي أمر'
                          : opt === 'custom'
                            ? 'الأوامر المخصّصة'
                            : opt === 'safe'
                              ? 'القائمة الآمنة'
                              : 'معطّل',
                    })}
                  </strong>
                  {' — '}
                  {t(`commandBoardSettings.modes.${opt}Desc`, {
                    defaultValue:
                      opt === 'raw'
                        ? 'جميع الطبقات أعلاه + تنفيذ أي نصّ shell حرّ. للمالك فقط. يستلزم تسليح المفتاح الرئيسي.'
                        : opt === 'custom'
                          ? 'القائمة الآمنة + الأوامر المخصّصة التي عرّفتَها (محصورة بتنفيذيات مجمّدة بالكود، لا تنفيذ نصّ حرّ).'
                          : opt === 'safe'
                            ? 'تشغيل أوامر القائمة الآمنة المدرجة مع التطبيق فقط.'
                            : 'لا وصول للوحة الأوامر لهذا الدور.',
                  })}
                </p>
              ))}
              {/* Hint: custom tier set but no custom commands defined yet */}
              {customCount === 0 && Object.values(roleModes).some((m) => m === 'custom') && (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <AlertCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                  {t('commandBoardSettings.roles.customHint', {
                    defaultValue:
                      '«الأوامر المخصّصة» لا يُضيف أثراً فعلياً ما لم تُعرِّف أوامر مخصّصة في قسم «الأوامر المخصّصة» أدناه.',
                  })}
                </p>
              )}
            </div>
          </SettingsCard>

          {/* 2. الطبقة الخطرة — ADR-072 (immediately after matrix per spec order) */}
          <RawExecSection blockedReasons={config?.rawExecBlockedReasons ?? []} />

          {/* 3. القائمة الآمنة — Safe list actions enable/disable */}
          <SettingsCard className="space-y-4 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('commandBoardSettings.actions.title', { defaultValue: 'الأوامر المتاحة' })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('commandBoardSettings.actions.description', {
                  defaultValue: 'فعّل أو عطّل كل أمر في القائمة الآمنة.',
                })}
              </p>
            </div>

            <div className="space-y-2.5">
              {actions.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('commandBoardSettings.actions.empty', { defaultValue: 'لا أوامر.' })}
                </p>
              )}
              {actions.map((action) => {
                const isEnabled = !disabledActions.includes(action.actionType);
                return (
                  <div
                    key={action.actionType}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{action.actionType}</p>
                      {action.commandPreview && (
                        <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">
                          {action.commandPreview}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isEnabled}
                      disabled={isSaving}
                      onClick={() => toggleAction(action.actionType)}
                      className={cn(
                        'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                        isEnabled ? 'bg-primary' : 'bg-muted-foreground/30',
                        isSaving && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                          isEnabled ? 'translate-x-4' : 'translate-x-0.5',
                        )}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          </SettingsCard>

          {/* 4. الأوامر المخصّصة — Custom commands (T-948 Phase 2) */}
          <CustomCommandsSection onCountChange={setCustomCount} />

          {feedback && (
            <p
              role="status"
              className={cn(
                'text-sm',
                feedback.kind === 'success'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-destructive',
              )}
            >
              {feedback.message}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={handleSave} disabled={!dirty || isSaving}>
              {isSaving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {isSaving
                ? t('commandBoardSettings.saving', { defaultValue: 'جارٍ الحفظ…' })
                : t('commandBoardSettings.save', { defaultValue: 'حفظ' })}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
