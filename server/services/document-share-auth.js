import jwt from 'jsonwebtoken';

import { userSsoAttestationFresh } from './sso-attestation.js';

/**
 * Real JWT verification for shares, independent of the platform-mode bypass.
 * Mirrors authenticateToken's credential checks (account state, pwd_iat,
 * authorization generation, SSO attestation freshness) because these routes
 * are mounted outside it.
 */
export function createDocumentShareVerifier(userDb, secret) {
  return (header) => {
    if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) return null;
    try {
      const claim = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] });
      if (!Number.isInteger(claim.userId) || !Number.isFinite(claim.exp)) return null;
      const user = userDb.getUserById(claim.userId);
      if (!user || user.status !== 'active' || user.is_active === 0 || user.must_change_password === 1) return null;
      if (user.password_changed_at && (!Number.isFinite(claim.pwd_iat) || claim.pwd_iat < user.password_changed_at)) return null;
      if (!Number.isSafeInteger(claim.auth_gen) || claim.auth_gen !== user.authorization_generation) return null;
      if (!userSsoAttestationFresh(user)) return null;
      return user;
    } catch {
      return null;
    }
  };
}
