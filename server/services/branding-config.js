import { appConfigDb } from '../modules/database/index.js';

// app_config keys for the app-wide branding identity that are needed OUTSIDE
// the settings routes. Single source of truth shared by:
//   - server/routes/settings.js   (read/write of the branding settings)
//   - server/services/notification-orchestrator.js (web-push titles)
//   - server/index.js             (dynamic /manifest.json name override)
export const BRANDING_TITLE_KEY = 'branding.title';

// '1' = the splash/loading screen shows the logo alone and hides the app
// title text. Meaningless without an uploaded logo — the client keeps the
// title visible whenever logoUrl is null.
export const BRANDING_SPLASH_HIDE_TITLE_KEY = 'branding.splash_hide_title';

// Stock product name used when no custom branding title is configured. Matches
// the client-side i18n default (`app.title`) and the service-worker fallback.
export const DEFAULT_APP_TITLE = 'CloudCLI';

/** The custom branding title, or null when unset/empty. */
export function getBrandingTitle() {
  const title = appConfigDb.get(BRANDING_TITLE_KEY);
  return typeof title === 'string' && title.trim().length > 0 ? title : null;
}

/** The effective app display name: the custom branding title or the stock default. */
export function getAppTitle() {
  return getBrandingTitle() || DEFAULT_APP_TITLE;
}
