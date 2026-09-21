export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

// Mirrors the server-side minimum for self-service password changes
// (/api/auth/me/password). Kept in sync with server/routes/auth.js.
export const MIN_PASSWORD_LENGTH = 8;

export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  inviteFailed: 'Could not accept the invite',
  passwordChangeFailed: 'Failed to change password',
  usernameChangeFailed: 'Failed to change username',
  networkError: 'Network error. Please try again.',
} as const;
