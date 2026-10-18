/**
 * The owner's privileged actions (ADR-H20 D6 A1, ADR-194 amendment A2).
 *
 * An owner who entered with no click from an IdP session may read everything,
 * but these actions need a fresh passkey step-up first (about 60 minutes,
 * bound to that browser): agent commands (starting or continuing a turn), the
 * terminal, server actions (restart, update), settings, keys, users and roles,
 * SSO configuration and the linked-session settings with the kill switch.
 *
 * REST is classified here by method and path (checked in authenticateToken).
 * The realtime side is gated where the action happens: provider-effect chat
 * messages and the /shell and /terminal sockets (websocket services).
 *
 * Never gated: reads, sign-out, token refresh, every /api/auth/oidc route
 * except unlinking another user's identity (the step-up itself must stay
 * reachable), passkey registration, and anything authenticated by an API key
 * (API keys are untouched by ADR-H20).
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths whose every method is privileged (the terminal). */
const PRIVILEGED_ANY_METHOD = Object.freeze([
  /^\/api\/terminals(?:\/|$)/,
]);

/** Paths whose non-read methods are privileged. */
const PRIVILEGED_WRITES = Object.freeze([
  // Settings, keys and SSO configuration (settings router, incl. /sso and /api-keys).
  /^\/api\/settings(?:\/|$)/,
  /^\/api\/credential-grants(?:\/|$)/,
  /^\/api\/providers(?:\/|$)/,
  /^\/api\/connectors(?:\/|$)/,
  /^\/api\/governance(?:\/|$)/,
  /^\/api\/harness-files(?:\/|$)/,
  // Server actions (restart, update, command board).
  /^\/api\/system(?:\/|$)/,
  // Users and roles.
  /^\/api\/admin(?:\/|$)/,
  /^\/api\/auth\/users(?:\/|$)/,
  /^\/api\/auth\/invites(?:\/|$)/,
  // Unlinking another user's SSO identity (revokes their API keys); /link/self stays open.
  /^\/api\/auth\/oidc\/link\/(?!self(?:\/|$))[^/]+$/,
  // Renaming or deleting a passkey (registration and the step-up stay open).
  /^\/api\/auth\/webauthn\/credentials(?:\/|$)/,
  // Agent commands over REST: slash commands, steering, scheduled turns,
  // workflow launches and continuing a paused run.
  /^\/api\/commands(?:\/|$)/,
  /^\/api\/session-steer(?:\/|$)/,
  /^\/api\/scheduled-messages(?:\/|$)/,
  /^\/api\/workflow-supervisor(?:\/|$)/,
  /^\/api\/sessions\/[^/]+\/permission-fence(?:\/|$)/,
]);

/** Exact query-free, lowercased path; a traversal-shaped path stays a distinct string. */
function normalizedPath(req) {
  const raw = req.originalUrl || req.url || '';
  const withoutQuery = raw.split('?')[0].split('#')[0];
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return (trimmed || '/').toLowerCase();
}

/**
 * Whether this request is one of the owner's privileged actions.
 * @param {{ method?: string, originalUrl?: string, url?: string }} req
 * @returns {boolean}
 */
export function isOwnerPrivilegedRequest(req) {
  const path = normalizedPath(req);
  if (PRIVILEGED_ANY_METHOD.some((pattern) => pattern.test(path))) return true;
  const method = String(req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return false;
  return PRIVILEGED_WRITES.some((pattern) => pattern.test(path));
}

/**
 * Realtime chat message types that start or continue an agent turn.
 * @type {ReadonlySet<string>}
 */
export const OWNER_PRIVILEGED_CHAT_MESSAGES = new Set([
  'claude-command', 'cursor-command', 'codex-command', 'antigravity-command', 'kimi-command',
  'deepseek-command', 'glm-command', 'qwen-command', 'opencode-command', 'cursor-resume',
  'btw-query', 'btw-fork', 'message-fork', 'session-steer', 'claude-permission-response',
]);

/** Stable refusal code; the SPA answers it with the passkey step-up prompt. */
export const OWNER_STEP_UP_REQUIRED_CODE = 'owner_step_up_required';
