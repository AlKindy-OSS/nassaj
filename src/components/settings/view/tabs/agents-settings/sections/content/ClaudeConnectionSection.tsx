import { useCallback, useState } from 'react';

import { useAuth } from '../../../../../../auth';
import { useClaudeConnection } from '../../../../../hooks/useClaudeConnection';
import type { AuthStatus } from '../../../../../types/types';
import ProviderLoginModal from '../../../../../../provider-auth/view/ProviderLoginModal';

import AccountContent, { type UserCredentialLink } from './AccountContent';

type ClaudeConnectionSectionProps = {
  authStatus: AuthStatus;
  onLogin: () => void;
  /** Re-probes `/auth/status` after the Anthropic API key is set/removed
   *  (T-866/F1) — forwarded to `AccountContent`. */
  onRefreshAuthStatus?: () => void;
};

/**
 * Claude Account view with the per-user subscription link merged in
 * [C-MU-UX-AGENT-CREDS]. Thin stateful wrapper: it owns the
 * `useClaudeConnection` fetch (B-MU-ONBOARD) and the `/login` terminal modal,
 * and renders the single unified credential card (`AccountContent`) so
 * connection state appears exactly once per agent.
 *
 * Onboarding flow (B-1260): the modal runs `claude auth login` in the in-app
 * terminal. The user pastes the sign-in code directly into that terminal and
 * the CLI stores the credential itself (full OAuth, with a refresh token), so
 * there is no token field on this card. Status is re-checked when the process
 * exits and via the explicit Re-check button.
 *
 * The invite BANNER is non-owner only (an owner needs no invitation to their
 * own node); the owner authenticates for themselves like everyone else, since
 * the backend no longer symlinks the operator credential into owner-role trees
 * (ADR-105 / B-486).
 *
 * Pasting an Anthropic API key remains a second, coexisting way to authenticate
 * this agent alongside the subscription link above — but it happens in Settings
 * → Vendors, not here (B-350 / ADR-085). `AccountContent` shows only a pointer
 * to it; the section that used to render the form was deleted in T-1139.
 */
export default function ClaudeConnectionSection({
  authStatus,
  onLogin,
  onRefreshAuthStatus,
}: ClaudeConnectionSectionProps) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const { connected, incompleteLink, loading, error, refresh } = useClaudeConnection(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openModal = useCallback(() => setIsModalOpen(true), []);
  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // The badge reads BOTH checks (`authStatus.authenticated || connected`), so a
  // re-check that refreshed only the link left a stale "connected" on screen.
  const recheckAll = useCallback(() => {
    void refresh();
    onRefreshAuthStatus?.();
  }, [refresh, onRefreshAuthStatus]);

  const userLink: UserCredentialLink = {
    connected,
    incompleteLink,
    loading,
    error,
    isOwner,
    i18nPrefix: 'claudeConnection',
    /**
     * **الأمر المعروض هو الأمر المُشغَّل.** B-1260: صار `claude auth login`
     * (‏OAuth كامل) بدل `claude setup-token` (‏inference-only) كي يطابق
     * `getProviderCommand` في `ProviderLoginModal` — المصدر الوحيد للحقيقة،
     * والمقيَّد بـ`PROVIDER_LOGIN_COMMAND_ALLOWLIST` خادميّاً. تركُ القديم هنا
     * كان يَعِد القارئ بأمرٍ لا يراه في الطرفية.
     */
    command: 'claude auth login',
    onLink: openModal,
    onRecheck: recheckAll,
  };

  return (
    <>
      <AccountContent
        agent="claude"
        authStatus={authStatus}
        onLogin={onLogin}
        userLink={userLink}
        onRefreshAuthStatus={onRefreshAuthStatus}
      />

      <ProviderLoginModal
        isOpen={isModalOpen}
        onClose={closeModal}
        provider="claude"
        onComplete={recheckAll}
      />
    </>
  );
}
