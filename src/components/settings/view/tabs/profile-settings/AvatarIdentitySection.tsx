import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Check, Loader2, UserRound } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../../shared/view/ui';
import { cn } from '../../../../../lib/utils';
import { api } from '../../../../../utils/api';
import { useAuth } from '../../../../auth';
import { parseJsonSafely, resolveApiErrorMessage } from '../../../../auth/utils';
import {
  AVATAR_COLORS,
  GALLERY_AVATARS,
  avatarColorValue,
  colorClassFromAvatarUrl,
  isAvatarColorValue,
  isGalleryAvatarValue,
} from '../../../../participants/avatarChoice';
import { avatarColorForUser, initialForName } from '../../../../participants/utils';
import SettingsSection from '../../SettingsSection';

import FeedbackBanner from './FeedbackBanner';
import type { Feedback } from './FeedbackBanner';

type IdentityMode = 'upload' | 'gallery' | 'color';

type Props = {
  t: TFunction;
};

/**
 * Avatar identity picker (C-MU-UX-AVATAR-PICK).
 *
 * Three ways to set your avatar, all persisted into the single `avatar_url`
 * field so the choice propagates to every avatar surface unchanged:
 *  - Upload: a profile photo (existing behaviour, multipart upload).
 *  - Gallery: a curated static avatar (stored as `/avatars-gallery/<id>.svg`).
 *  - Colour: a palette colour for the lettered avatar (stored as `color:<id>`).
 */
export default function AvatarIdentitySection({ t }: Props) {
  const { user, updateAvatar } = useAuth();
  const currentAvatarUrl = typeof user?.avatarUrl === 'string' ? user.avatarUrl : '';
  const username = user?.username ?? '';
  const initial = initialForName(username);

  // Derive the initial active tab from the current avatar kind so the section
  // opens on the path the user last used.
  const initialMode: IdentityMode = isAvatarColorValue(currentAvatarUrl)
    ? 'color'
    : isGalleryAvatarValue(currentAvatarUrl)
      ? 'gallery'
      : 'upload';
  const [mode, setMode] = useState<IdentityMode>(initialMode);

  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);

  const chosenColorClass = colorClassFromAvatarUrl(currentAvatarUrl);
  const showImagePreview =
    Boolean(currentAvatarUrl) && !chosenColorClass && !previewFailed;

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const openFilePicker = useCallback(() => avatarInputRef.current?.click(), []);

  const handleUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) {
        return;
      }
      setFeedback(null);
      setIsSaving(true);
      try {
        const response = await api.auth.updateAvatar(file);
        const payload = await parseJsonSafely<{ avatarUrl?: string; error?: string; message?: string }>(
          response,
        );
        if (!response.ok || !payload?.avatarUrl) {
          setFeedback({
            kind: 'error',
            message: resolveApiErrorMessage(payload, t('profile.avatar.errors.uploadFailed')),
          });
          return;
        }
        updateAvatar(payload.avatarUrl);
        setPreviewFailed(false);
        setFeedback({ kind: 'success', message: t('profile.avatar.success') });
      } catch (error) {
        console.error('Avatar upload error:', error);
        setFeedback({ kind: 'error', message: t('profile.avatar.errors.network') });
      } finally {
        setIsSaving(false);
      }
    },
    [t, updateAvatar],
  );

  // Persist a gallery avatar (data URI) or a colour choice through the shared
  // JSON endpoint; both reflect immediately via updateAvatar.
  const saveChoice = useCallback(
    async (choice: { avatar: string } | { color: string }) => {
      setFeedback(null);
      setIsSaving(true);
      try {
        const response = await api.auth.updateAvatarChoice(choice);
        const payload = await parseJsonSafely<{ avatarUrl?: string; error?: string; message?: string }>(
          response,
        );
        if (!response.ok || !payload?.avatarUrl) {
          setFeedback({
            kind: 'error',
            message: resolveApiErrorMessage(payload, t('profile.identity.errors.saveFailed')),
          });
          return;
        }
        updateAvatar(payload.avatarUrl);
        setPreviewFailed(false);
        setFeedback({ kind: 'success', message: t('profile.identity.success') });
      } catch (error) {
        console.error('Avatar choice error:', error);
        setFeedback({ kind: 'error', message: t('profile.identity.errors.network') });
      } finally {
        setIsSaving(false);
      }
    },
    [t, updateAvatar],
  );

  const tabs = useMemo(
    () =>
      [
        { id: 'upload' as const, label: t('profile.identity.tabs.upload') },
        { id: 'gallery' as const, label: t('profile.identity.tabs.gallery') },
        { id: 'color' as const, label: t('profile.identity.tabs.color') },
      ],
    [t],
  );

  return (
    <SettingsSection
      title={t('profile.identity.title')}
      description={t('profile.identity.description')}
    >
      <div className="flex items-start gap-4">
        {/* Live preview */}
        {showImagePreview ? (
          <img
            src={currentAvatarUrl}
            alt={t('profile.avatar.currentAlt')}
            className={cn(
              'h-20 w-20 flex-shrink-0 rounded-full object-cover ring-2 ring-border',
              // Solid disc behind the picture: transparent gallery SVGs would
              // otherwise float without a background (deterministic user colour,
              // matching ParticipantAvatar). Opaque photos simply cover it.
              avatarColorForUser(user?.id ?? username),
            )}
            onError={() => setPreviewFailed(true)}
          />
        ) : chosenColorClass || username ? (
          <div
            role="img"
            aria-label={t('profile.avatar.currentAlt')}
            className={cn(
              'flex h-20 w-20 flex-shrink-0 select-none items-center justify-center rounded-full text-2xl font-semibold text-white ring-2 ring-border',
              chosenColorClass ?? 'bg-muted',
            )}
          >
            {initial}
          </div>
        ) : (
          <div
            role="img"
            aria-label={t('profile.avatar.placeholderAlt')}
            className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-full bg-muted ring-2 ring-border"
          >
            <UserRound className="h-9 w-9 text-muted-foreground" aria-hidden />
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-3">
          {/* Tabs */}
          <div role="tablist" aria-label={t('profile.identity.title')} className="flex gap-1">
            {tabs.map((tab) => {
              const active = mode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setMode(tab.id);
                    setFeedback(null);
                  }}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {mode === 'upload' && (
            <div className="space-y-2">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleUpload}
                aria-hidden
                tabIndex={-1}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={openFilePicker}
                disabled={isSaving}
              >
                {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                <span className={isSaving ? 'ms-1.5' : undefined}>
                  {isSaving ? t('profile.avatar.uploading') : t('profile.avatar.change')}
                </span>
              </Button>
              <p className="text-xs text-muted-foreground">{t('profile.avatar.hint')}</p>
            </div>
          )}

          {mode === 'gallery' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                {t('profile.identity.gallery.heading')}
              </p>
              <div
                role="radiogroup"
                aria-label={t('profile.identity.gallery.heading')}
                className="grid max-w-md grid-cols-4 gap-3 sm:grid-cols-6"
              >
                {GALLERY_AVATARS.map((avatar) => {
                  const selected = currentAvatarUrl === avatar.url;
                  return (
                    <button
                      key={avatar.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={avatar.id}
                      disabled={isSaving}
                      onClick={() => saveChoice({ avatar: avatar.url })}
                      className={cn(
                        'relative aspect-square overflow-hidden rounded-full ring-2 ring-offset-2 ring-offset-background transition focus:outline-none focus:ring-ring disabled:opacity-60',
                        selected
                          ? 'ring-primary'
                          : 'ring-transparent hover:ring-border hover:scale-105',
                      )}
                    >
                      <img src={avatar.url} alt="" className="h-full w-full object-cover" />
                      {selected && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                          <Check className="h-5 w-5 text-white" aria-hidden />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {mode === 'color' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                {t('profile.identity.color.heading')}
              </p>
              <div
                role="radiogroup"
                aria-label={t('profile.identity.color.heading')}
                className="flex flex-wrap gap-2"
              >
                {AVATAR_COLORS.map((color) => {
                  const value = avatarColorValue(color.id);
                  const selected = currentAvatarUrl === value;
                  return (
                    <button
                      key={color.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={color.id}
                      disabled={isSaving}
                      onClick={() => saveChoice({ color: color.id })}
                      className={cn(
                        'relative flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white ring-2 transition focus:outline-none focus:ring-ring disabled:opacity-60',
                        color.className,
                        selected ? 'ring-primary' : 'ring-transparent hover:ring-border',
                      )}
                    >
                      {selected ? <Check className="h-4 w-4" aria-hidden /> : initial}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('profile.identity.color.hint')}
              </p>
            </div>
          )}
        </div>
      </div>

      <FeedbackBanner feedback={feedback} />
    </SettingsSection>
  );
}
