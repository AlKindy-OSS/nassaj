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
   *  (T-866/F1) — forwarded to `AccountContent`'s `ProviderApiKeySection`. */
  onRefreshAuthStatus?: () => void;
};

/**
 * Claude Account view with the per-user subscription link merged in
 * [C-MU-UX-AGENT-CREDS]. Thin stateful wrapper: it owns the
 * `useClaudeConnection` fetch (B-MU-ONBOARD) and the `/login` terminal modal,
 * and renders the single unified credential card (`AccountContent`) so
 * connection state appears exactly once per agent.
 *
 * Onboarding flow (non-owner, not linked): the card shows a warning banner
 * with a "Link Claude account" CTA that opens `ProviderLoginModal` running
 * `claude --dangerously-skip-permissions /login` — the only command that writes
 * `.credentials.json` into the user's isolated directory, allowing
 * `getClaudeConnectionStatus` to detect a valid credential. Status is
 * re-checked when the process exits and via the explicit Re-check button. The
 * owner is symbolically linked by the backend and never forced through the flow.
 *
 * `AccountContent` also renders `ProviderApiKeySection` for claude independently
 * (T-866/F1): pasting an Anthropic API key is a second, coexisting way to
 * authenticate this agent, alongside the subscription link above.
 */
export default function ClaudeConnectionSection({
  authStatus,
  onLogin,
  onRefreshAuthStatus,
}: ClaudeConnectionSectionProps) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const { connected, loading, error, refresh } = useClaudeConnection(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openModal = useCallback(() => setIsModalOpen(true), []);
  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // Re-check status when the /login process exits so the status badge updates.
  const handleProcessComplete = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleRecheck = useCallback(() => {
    void refresh();
  }, [refresh]);

  const userLink: UserCredentialLink = {
    connected,
    loading,
    error,
    isOwner,
    i18nPrefix: 'claudeConnection',
    command: 'claude --dangerously-skip-permissions /login',
    onLink: openModal,
    onRecheck: handleRecheck,
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
        onComplete={handleProcessComplete}
      />
    </>
  );
}
