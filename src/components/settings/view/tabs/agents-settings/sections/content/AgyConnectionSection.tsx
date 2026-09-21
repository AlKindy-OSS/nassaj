import { useCallback, useState } from 'react';

import { useAuth } from '../../../../../../auth';
import { useAgyConnection } from '../../../../../hooks/useAgyConnection';
import type { AuthStatus } from '../../../../../types/types';

import AccountContent, { type UserCredentialLink } from './AccountContent';
import AgySetupModal from './AgySetupModal';

type AgyConnectionSectionProps = {
  authStatus: AuthStatus;
  onLogin: () => void;
};

/**
 * Antigravity (agy) Account view with the per-user subscription link merged
 * in [C-MU-UX-AGENT-CREDS]. Mirror of `ClaudeConnectionSection`: it owns the
 * `useAgyConnection` fetch and the interactive `agy` terminal modal (which
 * launches Google OAuth when no valid token exists), and renders the single
 * unified credential card (`AccountContent`) so connection state appears
 * exactly once per agent.
 *
 * agy has no UI-driven login, so the card never shows the generic Re-login
 * row; linking/re-linking always goes through the terminal modal. The owner
 * is symbolically linked by the backend and never forced through the flow.
 */
export default function AgyConnectionSection({ authStatus, onLogin }: AgyConnectionSectionProps) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const { connected, loading, error, refresh } = useAgyConnection(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openModal = useCallback(() => setIsModalOpen(true), []);
  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // Re-check status when the terminal process exits (agy login finished).
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
    i18nPrefix: 'agyConnection',
    command: 'agy',
    onLink: openModal,
    onRecheck: handleRecheck,
  };

  return (
    <>
      <AccountContent
        agent="antigravity"
        authStatus={authStatus}
        onLogin={onLogin}
        userLink={userLink}
      />

      <AgySetupModal
        isOpen={isModalOpen}
        onClose={closeModal}
        onComplete={handleProcessComplete}
      />
    </>
  );
}
