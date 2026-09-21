import express from 'express';
import { userDb } from '../modules/database/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { getSystemGitConfig } from '../utils/gitConfig.js';
import { getClaudeConnectionStatus } from '../services/isolation/claude-onboarding.service.js';
import { getAgyConnectionStatus } from '../services/isolation/agy-onboarding.service.js';

const router = express.Router();

const sendGitConfig = (res, gitName, gitEmail) =>
  res.json({
    success: true,
    gitName: gitName || null,
    gitEmail: gitEmail || null
  });

/**
 * The caller's role as stored in the DB (never the JWT claim).
 *
 * Reading it from the row means a token minted before a demotion — or any
 * future code path that widens the JWT payload — cannot grant the host-identity
 * privilege below. Fail-closed: anything unreadable ranks as "not owner".
 */
const readStoredRole = (userId) => {
  try {
    return userDb.getUserById(userId)?.role ?? null;
  } catch {
    return null;
  }
};

const isSameIdentity = (stored, system) =>
  (stored.git_name || null) === (system.git_name || null)
  && (stored.git_email || null) === (system.git_email || null);

// B-119 (high — cross-user identity leak, NOT a UX default):
// the host's `git config --global` identity belongs to the operator who owns the
// machine, not to everyone who accepts an invite. The previous version
// auto-populated ANY user whose row was empty from that global config AND
// persisted it, so a brand-new member's onboarding wizard ("Git Configuration —
// Required") opened pre-filled with the machine owner's real name and email —
// and, once he pressed Next, every commit he made was attributed to that other
// person via buildGitAuthorEnv.
//
// Contract now:
//  1. A stored identity always wins — a member who typed his own keeps it.
//  2. The host-global fallback is offered ONLY to accounts whose stored role is
//     'owner' (the operator himself, incl. his secondary owner accounts), so the
//     owner's own onboarding/settings experience is unchanged.
//  3. Rows already poisoned by the old behaviour are remediated on read: for a
//     non-owner, a stored identity byte-identical to the host-global identity is
//     treated as leaked, cleared from the row, and reported as empty. Such a
//     value is never a legitimate member identity, and leaving it would keep
//     mis-attributing that member's commits.
router.get('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const isPlatformOwner = readStoredRole(userId) === 'owner';
    const gitConfig = userDb.getGitConfig(userId);
    const hasStoredIdentity = Boolean(gitConfig?.git_name || gitConfig?.git_email);

    if (hasStoredIdentity) {
      if (isPlatformOwner) {
        return sendGitConfig(res, gitConfig.git_name, gitConfig.git_email);
      }

      const systemConfig = await getSystemGitConfig();
      const hostHasIdentity = Boolean(systemConfig.git_name || systemConfig.git_email);
      if (!hostHasIdentity || !isSameIdentity(gitConfig, systemConfig)) {
        return sendGitConfig(res, gitConfig.git_name, gitConfig.git_email);
      }

      userDb.updateGitConfig(userId, null, null);
      console.warn(`Cleared host git identity leaked into user ${userId}'s profile (B-119)`);
      return sendGitConfig(res, null, null);
    }

    // No stored identity: only the owner inherits the host's global config.
    // Everyone else gets empty fields and enters his own identity.
    if (!isPlatformOwner) {
      return sendGitConfig(res, null, null);
    }

    const systemConfig = await getSystemGitConfig();
    if (systemConfig.git_name || systemConfig.git_email) {
      userDb.updateGitConfig(userId, systemConfig.git_name, systemConfig.git_email);
      return sendGitConfig(res, systemConfig.git_name, systemConfig.git_email);
    }

    return sendGitConfig(res, null, null);
  } catch (error) {
    console.error('Error getting git config:', error);
    res.status(500).json({ error: 'Failed to get git configuration' });
  }
});

// Persist the user's git identity to their DB row ONLY (B-MU-UX-GIT-ID).
//
// This no longer runs `git config --global`: in the shared nassaj workspace a
// global write was last-writer-wins and clobbered every other brother's
// identity in ~/.gitconfig. The stored name/email is instead injected
// per-commit at each commit site via GIT_AUTHOR_*/GIT_COMMITTER_*, so saving an
// identity never affects other users or the system gitconfig.
router.post('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { gitName, gitEmail } = req.body;

    if (!gitName || !gitEmail) {
      return res.status(400).json({ error: 'Git name and email are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(gitEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    userDb.updateGitConfig(userId, gitName, gitEmail);

    res.json({
      success: true,
      gitName,
      gitEmail
    });
  } catch (error) {
    console.error('Error updating git config:', error);
    res.status(500).json({ error: 'Failed to update git configuration' });
  }
});

router.post('/complete-onboarding', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    userDb.completeOnboarding(userId);

    res.json({
      success: true,
      message: 'Onboarding completed successfully'
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

router.get('/onboarding-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const hasCompleted = userDb.hasCompletedOnboarding(userId);

    res.json({
      success: true,
      hasCompletedOnboarding: hasCompleted
    });
  } catch (error) {
    console.error('Error checking onboarding status:', error);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

// Reports whether the current user has registered their own Claude credential
// in their isolated config dir (B-MU-ONBOARD). Returns only a boolean — never
// the token itself — so the onboarding UI can render "connected/not connected".
//
//   curl -H "Authorization: Bearer <jwt>" \
//        http://localhost:3004/api/user/claude-connection
router.get('/claude-connection', authenticateToken, async (req, res) => {
  try {
    const status = await getClaudeConnectionStatus(req.user.id);
    res.json(status);
  } catch (error) {
    console.error('Error checking Claude connection status:', error);
    res.status(500).json({ error: 'Failed to check Claude connection status' });
  }
});

// Reports whether the current user has authenticated their own agy (antigravity)
// credential in their isolated config dir (ADR-023). Returns only a boolean —
// never the token — so the onboarding UI can render "connected/not connected".
// userId comes from the JWT, never from input.
//
//   curl -H "Authorization: Bearer <jwt>" \
//        http://localhost:3004/api/user/agy-connection
router.get('/agy-connection', authenticateToken, async (req, res) => {
  try {
    const status = await getAgyConnectionStatus(req.user.id);
    res.json(status);
  } catch (error) {
    console.error('Error checking agy connection status:', error);
    res.status(500).json({ error: 'Failed to check agy connection status' });
  }
});

export default router;
