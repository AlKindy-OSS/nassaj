/**
 * Project link (T-1950): an optional external URL attached to a project (its
 * live site, repository, board...). Shared project state, shown to every viewer.
 *
 * SECURITY — the server must NEVER fetch this URL: no link preview, no favicon
 * lookup, no liveness probe. It is user-supplied, so any server-side request to
 * it is an SSRF primitive into the host's network. It is stored and returned
 * verbatim for the client to render as a plain outbound link, nothing more.
 */
import { projectsDb } from '@/modules/database/index.js';
import { notifyProjectMetadataChanged } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

export const PROJECT_LINK_MAX_LENGTH = 2048;

// A scheme is letters then ':' NOT followed by a digit, so a bare host:port
// (`example.com:8080`, `localhost:3000`) is treated as host and prefixed.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
// C0 controls, DEL and C1 controls.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const WHITESPACE = /\s/;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function invalidLink(message: string): AppError {
  return new AppError(message, { code: 'INVALID_PROJECT_LINK', statusCode: 400 });
}

function assertWithinLength(value: string): void {
  if (value.length > PROJECT_LINK_MAX_LENGTH) {
    throw invalidLink(`linkUrl must be at most ${PROJECT_LINK_MAX_LENGTH} characters.`);
  }
}

/**
 * Validates and normalizes a client-supplied project link.
 *
 * Returns the canonical absolute http(s) URL (`URL.href`), or null when the
 * input is null/empty (meaning "clear the link"). Throws AppError 400 for any
 * other type, over-long input, control characters, internal whitespace, a
 * non-http(s) scheme, embedded credentials, or a missing host. A bare host
 * such as `example.com/x` or `localhost:3000` is accepted and given an
 * `https://` prefix.
 */
export function normalizeProjectLink(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string') {
    throw invalidLink('linkUrl must be a string or null.');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  assertWithinLength(trimmed);
  if (CONTROL_CHARS.test(trimmed)) {
    throw invalidLink('linkUrl must not contain control characters.');
  }
  if (WHITESPACE.test(trimmed)) {
    throw invalidLink('linkUrl must not contain whitespace.');
  }

  const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw invalidLink('linkUrl is not a valid URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw invalidLink('linkUrl must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw invalidLink('linkUrl must not contain credentials.');
  }
  if (!parsed.hostname) {
    throw invalidLink('linkUrl must include a host.');
  }

  assertWithinLength(parsed.href);
  return parsed.href;
}

/**
 * Normalizes and stores a project's link, then refreshes every connected
 * client through the shared `projects_updated` queue (shared visibility seam, currently unfiltered per ADR-089).
 * Authorization is the caller's responsibility (route: assertProjectWritable).
 */
export function updateProjectLink(projectId: string, input: unknown): string | null {
  const linkUrl = normalizeProjectLink(input);
  projectsDb.setProjectLinkUrl(projectId, linkUrl);
  notifyProjectMetadataChanged();
  return linkUrl;
}
