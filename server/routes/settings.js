import fs from 'fs';
import os from 'os';
import path from 'path';

import express from 'express';
import multer from 'multer';

import { apiKeysDb, credentialsDb, notificationPreferencesDb, pushSubscriptionsDb, appConfigDb, uiPreferencesDb } from '../modules/database/index.js';
import { requireRole } from '../middleware/auth.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { createNotificationEvent, notifyUserIfEnabled } from '../services/notification-orchestrator.js';
import { sanitizeSvg, looksLikeSvgRoot } from '../services/svg-sanitizer.js';
import { BRANDING_TITLE_KEY, BRANDING_SPLASH_HIDE_TITLE_KEY } from '../services/branding-config.js';

const router = express.Router();

// ===============================
// App-wide Branding (custom logo + title)
// ===============================

// app_config keys used for branding. These live in the app-level key/value store
// (not per-user) so the customization applies application-wide and survives
// restarts and deployments. The keys also needed outside these routes
// (BRANDING_TITLE_KEY, BRANDING_SPLASH_HIDE_TITLE_KEY) are defined once in
// services/branding-config.js and imported above.
const BRANDING_LOGO_PATH_KEY = 'branding.logo_path';
// Opaque cache-busting token bumped on every logo upload/delete. It is appended
// to the public logo URL as `?v=<version>` so a replaced logo (which keeps the
// same `/branding/logo.<ext>` path) yields a brand-new URL — guaranteeing a
// cache miss in both the browser HTTP cache and the Service Worker, so the new
// image appears immediately instead of the stale cached one.
const BRANDING_LOGO_VERSION_KEY = 'branding.logo_version';
// '1' = the header shows the uploaded logo alone (wordmark mode) instead of
// the icon + title pair. Meaningless without an uploaded logo — the client
// falls back to icon+title whenever logoUrl is null.
const BRANDING_LOGO_ONLY_KEY = 'branding.logo_only';
// Optional dark-theme variant of the logo. Same storage/serving scheme as the
// main logo with a `logo_dark.<ext>` filename; the client falls back to the
// main logo on dark theme when this one is absent.
const BRANDING_LOGO_DARK_PATH_KEY = 'branding.logo_dark_path';
const BRANDING_LOGO_DARK_VERSION_KEY = 'branding.logo_dark_version';
// Node icon: a small base64 data-URI stored directly in app_config (no file on
// disk, no static route needed). Kept ≤ 64 KB so it stays fast over WebSocket
// and does not bloat the branding payload.
const BRANDING_NODE_ICON_KEY = 'branding.node_icon_data_uri';
// Position of the node icon relative to the sidebar logo: 'start' (before) or
// 'end' (after), following CSS logical-property conventions so RTL layouts work
// without special-casing.
const BRANDING_NODE_ICON_POSITION_KEY = 'branding.node_icon_position';
const BRANDING_NODE_ICON_MAX_LENGTH = 65536; // 64 KB as base64 data-URI string
const BRANDING_NODE_ICON_ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
]);

const BRANDING_TITLE_MAX_LENGTH = 60;

// Runtime directory for the uploaded logo. Mirrors the avatars layout: it lives
// under the user's home dir (NOT inside dist/, which the build overwrites), so the
// uploaded file persists across `npm run build` and pm2 deploys. The matching
// static route (/branding/logo.<ext>) is registered in server/index.js.
const BRANDING_ROOT = path.join(os.homedir(), '.nassaj-users', '.branding');
const BRANDING_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// Allowed image MIME types → canonical extension used on disk and in the URL.
//
// SVG is supported but special-cased: it is an XML document (no fixed binary
// signature) that can carry inline scripts/event handlers — a stored-XSS vector
// when served same-origin. It is therefore (a) detected by inspecting the actual
// XML content for an <svg> root (see detectImageExt), (b) sanitized server-side
// with DOMPurify before any disk write (only the cleaned markup is persisted),
// and (c) served with a strict CSP + nosniff (see server/index.js).
//
// For raster formats the extension is ALWAYS derived from the magic bytes of the
// file content (see detectImageExt) — never from file.mimetype (client-
// controlled) nor the client-supplied filename — which removes both the spoofing
// and the path-traversal risk.
const BRANDING_MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// Inspect the real leading bytes of the buffer and return the canonical
// extension for the detected format, or null if it matches no allowed
// signature. This is the single source of truth for "what kind of image is
// this" — the client-declared Content-Type is never trusted.
export function detectImageExt(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }
  // SVG is text/XML, not a binary signature. Detect it by content: the document
  // (after BOM/whitespace/<?xml?>/comments) must have an <svg> ROOT element —
  // not merely contain the substring "<svg" somewhere. This is checked before
  // the 12-byte minimum used for raster signatures because a valid SVG can be
  // shorter than 12 bytes.
  if (looksLikeSvgRoot(buffer.toString('utf8'))) {
    return 'svg';
  }
  if (buffer.length < 12) {
    return null;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  // WEBP: "RIFF" (52 49 46 46) at 0..3 and "WEBP" (57 45 42 50) at 8..11.
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

// In-memory storage so the buffer is validated before any disk write; the
// on-disk filename is derived from the detected magic bytes only. We deliberately
// keep the multer fileFilter lenient (the real check is detectImageExt after the
// full buffer is available) but still bound the candidate set by declared type to
// reject obvious non-images early without reading them.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRANDING_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (BRANDING_MIME_TO_EXT[file.mimetype]) {
      return cb(null, true);
    }
    cb(null, false);
  },
}).single('logo');

// Canonical set of extensions that may appear on disk / in app_config. Derived
// from the MIME whitelist so the two can never drift apart.
const BRANDING_ALLOWED_EXTS = new Set(Object.values(BRANDING_MIME_TO_EXT));

// Resolve the public, server-relative URL for the stored logo, or null. We never
// return the absolute filesystem path to the client. The stored value is an
// EXTENSION (e.g. "png"), so it is validated against the allowed-extension set —
// not the MIME-keyed map.
function getBrandingLogoUrl(variant = 'light') {
  const cfg = brandingVariantConfig(variant);
  const ext = appConfigDb.get(cfg.pathKey);
  if (!ext || !BRANDING_ALLOWED_EXTS.has(ext)) {
    return null;
  }
  // Append the cache-busting version. A `?v` query param does not affect the
  // static route match (/branding/logo.:ext matches the path only), so the file
  // is still served correctly, but every upload changes the URL and defeats any
  // cached copy of the previous logo.
  const version = appConfigDb.get(cfg.versionKey);
  return version ? `/branding/${cfg.basename}.${ext}?v=${version}` : `/branding/${cfg.basename}.${ext}`;
}

// Per-variant storage parameters. Only 'dark' differs; anything else (absent
// query param, unknown value) maps to the main/light logo.
function brandingVariantConfig(variant) {
  if (variant === 'dark') {
    return {
      basename: 'logo_dark',
      pathKey: BRANDING_LOGO_DARK_PATH_KEY,
      versionKey: BRANDING_LOGO_DARK_VERSION_KEY,
    };
  }
  return {
    basename: 'logo',
    pathKey: BRANDING_LOGO_PATH_KEY,
    versionKey: BRANDING_LOGO_VERSION_KEY,
  };
}

// Public read: the branding payload is non-sensitive (custom title + logo URL
// only) and is needed by the PRE-AUTH screens (login/setup/splash) to show the
// custom identity. server/index.js registers this same handler on a public
// route BEFORE the authenticated /api/settings mount, so GET works without a
// token while all branding writes below stay owner-only.
export async function getBrandingHandler(req, res) {
  try {
    const title = appConfigDb.get(BRANDING_TITLE_KEY);
    const nodeIconRaw = appConfigDb.get(BRANDING_NODE_ICON_KEY);
    const nodeIconPosition = appConfigDb.get(BRANDING_NODE_ICON_POSITION_KEY);
    res.json({
      title: title && title.length > 0 ? title : null,
      logoUrl: getBrandingLogoUrl(),
      logoDarkUrl: getBrandingLogoUrl('dark'),
      logoOnly: appConfigDb.get(BRANDING_LOGO_ONLY_KEY) === '1',
      splashHideTitle: appConfigDb.get(BRANDING_SPLASH_HIDE_TITLE_KEY) === '1',
      nodeIconDataUri: nodeIconRaw && nodeIconRaw.length > 0 ? nodeIconRaw : null,
      nodeIconPosition: nodeIconPosition === 'start' ? 'start' : 'end',
    });
  } catch (error) {
    console.error('Error fetching branding:', error);
    res.status(500).json({ error: 'Failed to fetch branding' });
  }
}

router.get('/branding', getBrandingHandler);

// Owner-only: update the custom application title, the logo-only display mode
// and/or the splash hide-title mode. Each field is written only when present in
// the body, so the controls in the settings UI update independently. An
// empty/whitespace title clears it (falls back to the default i18n title on
// the client).
router.put('/branding', requireRole('owner'), async (req, res) => {
  try {
    if (typeof req.body?.title === 'string') {
      // Collapse whitespace and strip control characters before length-checking.
      const cleaned = req.body.title.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();

      if (cleaned.length > BRANDING_TITLE_MAX_LENGTH) {
        return res
          .status(400)
          .json({ error: `Title must be at most ${BRANDING_TITLE_MAX_LENGTH} characters` });
      }

      appConfigDb.set(BRANDING_TITLE_KEY, cleaned);
    }

    if (typeof req.body?.logoOnly === 'boolean') {
      appConfigDb.set(BRANDING_LOGO_ONLY_KEY, req.body.logoOnly ? '1' : '0');
    }

    // '1' = the splash/loading screen hides the app title and shows the logo
    // alone. The client ignores it while no logo is uploaded.
    if (typeof req.body?.splashHideTitle === 'boolean') {
      appConfigDb.set(BRANDING_SPLASH_HIDE_TITLE_KEY, req.body.splashHideTitle ? '1' : '0');
    }

    // Node icon: store as a base64 data-URI directly in app_config.
    // A null or empty value clears the icon; a non-empty string must be a
    // valid data:image/<allowed-type>;base64,… URI within the size limit.
    if ('nodeIconDataUri' in (req.body ?? {})) {
      const dataUri = req.body.nodeIconDataUri;
      if (dataUri === null || dataUri === '') {
        appConfigDb.set(BRANDING_NODE_ICON_KEY, '');
      } else if (typeof dataUri === 'string') {
        if (dataUri.length > BRANDING_NODE_ICON_MAX_LENGTH) {
          return res.status(400).json({ error: 'Icon exceeds the 64 KB limit' });
        }
        // Extract the declared MIME type from the data-URI prefix and validate
        // it against the allowed set. The actual pixel content is not validated
        // server-side (no decoder needed; browsers handle malformed images
        // gracefully and the value never leaves the same-origin context).
        const mimeMatch = dataUri.match(/^data:([^;]+);base64,/);
        if (!mimeMatch || !BRANDING_NODE_ICON_ALLOWED_MIME.has(mimeMatch[1])) {
          return res.status(400).json({ error: 'Invalid or unsupported icon type' });
        }
        appConfigDb.set(BRANDING_NODE_ICON_KEY, dataUri);
      }
    }

    // Icon position: 'start' = before the logo in reading order, 'end' = after.
    if (typeof req.body?.nodeIconPosition === 'string') {
      const pos = req.body.nodeIconPosition;
      if (pos === 'start' || pos === 'end') {
        appConfigDb.set(BRANDING_NODE_ICON_POSITION_KEY, pos);
      }
    }

    const title = appConfigDb.get(BRANDING_TITLE_KEY);
    const nodeIconRaw = appConfigDb.get(BRANDING_NODE_ICON_KEY);
    const nodeIconPosition = appConfigDb.get(BRANDING_NODE_ICON_POSITION_KEY);
    res.json({
      title: title && title.length > 0 ? title : null,
      logoUrl: getBrandingLogoUrl(),
      logoDarkUrl: getBrandingLogoUrl('dark'),
      logoOnly: appConfigDb.get(BRANDING_LOGO_ONLY_KEY) === '1',
      splashHideTitle: appConfigDb.get(BRANDING_SPLASH_HIDE_TITLE_KEY) === '1',
      nodeIconDataUri: nodeIconRaw && nodeIconRaw.length > 0 ? nodeIconRaw : null,
      nodeIconPosition: nodeIconPosition === 'start' ? 'start' : 'end',
    });
  } catch (error) {
    console.error('Error updating branding:', error);
    res.status(500).json({ error: 'Failed to update branding' });
  }
});

// Owner-only: upload/replace the custom logo (multipart/form-data, field `logo`).
router.post('/branding/logo', requireRole('owner'), (req, res) => {
  logoUpload(req, res, async (uploadError) => {
    try {
      if (uploadError) {
        if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Image exceeds the 2MB size limit' });
        }
        console.error('Branding logo upload error:', uploadError?.message);
        return res.status(400).json({ error: 'Invalid upload' });
      }

      const file = req.file;
      if (!file) {
        // Missing field or rejected by fileFilter (unsupported declared type).
        return res
          .status(400)
          .json({ error: 'A valid image file (png, jpeg, webp) is required' });
      }

      // Authoritative type check: derive the extension from the actual file
      // content (magic bytes), NOT from file.mimetype. A request that claims
      // image/png but whose bytes are not a real PNG/JPEG/WEBP is rejected here,
      // closing the content-type-spoofing / SVG-XSS hole.
      const ext = detectImageExt(file.buffer);
      if (!ext) {
        return res.status(400).json({ error: 'Unsupported image type' });
      }

      // For SVG we never persist the uploaded bytes as-is: they are sanitized
      // server-side (DOMPurify, SVG profile) to strip <script>, event handlers,
      // javascript: URLs, external <use>, <foreignObject> and CSS payloads. Only
      // the cleaned markup is written to disk. Raster formats are written
      // verbatim (already validated by magic bytes above).
      let outputBuffer = file.buffer;
      if (ext === 'svg') {
        const sanitized = sanitizeSvg(file.buffer.toString('utf8'));
        if (!sanitized) {
          // Not a valid SVG document (or nothing survived sanitization).
          return res.status(400).json({ error: 'Unsupported image type' });
        }
        outputBuffer = Buffer.from(sanitized, 'utf8');
      }

      // 'dark' targets the dark-theme variant; anything else the main logo.
      const variantCfg = brandingVariantConfig(req.query.variant);

      await fs.promises.mkdir(BRANDING_ROOT, { recursive: true });

      // Remove any logo stored under a different extension so a stale file is not
      // left shadowing the new one (and not served by the static handler).
      for (const otherExt of Object.values(BRANDING_MIME_TO_EXT)) {
        if (otherExt === ext) {
          continue;
        }
        await fs.promises.rm(path.join(BRANDING_ROOT, `${variantCfg.basename}.${otherExt}`), { force: true });
      }

      const targetPath = path.join(BRANDING_ROOT, `${variantCfg.basename}.${ext}`);
      await fs.promises.writeFile(targetPath, outputBuffer);

      // Persist only the extension; the public URL is rebuilt from it on read.
      appConfigDb.set(variantCfg.pathKey, ext);
      // Bump the cache-busting version so the rebuilt URL (?v=...) differs from
      // the previous one and forces every client to fetch the new bytes.
      appConfigDb.set(variantCfg.versionKey, String(Date.now()));

      res.json({ logoUrl: getBrandingLogoUrl(), logoDarkUrl: getBrandingLogoUrl('dark') });
    } catch (error) {
      console.error('Branding logo update error:', error?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// Owner-only: remove the custom logo (the variant named by ?variant, main by
// default), reverting to the default inline SVG / main-logo fallback.
router.delete('/branding/logo', requireRole('owner'), async (req, res) => {
  try {
    const variantCfg = brandingVariantConfig(req.query.variant);
    // Remove every possible logo file regardless of which extension is recorded.
    await fs.promises
      .mkdir(BRANDING_ROOT, { recursive: true })
      .catch(() => {});
    for (const ext of Object.values(BRANDING_MIME_TO_EXT)) {
      await fs.promises.rm(path.join(BRANDING_ROOT, `${variantCfg.basename}.${ext}`), { force: true });
    }
    appConfigDb.set(variantCfg.pathKey, '');
    // Bump the version on delete too: a subsequent re-upload of an image that
    // happens to share the previous extension will then carry a fresh ?v, and
    // any cached copy is logically invalidated.
    appConfigDb.set(variantCfg.versionKey, String(Date.now()));
    res.json({ logoUrl: getBrandingLogoUrl(), logoDarkUrl: getBrandingLogoUrl('dark') });
  } catch (error) {
    console.error('Branding logo delete error:', error?.message);
    res.status(500).json({ error: 'Failed to remove branding logo' });
  }
});

// ===============================
// API Keys Management
// ===============================

// Get all API keys for the authenticated user
router.get('/api-keys', async (req, res) => {
  try {
    const apiKeys = apiKeysDb.getApiKeys(req.user.id);
    // Don't send the full API key in the list for security
    const sanitizedKeys = apiKeys.map(key => ({
      ...key,
      api_key: key.api_key.substring(0, 10) + '...'
    }));
    res.json({ apiKeys: sanitizedKeys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
router.post('/api-keys', async (req, res) => {
  try {
    const { keyName } = req.body;

    if (!keyName || !keyName.trim()) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const result = apiKeysDb.createApiKey(req.user.id, keyName.trim());
    res.json({
      success: true,
      apiKey: result
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete an API key
router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const success = apiKeysDb.deleteApiKey(req.user.id, parseInt(keyId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = apiKeysDb.toggleApiKey(req.user.id, parseInt(keyId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error toggling API key:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, type || null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ===============================
// UI Preferences (synced across devices, per user)
// ===============================

router.get('/ui-preferences', async (req, res) => {
  try {
    const preferences = uiPreferencesDb.getUiPreferences(req.user.id);
    res.json({ preferences });
  } catch (error) {
    console.error('Error fetching UI preferences:', error);
    res.status(500).json({ error: 'Failed to fetch UI preferences' });
  }
});

router.put('/ui-preferences', async (req, res) => {
  const body = req.body;
  // Body must be a JSON object (not null, array, or primitive). express.json
  // parses a bare array/string into a non-object body; reject those up front.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: 'UI preferences must be a JSON object' });
  }
  try {
    const preferences = uiPreferencesDb.updateUiPreferences(req.user.id, body);
    res.json({ preferences });
  } catch (error) {
    // Repository throws on oversized payloads / non-object input.
    if (error instanceof TypeError || /too large/.test(String(error?.message))) {
      return res.status(400).json({ error: 'Invalid UI preferences payload' });
    }
    console.error('Error saving UI preferences:', error);
    res.status(500).json({ error: 'Failed to save UI preferences' });
  }
});

// ===============================
// Push Subscription Management
// ===============================

router.get('/push/vapid-public-key', async (req, res) => {
  try {
    const publicKey = getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    console.error('Error fetching VAPID public key:', error);
    res.status(500).json({ error: 'Failed to fetch VAPID public key' });
  }
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing subscription fields' });
    }
    pushSubscriptionsDb.saveSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);

    // Enable webPush in preferences so the confirmation goes through the full pipeline
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (!currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs?.channels, webPush: true },
      });
    }

    res.json({ success: true });

    // Send a confirmation push through the full notification pipeline
    const event = createNotificationEvent({
      provider: 'system',
      kind: 'info',
      code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' },
      severity: 'info'
    });
    notifyUserIfEnabled({ userId: req.user.id, event });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    // B-146: only unsubscribe an endpoint the caller actually owns. The
    // repository deletes purely by endpoint, so without this ownership gate any
    // authenticated user could delete another user's subscription by its
    // endpoint (IDOR). Scope the delete to the caller's own subscription set.
    const ownsEndpoint = pushSubscriptionsDb
      .getSubscriptions(req.user.id)
      .some((sub) => sub.endpoint === endpoint);
    if (ownsEndpoint) {
      pushSubscriptionsDb.removeSubscription(endpoint);
    }

    // Disable webPush in preferences to match subscription state
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs.channels, webPush: false },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

export default router;
