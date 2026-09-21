import { DocumentShareError } from './document-share-files.js';

/** Validate a deployment-owned origin; request headers are never an input. */
export function trustedDocumentShareOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new DocumentShareError('SHARE_UNAVAILABLE', 503);
  let url;
  try { url = new URL(value.trim()); } catch { throw new DocumentShareError('SHARE_UNAVAILABLE', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new DocumentShareError('SHARE_UNAVAILABLE', 503);
  }
  return url.origin;
}

/** Derive a public URL only from validated configuration and a server-generated path. */
export function documentShareUrl(origin, sharePath) {
  return `${trustedDocumentShareOrigin(origin)}${sharePath}`;
}
