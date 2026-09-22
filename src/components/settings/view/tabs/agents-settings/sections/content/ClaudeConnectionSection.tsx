import { useCallback, useState } from 'react';

import { useAuth } from '../../../../../../auth';
import { useClaudeConnection } from '../../../../../hooks/useClaudeConnection';
import { useProviderApiKey } from '../../../../../../provider-auth/hooks/useProviderApiKey';
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
 * Onboarding flow: the modal runs `claude setup-token`, which PRINTS a
 * long-lived OAuth token once and stores nothing itself (the CLI dropped the
 * interactive `/login`; see `getProviderCommand`). So linking is two steps, and
 * the second one is this section's `onSaveToken`: the printed token is pasted
 * into the card's own input and written to `CLAUDE_CODE_OAUTH_TOKEN` in
 * `settings.json`. Status is re-checked when the process exits, after a
 * successful save, and via the explicit Re-check button.
 *
 * WHOSE `settings.json` — THE PASTER'S OWN, ALWAYS (B-1251, fixed server-side).
 * The writer resolves its path through `resolveProviderEnv(userId, 'claude', …,
 * { honorGrants: false })`. Until that fix the resolver's default (`honorGrants`
 * TRUE — right for a spawn) applied here too, so a member running on a
 * credential GRANT pasted their personal token into the GRANTOR's tree: it
 * erased the grantor's credential, put the grantor and every other grantee onto
 * the paster's personal subscription, and — because `claude-onboarding.service`
 * reads the paster's OWN tree — kept reporting "not connected" after a save
 * that said it succeeded. The write, the delete and the status now all resolve
 * the caller's own tree, matching the interactive-login rule
 * `resolve-provider-env.js` already states for terminals. A grant still governs
 * which credential a TURN spawns on; it never governs where a credential is
 * written.
 *
 * The invite BANNER is still non-owner only (an owner needs no invitation to
 * their own node); the paste field is not, because the owner authenticates for
 * themselves now — the backend no longer symlinks the operator credential into
 * owner-role trees (ADR-105 / B-486). The field IS gated on `writable`: under a
 * `shared` sharing policy the write needs an elevated role, and a member who
 * learns that from a 403 has already destroyed the only copy of the token
 * (B-362).
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
  const { saveKey, writable: tokenWritable } = useProviderApiKey('claude');
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

  /**
   * Saves the setup-token printed by `claude setup-token` via the provider
   * API-key endpoint, then re-probes the connection status (B-1075).
   */
  const handleSaveToken = useCallback(
    async (token: string) => {
      const result = await saveKey(token);
      if (result.success) {
        await refresh();
      }
      return result;
    },
    [saveKey, refresh],
  );

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
    onRecheck: handleRecheck,
    onSaveToken: handleSaveToken,
    // ‏`undefined` يمرّ كما هو: الغائب ليس رفضاً (B-367).
    canSaveToken: tokenWritable,
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
