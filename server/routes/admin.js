/**
 * Admin routes — install-wide configuration restricted to owner/admin roles.
 *
 * Mounted at /api/admin. Every handler runs behind authenticateToken (applied
 * at mount) + requireRole('owner', 'admin'), so no business logic here re-checks
 * authentication.
 *
 * The install-wide provider-sharing policy is retired (ADR-152 amendment 1):
 * a provider credential is usable by another member only through a grant its
 * owner made at /api/credential-grants. Both of its old endpoints answer 410 and
 * write nothing — no role may make another person's credential usable.
 */

import express from 'express';

import { requireRole } from '../middleware/auth.js';

const router = express.Router();

// All admin endpoints require an elevated role. authenticateToken is applied
// where this router is mounted (server/index.js). A member still gets 403.
router.use(requireRole('owner', 'admin'));

/** Body of the retired provider-sharing endpoints (ADR-152 A1 §3.3). */
const PROVIDER_SHARING_RETIRED = Object.freeze({
  error: Object.freeze({
    code: 'PROVIDER_SHARING_RETIRED',
    message: 'The install-wide provider sharing policy is retired. A credential is shared only by '
      + 'its owner, as a grant from the agent settings page.',
    messageAr: 'أُلغيت سياسة مشاركة المزوّدات العامة. لا يُشارَك اعتماد إلا بمنحة من صاحبه '
      + 'من صفحة إعدادات الوكلاء.',
    replacement: '/api/credential-grants',
  }),
});

// Retired: read and update of the per-provider sharing policy. Nothing is read,
// written or audited.
//
//   curl -i -X PUT -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" \
//        -d '{"claude":"shared"}' http://localhost:3004/api/admin/provider-sharing
//   → HTTP/1.1 410 Gone  {"error":{"code":"PROVIDER_SHARING_RETIRED",…}}
router.all('/provider-sharing', (_req, res) => {
  res.status(410).json(PROVIDER_SHARING_RETIRED);
});

export default router;
