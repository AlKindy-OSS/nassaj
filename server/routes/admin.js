/**
 * Admin routes — install-wide configuration restricted to owner/admin roles.
 *
 * Mounted at /api/admin. Every handler runs behind authenticateToken (applied
 * at mount) + requireRole('owner', 'admin'), so no business logic here re-checks
 * authentication. Validation lives in the provider-sharing service; this layer
 * only translates HTTP <-> service calls and writes the audit trail.
 */

import express from 'express';

import { auditLogDb } from '../modules/database/index.js';
import { requireRole } from '../middleware/auth.js';
import {
  getProviderSharingConfig,
  validateProviderSharingConfig,
  setProviderSharingConfig,
} from '../services/provider-sharing.js';

const router = express.Router();

// All admin endpoints require an elevated role. authenticateToken is applied
// where this router is mounted (server/index.js).
router.use(requireRole('owner', 'admin'));

// ---------------------------------------------------------------------------
// Provider credential-sharing policy
// ---------------------------------------------------------------------------

// Read the current per-provider sharing policy.
//
//   curl -H "Authorization: Bearer <jwt>" \
//        http://localhost:3004/api/admin/provider-sharing
router.get('/provider-sharing', (req, res) => {
  res.json({ config: getProviderSharingConfig() });
});

// Update the policy. Body: a JSON object mapping known providers to
// 'shared'|'isolated'. Partial patches are allowed (unspecified providers keep
// their current mode). Unknown providers or invalid modes are rejected. Takes
// effect immediately for subsequent provider spawns in this process.
//
//   curl -X PUT -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" \
//        -d '{"agy":"isolated"}' \
//        http://localhost:3004/api/admin/provider-sharing
router.put('/provider-sharing', (req, res) => {
  try {
    const result = validateProviderSharingConfig(req.body);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const stored = setProviderSharingConfig(result.config);

    auditLogDb.record('admin_provider_sharing_update', {
      userId: req.user.id,
      metadata: { config: stored },
      ipAddress: req.ip ?? null,
    });

    res.json({ config: stored });
  } catch (error) {
    console.error('Provider sharing update error:', error?.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
