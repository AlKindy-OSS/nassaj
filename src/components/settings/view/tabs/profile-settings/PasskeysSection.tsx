/**
 * PasskeysSection (C-PK-3) — self-service passkey management inside the
 * profile settings tab.
 *
 * Lists the signed-in user's WebAuthn credentials (name, created/last-used
 * dates, synced vs device-bound badge) and offers add (with an optional
 * label), inline rename, and delete-with-confirmation. The WebAuthn
 * registration ceremony itself lives in useWebAuthn; this component only
 * orchestrates the CRUD calls and UI state. A dismissed authenticator prompt
 * is treated as a silent cancel, mirroring the login form.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Fingerprint, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, Input } from '../../../../../shared/view/ui';
import { useWebAuthn } from '../../../../auth/hooks/useWebAuthn';
import type { PasskeyCredentialSummary } from '../../../../auth/types';
import { parseJsonSafely, resolveApiErrorMessage } from '../../../../auth/utils';
import { api } from '../../../../../utils/api';
import SettingsSection from '../../SettingsSection';

import FeedbackBanner from './FeedbackBanner';
import type { Feedback } from './FeedbackBanner';

type CredentialsPayload = {
  credentials?: PasskeyCredentialSummary[];
  error?: string;
  message?: string;
};

/**
 * SQLite timestamps arrive as `YYYY-MM-DD HH:MM:SS` in UTC; normalize to ISO
 * so the Date constructor does not misread them as local time.
 */
function formatDate(value: string, locale: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A passkey synced through a platform account (iCloud/Google) vs device-bound. */
function isSyncedPasskey(credential: PasskeyCredentialSummary): boolean {
  return Boolean(credential.backed_up) || credential.device_type === 'multiDevice';
}

export default function PasskeysSection() {
  const { t, i18n } = useTranslation('settings');
  const { isSupported, registerPasskey } = useWebAuthn();

  const [credentials, setCredentials] = useState<PasskeyCredentialSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // Add-passkey form state.
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  // Inline rename state (one credential at a time).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isSavingRename, setIsSavingRename] = useState(false);

  // Two-step delete confirmation state.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    try {
      const response = await api.auth.webauthn.listCredentials();
      const payload = await parseJsonSafely<CredentialsPayload>(response);
      if (!response.ok || !payload?.credentials) {
        setFeedback({ kind: 'error', message: t('profile.passkeys.errors.loadFailed') });
        return;
      }
      setCredentials(payload.credentials);
    } catch (caughtError) {
      console.error('Passkey list error:', caughtError);
      setFeedback({ kind: 'error', message: t('profile.passkeys.errors.network') });
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

  const handleAddSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFeedback(null);
      setIsRegistering(true);
      const result = await registerPasskey(newName);
      setIsRegistering(false);

      if (!result.success) {
        // The user dismissed the authenticator prompt — not an error.
        if (result.kind === 'cancelled') {
          return;
        }
        if (result.kind === 'duplicate') {
          setFeedback({ kind: 'error', message: t('profile.passkeys.errors.duplicate') });
        } else if (result.kind === 'network') {
          setFeedback({ kind: 'error', message: t('profile.passkeys.errors.network') });
        } else {
          setFeedback({
            kind: 'error',
            message: result.error ?? t('profile.passkeys.errors.registerFailed'),
          });
        }
        return;
      }

      setCredentials((previous) => [...previous, result.credential]);
      setFeedback({ kind: 'success', message: t('profile.passkeys.success.added') });
      setShowAddForm(false);
      setNewName('');
    },
    [newName, registerPasskey, t],
  );

  const startRename = useCallback((credential: PasskeyCredentialSummary) => {
    setConfirmingDeleteId(null);
    setRenamingId(credential.id);
    setRenameValue(credential.name ?? '');
  }, []);

  const handleRenameSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const id = renamingId;
      const nextName = renameValue.trim();
      if (!id || !nextName) {
        return;
      }

      setFeedback(null);
      setIsSavingRename(true);
      try {
        const response = await api.auth.webauthn.renameCredential(id, nextName);
        if (!response.ok) {
          const payload = await parseJsonSafely<CredentialsPayload>(response);
          setFeedback({
            kind: 'error',
            message: resolveApiErrorMessage(payload, t('profile.passkeys.errors.renameFailed')),
          });
          return;
        }
        setCredentials((previous) =>
          previous.map((credential) =>
            credential.id === id ? { ...credential, name: nextName } : credential,
          ),
        );
        setFeedback({ kind: 'success', message: t('profile.passkeys.success.renamed') });
        setRenamingId(null);
        setRenameValue('');
      } catch (caughtError) {
        console.error('Passkey rename error:', caughtError);
        setFeedback({ kind: 'error', message: t('profile.passkeys.errors.network') });
      } finally {
        setIsSavingRename(false);
      }
    },
    [renameValue, renamingId, t],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setFeedback(null);
      setDeletingId(id);
      try {
        const response = await api.auth.webauthn.deleteCredential(id);
        if (!response.ok) {
          const payload = await parseJsonSafely<CredentialsPayload>(response);
          setFeedback({
            kind: 'error',
            message: resolveApiErrorMessage(payload, t('profile.passkeys.errors.deleteFailed')),
          });
          return;
        }
        setCredentials((previous) => previous.filter((credential) => credential.id !== id));
        setFeedback({ kind: 'success', message: t('profile.passkeys.success.deleted') });
      } catch (caughtError) {
        console.error('Passkey delete error:', caughtError);
        setFeedback({ kind: 'error', message: t('profile.passkeys.errors.network') });
      } finally {
        setDeletingId(null);
        setConfirmingDeleteId(null);
      }
    },
    [t],
  );

  return (
    <SettingsSection
      title={t('profile.passkeys.title')}
      description={t('profile.passkeys.description')}
    >
      <div className="space-y-4">
        {isSupported ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setShowAddForm((previous) => !previous)}
              disabled={isRegistering}
            >
              <Plus className="h-4 w-4" />
              {t('profile.passkeys.add')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('profile.passkeys.notSupported')}</p>
        )}

        {isSupported && showAddForm && (
          <form onSubmit={handleAddSubmit} className="space-y-3 rounded-lg border bg-card p-4">
            <div>
              <label
                htmlFor="passkey-new-name"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t('profile.passkeys.nameLabel')}
              </label>
              <Input
                id="passkey-new-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t('profile.passkeys.namePlaceholder')}
                disabled={isRegistering}
                maxLength={64}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={isRegistering}>
                {isRegistering && <Loader2 className="h-4 w-4 animate-spin" />}
                {isRegistering ? t('profile.passkeys.creating') : t('profile.passkeys.create')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setShowAddForm(false);
                  setNewName('');
                }}
                disabled={isRegistering}
              >
                {t('profile.passkeys.cancel')}
              </Button>
            </div>
          </form>
        )}

        <FeedbackBanner feedback={feedback} />

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('profile.passkeys.loading')}
          </div>
        ) : credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('profile.passkeys.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {credentials.map((credential) => (
              <li
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Fingerprint
                    className="h-5 w-5 flex-shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    {renamingId === credential.id ? (
                      <form onSubmit={handleRenameSubmit} className="flex items-center gap-2">
                        <Input
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          placeholder={t('profile.passkeys.renamePlaceholder')}
                          disabled={isSavingRename}
                          maxLength={64}
                          className="h-8 max-w-56"
                          autoFocus
                          aria-label={t('profile.passkeys.rename')}
                        />
                        <Button
                          type="submit"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          disabled={isSavingRename || !renameValue.trim()}
                          aria-label={t('profile.passkeys.renameSave')}
                        >
                          {isSavingRename ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => setRenamingId(null)}
                          disabled={isSavingRename}
                          aria-label={t('profile.passkeys.cancel')}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </form>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-foreground">
                          {credential.name ?? t('profile.passkeys.unnamed')}
                        </span>
                        <Badge variant={isSyncedPasskey(credential) ? 'default' : 'secondary'}>
                          {isSyncedPasskey(credential)
                            ? t('profile.passkeys.badges.synced')
                            : t('profile.passkeys.badges.device')}
                        </Badge>
                      </div>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('profile.passkeys.createdAt', {
                        date: formatDate(credential.created_at, i18n.language),
                      })}
                      {' · '}
                      {credential.last_used_at
                        ? t('profile.passkeys.lastUsedAt', {
                            date: formatDate(credential.last_used_at, i18n.language),
                          })
                        : t('profile.passkeys.neverUsed')}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {confirmingDeleteId === credential.id ? (
                    <>
                      <span className="text-sm text-muted-foreground">
                        {t('profile.passkeys.deleteConfirm')}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => void handleDelete(credential.id)}
                        disabled={deletingId === credential.id}
                      >
                        {deletingId === credential.id && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        {t('profile.passkeys.deleteConfirmYes')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmingDeleteId(null)}
                        disabled={deletingId === credential.id}
                      >
                        {t('profile.passkeys.cancel')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => startRename(credential)}
                        aria-label={t('profile.passkeys.rename')}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => {
                          setRenamingId(null);
                          setConfirmingDeleteId(credential.id);
                        }}
                        aria-label={t('profile.passkeys.delete')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
