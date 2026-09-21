/**
 * Public repository configuration.
 *
 * AGPL-3.0 §13 obligates a network-served instance to offer its source to users,
 * so several surfaces link to it (About, sidebar footer, auth screen, MCP help)
 * Browser-visible source URLs are deliberately independent from the private Git
 * remote used for release discovery. The update watcher uses the authenticated
 * server endpoint and never ships private repository coordinates or credentials.
 *
 * Deployments may override the public source destination at build time without
 * coupling it to the server's Git configuration.
 */

const DEFAULT_PUBLIC_REPO_URL = 'https://github.com/AlKindy-OSS/nassaj';

/** Public source link shown to users. Never points at the runtime Git remote. */
export const SOURCE_REPO_URL: string =
  import.meta.env.VITE_PUBLIC_SOURCE_URL || DEFAULT_PUBLIC_REPO_URL;

/** `github.com/org/repo` — derived, so a label can never drift from its href. */
export const SOURCE_REPO_LABEL: string = SOURCE_REPO_URL
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');

export function githubRepoParts(url: string): { owner: string; name: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      return { owner: '', name: '' };
    }
    const [owner = '', rawName = '', ...rest] = parsed.pathname
      .split('/')
      .filter(Boolean);
    if (!owner || !rawName || rest.length > 0) return { owner: '', name: '' };
    return { owner, name: rawName.replace(/\.git$/, '') };
  } catch {
    return { owner: '', name: '' };
  }
}

const { owner: sourceOwner, name: sourceName } = githubRepoParts(SOURCE_REPO_URL);

/** GitHub owner segment, for the releases API. Empty when the URL is not a GitHub URL. */
export const SOURCE_REPO_OWNER: string = sourceOwner;

/** GitHub repository segment, for the releases API. */
export const SOURCE_REPO_NAME: string = sourceName;
