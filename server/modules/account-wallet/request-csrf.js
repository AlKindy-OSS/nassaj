import crypto from 'node:crypto';

const TOKEN_TTL_MS = 15 * 60_000;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Returns the canonical API pathname accepted by the mutation-token contract. */
export function canonicalMutationPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048
      || /[\u0000-\u001f\u007f\\]/u.test(value)) return null;
  try {
    const pathname = new URL(value, 'http://nassaj.invalid').pathname;
    return pathname.startsWith('/api/') && !pathname.includes('//') ? pathname : null;
  } catch {
    return null;
  }
}

/** Returns a stable, server-derived binding for a cookie-authenticated identity. */
export function mutationIdentityBinding(req) {
  const principal = req.devicePrincipal;
  if (principal) {
    return `device:${principal.deviceSessionId}:${principal.slotId}:${principal.generation}`;
  }
  if (req.passwordChangeSession && Number.isSafeInteger(req.user?.id)
      && Number.isSafeInteger(req.user?.password_changed_at)) {
    return `password-change:${req.user.id}:${req.user.password_changed_at}`;
  }
  return null;
}

/** Mints a short-lived request token bound to identity generation, method and path. */
export function mintMutationCsrfToken(secret, binding, method, path, nowMs = Date.now()) {
  const normalizedMethod = String(method || '').toUpperCase();
  const normalizedPath = canonicalMutationPath(path);
  if (!MUTATION_METHODS.has(normalizedMethod) || !normalizedPath || !binding) return null;
  const expiresAt = nowMs + TOKEN_TTL_MS;
  const signature = crypto.createHmac('sha256', secret)
    .update(`${binding}:${normalizedMethod}:${normalizedPath}:${expiresAt}`)
    .digest('base64url');
  return { csrfToken: `${expiresAt}.${signature}`, expiresAt };
}

/** Checks an Origin header against the configured or request-derived application origin. */
export function isTrustedMutationOrigin(req) {
  const origin = req.get('origin');
  const expected = String(process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`)
    .replace(/\/$/u, '');
  return typeof origin === 'string' && origin.replace(/\/$/u, '') === expected;
}

/** Verifies the mutation token in constant time. */
export function verifyMutationCsrfToken(secret, req, binding, nowMs = Date.now()) {
  const method = String(req.method || '').toUpperCase();
  if (!MUTATION_METHODS.has(method)) return true;
  const path = canonicalMutationPath(req.originalUrl || req.url || '');
  const [rawExpiry, suppliedSignature] = String(req.get('x-csrf-token') || '').split('.');
  const expiry = Number(rawExpiry);
  if (!path || !binding || !Number.isSafeInteger(expiry) || expiry < nowMs
      || expiry > nowMs + TOKEN_TTL_MS || !suppliedSignature) return false;
  const expectedSignature = crypto.createHmac('sha256', secret)
    .update(`${binding}:${method}:${path}:${expiry}`)
    .digest('base64url');
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

/** Enforces Origin and generation-bound CSRF only for ambient cookie identities. */
export function enforceCookieMutationGuard(req, res, secret) {
  const method = String(req.method || '').toUpperCase();
  if (!MUTATION_METHODS.has(method)) return true;
  // Logout retains the older action-scoped wallet token. Refresh rejects device
  // sessions without mutating anything. The `/accounts/*` mutations use
  // walletAuth directly and never reach this guard.
  const path = canonicalMutationPath(req.originalUrl || req.url || '');
  if (method === 'POST' && (path === '/api/auth/logout' || path === '/api/auth/refresh')) {
    return true;
  }
  const binding = mutationIdentityBinding(req);
  if (!binding) return true;
  if (!isTrustedMutationOrigin(req) || !verifyMutationCsrfToken(secret, req, binding)) {
    res.status(403).json({ error: 'Request rejected', code: 'csrf_or_origin_rejected' });
    return false;
  }
  return true;
}
