import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  KeyRound,
  MailPlus,
  MoreHorizontal,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ActionMenu, Alert, AlertDescription, Button } from '../../../../../shared/view/ui';
import type { ActionMenuItem } from '../../../../../shared/view/ui';
import { useAuth } from '../../../../auth';
import { useOidcAvailability } from '../../../../auth/hooks/useOidcAvailability';
import { useUsersAdmin } from '../../../hooks/useUsersAdmin';
import type { ManagedUser, ManagedUserRole } from '../../../hooks/useUsersAdmin';
import ParticipantAvatar from '../../../../participants/ParticipantAvatar';
import { formatLastSeen } from '../../../../participants/utils';
import SettingsCard from '../../SettingsCard';
import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import StatusBadge from '../../StatusBadge';

/**
 * صيغة الفراغ والانتظار الواحدة في هذا التبويب — نصٌّ رمادي متمركز كالأصل.
 * كان فيه ثلاث صيغ: دوّارةٌ مع نصٍّ محاذٍ للبداية، ونصٌّ بحشو، ونصٌّ بلا حشو.
 */
const EMPTY_STATE_CLASS = 'py-6 text-center text-[13px] leading-relaxed text-muted-foreground';

import InviteUserModal from './InviteUserModal';
import ResetPasswordModal from './ResetPasswordModal';
import SsoIdentityModal from './SsoIdentityModal';

const ROLE_OPTIONS: ManagedUserRole[] = ['user', 'admin', 'owner'];

/**
 * Users management tab (C-UI-2 + C-UI-3).
 *
 * - owner/admin: see the user list and pending invites, and send invites.
 * - owner only: change roles and suspend/activate users (mutations are
 *   additionally enforced server-side; the UI mirrors the same rules).
 */
export default function UsersSettingsTab() {
  const { t, i18n } = useTranslation('settings');
  const locale = i18n.language;
  const { user } = useAuth();
  const role = user?.role;
  const currentUserId = typeof user?.id === 'number' ? user.id : Number(user?.id);
  const isOwner = role === 'owner';
  const isAdmin = role === 'admin';

  const {
    users,
    invites,
    isLoading,
    loadError,
    updateRole,
    updateStatus,
    createInvite,
    revokeInvite,
    resetPassword,
    deleteUser,
    linkSsoIdentity,
    unlinkSsoIdentity,
  } = useUsersAdmin(true);
  const isSsoAvailable = useOidcAvailability();

  const [actionError, setActionError] = useState('');
  const [isInviteOpen, setInviteOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [ssoTarget, setSsoTarget] = useState<ManagedUser | null>(null);
  // Two-click confirmation: store the id of the user pending deletion.
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // Reset visibility: owner may reset anyone (but self), admin may reset only
  // non-owners (but self). Mirrors the server-side authorization.
  const canResetPassword = useCallback(
    (target: ManagedUser) => {
      if (target.id === currentUserId) {
        return false;
      }
      if (isOwner) {
        return true;
      }
      if (isAdmin) {
        return target.role !== 'owner';
      }
      return false;
    },
    [currentUserId, isAdmin, isOwner],
  );

  // SSO link visibility: owner may manage anyone's link (their own included);
  // admin may not touch an owner's — linking an owner to a subject the admin
  // controls would hand the admin an owner session.
  const canManageSso = useCallback(
    (target: ManagedUser) => isSsoAvailable && (isOwner || (isAdmin && target.role !== 'owner')),
    [isAdmin, isOwner, isSsoAvailable],
  );

  const pendingInvites = useMemo(
    () => invites.filter((invite) => invite.status === 'pending'),
    [invites],
  );

  const handleRoleChange = useCallback(
    async (id: number, nextRole: ManagedUserRole) => {
      setActionError('');
      const result = await updateRole(id, nextRole);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [updateRole],
  );

  const handleStatusToggle = useCallback(
    async (id: number, nextStatus: 'active' | 'disabled') => {
      setActionError('');
      const result = await updateStatus(id, nextStatus);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [updateStatus],
  );

  const handleRevoke = useCallback(
    async (id: number) => {
      setActionError('');
      const result = await revokeInvite(id);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [revokeInvite],
  );

  const handleDeleteUser = useCallback(
    async (id: number) => {
      if (deleteConfirmId !== id) {
        // First click: ask for confirmation.
        setDeleteConfirmId(id);
        return;
      }
      // Second click: proceed.
      setDeleteConfirmId(null);
      setActionError('');
      const result = await deleteUser(id);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [deleteConfirmId, deleteUser],
  );

  return (
    <div className="space-y-8">
      {/* البدائية تُستدعى بدل نسخ طباعتها بيد: الرأس داخلها، والفعل (دعوة عضو)
          بجانبها في صفٍّ مرن — فلا يبقى سلّمٌ منسوخ يشيخ بأول تعديل. و`Users`
          أيقونةً: التبويب عن **الأعضاء**، ويقولها الرمز قبل قراءة العنوان. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SettingsSection
          level="page"
          icon={Users}
          title={t('users.title')}
          className="min-w-0 flex-1"
        >
          {null}
        </SettingsSection>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" />
          <span className="ms-1.5">{t('users.inviteButton')}</span>
        </Button>
      </div>

      {/* صندوق الخطأ كان منسوخاً حرفياً هنا وفي المودالين بألوان خامّة
          (`red-300/red-100`). `Alert` المشترك يقوله بالرمز الدلالي مرّة واحدة. */}
      {actionError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {loadError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {/* Users list */}
      {/* `UserCheck` لا `Users`: أيقونة التبويب فوقه هي `Users`، وتكرارُها هنا
          يجعل الرمزين لا يفرّقان بين الحاوي والمحتوى. هذا القسم عن الأعضاء
          **القائمين** مقابل الدعوات المعلّقة تحته. */}
      {/* `boxed`: الأعضاء **قائمة** لا صفوفٌ متناثرة، وحدُّ القائمة هو ما يقول
          أين تبدأ وأين تنتهي. الفراغ وحده كان يقول «هنا انقطاع» ولا يقول «هذه
          الصفوف شيءٌ واحد» — وهي عين شكوى المالك (2026-08-03). */}
      <SettingsSection boxed icon={UserCheck} title={t('users.listHeading')}>
        {isLoading ? (
          <p className={EMPTY_STATE_CLASS}>{t('users.loading')}</p>
        ) : users.length === 0 ? (
          <p className={EMPTY_STATE_CLASS}>{t('users.empty')}</p>
        ) : (
          // **الاستثناء الوحيد المُصرَّح به لخطوط الصفوف** (قرار المالك
          // 2026-08-03، وحدُّه مكتوبٌ في `SettingsGroup` و§2.2 من الـBrief).
          //
          // جدول الأعضاء ليس «صفوف إعدادات»: كل صفّ فيه **نفس بنية الحقول**
          // (اسم · دور · أفعال)، والقارئ يمسحه **عمودياً** يقارن دور هذا بدور
          // ذاك. في مسحٍ كهذا يحمل الخطّ معلومة — أين انتهى صفٌّ وبدأ الذي
          // يليه — بخلاف صفوف إعدادٍ مختلفة الطبيعة لا يقارن بينها أحد.
          //
          // ولا يُقاس عليه: لا الدعوات المعلّقة تحته، ولا أي قائمة في تبويب
          // آخر. الخاصيّة اختيارية والافتراضي بلا خطوط، وحارسٌ آلي يُسقط أي
          // ملفٍّ ثانٍ يرفعها.
          <SettingsGroup as="ul" divided>
            {users.map((managedUser) => {
              const isSelf = managedUser.id === currentUserId;
              const isDisabled = managedUser.status === 'disabled';
              const isConfirmingDelete = deleteConfirmId === managedUser.id;

              // Everything a row can do, collected once. Rendering them as four
              // always-visible buttons put two red controls on every member and
              // made "delete" as loud as "reset password"; behind one menu they
              // are equally reachable and none of them shouts.
              const actions: ActionMenuItem[] = [];
              if (canResetPassword(managedUser)) {
                actions.push({
                  key: 'reset',
                  label: t('users.resetPassword'),
                  icon: KeyRound,
                  onSelect: () => setResetTarget(managedUser),
                });
              }
              if (canManageSso(managedUser)) {
                actions.push({
                  key: 'sso',
                  label: t('users.sso.menu'),
                  icon: ShieldCheck,
                  onSelect: () => setSsoTarget(managedUser),
                });
              }
              if (isOwner && !isSelf) {
                actions.push({
                  key: 'status',
                  label: isDisabled ? t('users.activate') : t('users.suspend'),
                  icon: isDisabled ? UserCheck : UserMinus,
                  onSelect: () =>
                    void handleStatusToggle(managedUser.id, isDisabled ? 'active' : 'disabled'),
                });
                actions.push({
                  key: 'delete',
                  label: t('users.deleteUser'),
                  icon: Trash2,
                  isDanger: true,
                  showDividerBefore: true,
                  // Opens the inline confirmation below rather than deleting.
                  // A two-click confirm inside a menu that closes on select is
                  // invisible — the second click would land on a closed menu.
                  onSelect: () => setDeleteConfirmId(managedUser.id),
                });
              }

              return (
                <li key={managedUser.id}>
                  {/* صفُّ عضوٍ = `SettingsRow` كأي صفّ إعداد آخر: عمود لصيقة
                      محدود العرض ثم التحكّمات تليه مباشرة. قبلها كان الصفّ
                      `justify-between` يدوياً، فتُدفع تحكّمات كل صفّ إلى الحافّة
                      بعرضٍ يتبع طول اسم صاحبه — عمودٌ لا يحاذي عموداً، وهو ما
                      استدعى الخطوطَ رابطاً بديلاً. */}
                  <SettingsRow
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <ParticipantAvatar
                          participant={{
                            userId: managedUser.id,
                            username: managedUser.username,
                            role: managedUser.role,
                            first_seen: managedUser.created_at ?? '',
                            // لا بيانات حضور فعلية في هذا التبويب: نمرّر سلسلة
                            // فارغة لتجنّب ظهور «آخر ظهور» في التلميح.
                            last_seen: '',
                            message_count: 0,
                          }}
                          avatarUrl={managedUser.avatar_url ?? undefined}
                          size="md"
                          locale={locale}
                          t={t}
                          ariaLabel={`${managedUser.username} — ${t(`users.roles.${managedUser.role}`)}`}
                          tooltipContent={
                            <span className="flex flex-col gap-0.5 text-start">
                              <span className="font-semibold">{managedUser.username}</span>
                              <span className="opacity-80">{t(`users.roles.${managedUser.role}`)}</span>
                              <span className="opacity-70">
                                {managedUser.last_login
                                  ? `${t('users.lastLogin')}: ${formatLastSeen(managedUser.last_login, locale)}`
                                  : t('users.neverLoggedIn')}
                              </span>
                            </span>
                          }
                        />
                        <span className="truncate">{managedUser.username}</span>
                        {isSelf && (
                          <span className="shrink-0 text-[13px] font-normal text-muted-foreground">
                            ({t('users.you')})
                          </span>
                        )}
                        {/* Only the EXCEPTION is badged. "Active" was on every
                            row, which is the definition of a label that carries
                            no information.
                            `StatusBadge` بدل `Badge`: نبرتان لا خمس (§2.8)،
                            ونقطةٌ دالّة مع النصّ فلا يقع التمييز على اللون
                            وحده. */}
                        {isDisabled && (
                          <StatusBadge tone="danger">{t('users.statuses.disabled')}</StatusBadge>
                        )}
                      </span>
                    }
                  >
                    {/* ارتفاعٌ ثابت لا حشوٌ وحده: صفُّك أنت بلا قائمة أفعال ولا
                        منتقي دور، فكان يخرج أقصر من كل صفٍّ سواه. */}
                    <div className="flex min-h-10 shrink-0 items-center gap-1.5">
                      {/* The role appears ONCE. It used to be both a badge and
                          a dropdown holding the same word. For an owner it is
                          the editable control; for everyone else, plain text. */}
                      {isOwner && !isSelf ? (
                        <>
                          <label className="sr-only" htmlFor={`role-${managedUser.id}`}>
                            {t('users.changeRole')}
                          </label>
                          <select
                            id={`role-${managedUser.id}`}
                            value={managedUser.role}
                            onChange={(event) =>
                              handleRoleChange(managedUser.id, event.target.value as ManagedUserRole)
                            }
                            className="rounded-md border border-transparent bg-transparent py-1 pe-8 ps-2 text-sm text-muted-foreground hover:border-input hover:text-foreground focus:border-input focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {t(`users.roles.${r}`)}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        // نبرة واحدة لكل الأدوار: التمييز بينها بثلاثة ألوان
                        // شارة كان معلومةً محمولة على اللون وحده، والاسم مكتوبٌ
                        // في الشارة أصلاً.
                        <StatusBadge>{t(`users.roles.${managedUser.role}`)}</StatusBadge>
                      )}

                      {/* عمود التحكّمات يبقى عموداً ولو خلا الصفّ من قائمته:
                          صفّك أنت بلا أفعال، فكانت شارة «Owner» تلتصق بالحافّة
                          بينما تحكّمات بقيّة الصفوف تبدأ قبلها بعرض زرّ القائمة
                          كاملاً. المكان محجوزٌ بديلاً فيحاذي الطرفُ الطرفَ. */}
                      {actions.length > 0 ? (
                        <ActionMenu
                          label=""
                          ariaLabel={t('users.rowActions', { username: managedUser.username })}
                          icon={MoreHorizontal}
                          items={actions}
                          variant="ghost"
                          size="icon"
                        />
                      ) : (
                        // 40px = `size="icon"` في `Button` (h-10 w-10).
                        <span className="h-10 w-10" aria-hidden="true" />
                      )}
                    </div>
                  </SettingsRow>

                  {/* Deletion is the one irreversible action here, so it is
                      confirmed in the row itself — named, in words, with the
                      username in it. */}
                  {/* منطقة الخطر — الإطار الوحيد المسموح به في هذا التبويب
                      (§1/§2.5). إطارٌ واحد يحمل معلومة: هذه المنطقة ليست
                      كبقيّتها؛ ولو أُطِّر غيرُها لضاعت الإشارة. */}
                  {/* الإطار كان مبنيّاً بيد (`border-destructive/40 bg-destructive/5`
                      + حشوٌ خاصّ) — و`--destructive` سطحٌ لا نبرة نصّية، فبناؤه
                      يدوياً يخرج عن الرموز المحروسة. `SettingsCard tone="danger"`
                      تعطي نفس المعنى بالرمز المقيس تباينُه، وبحشوها هي. */}
                  {isConfirmingDelete && (
                    <SettingsCard tone="danger" className="mt-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[13px] leading-relaxed text-foreground">
                        {t('users.deleteUserConfirm', { username: managedUser.username })}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          {t('users.reset.cancel')}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void handleDeleteUser(managedUser.id)}
                        >
                          {t('users.deleteUser')}
                        </Button>
                      </div>
                      </div>
                    </SettingsCard>
                  )}
                </li>
              );
            })}
          </SettingsGroup>
        )}
      </SettingsSection>

      {/* Pending invites */}
      {/* دعوةٌ معلّقة ليست تحذيراً ولا خطراً — هي إجراءٌ جارٍ ينتظر طرفاً آخر.
          `info` تبرزه دون أن تَعِد بعطل. */}
      <SettingsSection boxed icon={MailPlus} tone="info" title={t('users.pendingInvites')}>
        {pendingInvites.length === 0 ? (
          <p className={EMPTY_STATE_CLASS}>{t('users.noPendingInvites')}</p>
        ) : (
          // **بلا خطوط — عمداً، وهذا موضع الحدّ.** الدعوة المعلّقة سطرٌ يُقرأ
          // وحده ويُلغى وحده، لا يقارنه القارئ بسطرٍ آخر؛ والقائمة قصيرة
          // (‏غالباً صفر أو واحد). فلو رفعت `divided` لأن «هذه أيضاً قائمة»
          // لصار الخطّ نمطاً عامّاً — وهو التعميم الذي مُنع صراحةً.
          <SettingsGroup as="ul">
              {pendingInvites.map((invite) => (
                <li key={invite.id}>
                  <SettingsRow
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <StatusBadge>{t(`users.roles.${invite.role}`)}</StatusBadge>
                        {invite.email && (
                          // القيمة التقنية معزولة: بريدٌ لاتيني داخل سطر عربي
                          // ينكسر ترقيمه بلا `dir` + عزل bidi.
                          <span
                            className="truncate font-normal text-muted-foreground"
                            dir="ltr"
                            style={{ unicodeBidi: 'isolate' }}
                          >
                            {invite.email}
                          </span>
                        )}
                      </span>
                    }
                    description={t('users.expiresAt', { date: invite.expires_at })}
                  >
                    <div className="flex min-h-10 shrink-0 items-center">
                      <Button variant="ghost" size="sm" onClick={() => handleRevoke(invite.id)}>
                        {t('users.revoke')}
                      </Button>
                    </div>
                  </SettingsRow>
                </li>
              ))}
          </SettingsGroup>
        )}
      </SettingsSection>

      {isInviteOpen && (
        <InviteUserModal
          canInviteAdmin={isOwner}
          onClose={() => setInviteOpen(false)}
          onCreate={createInvite}
        />
      )}

      {resetTarget && (
        <ResetPasswordModal
          username={resetTarget.username}
          onClose={() => setResetTarget(null)}
          onReset={() => resetPassword(resetTarget.id)}
        />
      )}

      {ssoTarget && (
        <SsoIdentityModal
          username={ssoTarget.username}
          onClose={() => setSsoTarget(null)}
          onLink={(subject) => linkSsoIdentity(ssoTarget.id, subject)}
          onUnlink={() => unlinkSsoIdentity(ssoTarget.id)}
        />
      )}
    </div>
  );
}
