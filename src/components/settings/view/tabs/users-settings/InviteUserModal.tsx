import { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, Button } from '../../../../../shared/view/ui';
import { copyTextToClipboard } from '../../../../../utils/clipboard';
import type { CreatedInvite, ManagedUserRole } from '../../../hooks/useUsersAdmin';

import UserDialogShell from './UserDialogShell';

type InviteUserModalProps = {
  // Whether the current actor may mint admin invites (owner only).
  canInviteAdmin: boolean;
  onClose: () => void;
  onCreate: (
    role: ManagedUserRole,
    ttlHours: number,
  ) => Promise<{ success: true; invite: CreatedInvite } | { success: false; error: string }>;
};

// Mirrors the valid range enforced by createInvite in
// server/services/invite.service.js (default 72h, 0 < ttlHours <= 720).
const TTL_OPTIONS: ReadonlyArray<{ hours: number; labelKey: string }> = [
  { hours: 24, labelKey: 'users.invite.durations.day1' },
  { hours: 72, labelKey: 'users.invite.durations.day3' },
  { hours: 168, labelKey: 'users.invite.durations.day7' },
  { hours: 720, labelKey: 'users.invite.durations.day30' },
];
const DEFAULT_TTL_HOURS = 72;

// Builds the absolute, openable invite link on the project domain (respecting
// any router basename), per the project rule to hand over real URLs.
function buildInviteUrl(token: string): string {
  const basename = window.__ROUTER_BASENAME__ || '';
  return `${window.location.origin}${basename}/join?token=${encodeURIComponent(token)}`;
}

// Server sends SQLite UTC timestamps as "YYYY-MM-DD HH:MM:SS" — neither a
// bare `new Date()` nor `Date.parse` reliably treat that as UTC across
// engines, so the separator swap + explicit `Z` is required before parsing.
function parseUtcTimestamp(value: string): Date | null {
  const isoLike = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatExpiry(value: string, locale: string): string {
  const date = parseUtcTimestamp(value);
  if (!date) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * Invite creation modal (C-UI-3). Owner/admin pick an optional role, submit,
 * and receive a one-time invite link with a copy button. The plaintext token is
 * shown once and never persisted in clear text server-side.
 */
export default function InviteUserModal({ canInviteAdmin, onClose, onCreate }: InviteUserModalProps) {
  const { t, i18n } = useTranslation('settings');
  const titleId = useId();

  const [role, setRole] = useState<ManagedUserRole>('user');
  const [ttlHours, setTtlHours] = useState<number>(DEFAULT_TTL_HOURS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [copied, setCopied] = useState(false);

  const handleSubmit = useCallback(async () => {
    setError('');
    setIsSubmitting(true);
    const result = await onCreate(role, ttlHours);
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setInviteUrl(buildInviteUrl(result.invite.token));
    setExpiresAt(result.invite.expiresAt);
  }, [onCreate, role, ttlHours]);

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(inviteUrl);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [inviteUrl]);

  // Allow Escape to dismiss the dialog.
  // Registered on `document` (not window) so this fires BEFORE Settings' document handler
  // (React child effects run before parent effects → child registers first).
  // Calling preventDefault signals Settings not to close itself.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <UserDialogShell
      titleId={titleId}
      title={t('users.invite.title')}
      closeLabel={t('users.invite.close')}
      onClose={onClose}
    >
      {!inviteUrl ? (
        <div className="space-y-4">
          <div>
            <label htmlFor="invite-role" className="mb-1 block text-sm font-medium text-foreground">
              {t('users.invite.roleLabel')}
            </label>
            {/* `border-input` لا `border-border`: حدّ التحكّم مطلوب بـWCAG 1.4.11
                وليس طبقةً من طبقات السطح، وكتابته برمز السطح داخل لوحٍ حدُّه
                بنفس الرمز أنتج حدّاً داخل حدٍّ بلونٍ واحد. */}
            <select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as ManagedUserRole)}
              disabled={isSubmitting}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="user">{t('users.roles.user')}</option>
              {canInviteAdmin && <option value="admin">{t('users.roles.admin')}</option>}
            </select>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('users.invite.roleHint')}
            </p>
          </div>

          <div>
            <label htmlFor="invite-ttl" className="mb-1 block text-sm font-medium text-foreground">
              {t('users.invite.durationLabel')}
            </label>
            <select
              id="invite-ttl"
              value={ttlHours}
              onChange={(event) => setTtlHours(Number(event.target.value))}
              disabled={isSubmitting}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {TTL_OPTIONS.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={isSubmitting}>
              {t('users.invite.cancel')}
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? t('users.invite.creating') : t('users.invite.submit')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('users.invite.successHint')}
          </p>
          {expiresAt && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('users.expiresAt', { date: formatExpiry(expiresAt, i18n.language) })}
            </p>
          )}
          <div className="flex items-center gap-2">
            {/* design-ok: `text-left` فيزيائي عمداً — الحقل جزيرة `dir="ltr"`
                تحمل رابطاً لاتينياً، و`text-start` فيها كان سيتبع اتجاه الجزيرة
                فيعطي النتيجة نفسها بينما الإزاحة المنطقية داخل جزر ltr فخّ
                مرصود (STYLE_LOCK §5). */}
            <input
              readOnly
              dir="ltr"
              value={inviteUrl}
              onFocus={(event) => event.target.select()}
              className="w-full rounded-md border border-input bg-muted px-3 py-2 text-left text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              onClick={handleCopy}
              className="flex-shrink-0"
              aria-label={t('users.invite.copy')}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ms-1.5">{copied ? t('users.invite.copied') : t('users.invite.copy')}</span>
            </Button>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('users.invite.done')}
            </Button>
          </div>
        </div>
      )}
    </UserDialogShell>
  );
}
