/**
 * sourceRepo — the single place this app knows where its own source lives.
 *
 * AGPL-3.0 §13 obligates a network-served instance to offer its source to users,
 * so several surfaces link to it (About, sidebar footer, auth screen, MCP help)
 * and the release watcher polls its GitHub releases. That destination is
 * DEPLOYMENT CONFIGURATION, not a constant: a fork that publishes its own source
 * must be able to point every one of those surfaces at its own repository by
 * setting VITE_SOURCE_URL at build time — never by patching components.
 *
 * Hardcoding one org/repo here also breaks the license promise the moment that
 * repository stops being public.
 */

/** Full URL of the repository serving this build's source. */
export const SOURCE_REPO_URL: string =
  import.meta.env.VITE_SOURCE_URL || 'https://github.com/AlKindy-OSS/nassaj';

/** `github.com/org/repo` — derived, so a label can never drift from its href. */
export const SOURCE_REPO_LABEL: string = SOURCE_REPO_URL
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');

const [, , , owner = '', name = ''] = SOURCE_REPO_URL.replace(/\/+$/, '').split('/');

/** GitHub owner segment, for the releases API. Empty when the URL is not a GitHub URL. */
export const SOURCE_REPO_OWNER: string = owner;

/** GitHub repository segment, for the releases API. */
export const SOURCE_REPO_NAME: string = name;

/**
 * Whether the release watcher may poll GitHub for this build. A non-GitHub or
 * unresolvable source URL has no releases endpoint, so polling is skipped rather
 * than firing requests that can only 404.
 */
export const SOURCE_RELEASES_AVAILABLE: boolean =
  SOURCE_REPO_URL.startsWith('https://github.com/') && Boolean(owner) && Boolean(name);
