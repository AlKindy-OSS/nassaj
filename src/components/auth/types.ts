import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import type { ReactNode } from 'react';

export type UserRole = 'owner' | 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export type AuthUser = {
  id?: number | string;
  username: string;
  role?: UserRole;
  status?: UserStatus;
  // Set by the server after an admin password reset; cleared once the user
  // rotates their own password. Surfaced to gate the app behind a forced change.
  mustChangePassword?: boolean;
  // Optional profile picture URL, returned by /api/auth/me and /api/auth/user.
  avatarUrl?: string;
  [key: string]: unknown;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

export type AuthStatusPayload = {
  needsSetup?: boolean;
};

export type AuthUserPayload = {
  user?: AuthUser;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

// Passkey summary as returned by /api/auth/webauthn (register/verify and
// GET /credentials). Mirrors WebAuthnCredentialSummary on the server —
// snake_case row fields, never the public key bytes.
export type PasskeyCredentialSummary = {
  id: string;
  user_id: number;
  counter: number;
  transports: string | null;
  // 'singleDevice' (device-bound) or 'multiDevice' (synced) per WebAuthn.
  device_type: string | null;
  // SQLite boolean (0/1) — true when the passkey is backed up/synced.
  backed_up: number | boolean;
  aaguid: string | null;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  // True when the server flagged the account for a forced password change
  // (after an admin reset). The app must block normal use until it is cleared.
  mustChangePassword: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  // Completes a passkey sign-in: verifies the WebAuthn assertion on the server
  // and then runs the exact same session steps as `login` (skipNextAuthCheck,
  // setSession, identity hydration, onboarding check) so the forced
  // password-change and onboarding gates behave identically.
  loginWithPasskey: (assertionResponse: AuthenticationResponseJSON) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  acceptInvite: (token: string, username: string, password: string) => Promise<AuthActionResult>;
  // Self-service mutations. On password change the fresh token is persisted so
  // the current device stays signed in and the forced-change gate is cleared.
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthActionResult>;
  changeUsername: (username: string) => Promise<AuthActionResult>;
  // Updates the avatar URL on the in-context user after a successful upload.
  updateAvatar: (avatarUrl: string) => void;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
