/**
 * Attachment inbox confinement (B-1374).
 *
 * The upload endpoint (POST /api/projects/:projectId/upload-attachments) stores every
 * agent attachment under `<project>/.nassaj-uploads/inbox` and hands the client a
 * cwd-relative path. A provider that reads attachment files itself (opencode's
 * `run --file`) must only ever be given a path that really lives in that inbox:
 * a client-supplied absolute path or `..` climb would otherwise let a member attach
 * any file the server can read.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The inbox location relative to the project root, as written by the upload endpoint. */
export const ATTACHMENT_INBOX_SEGMENTS = Object.freeze(['.nassaj-uploads', 'inbox']);

/**
 * @param {string} child absolute real path
 * @param {string} parent absolute real path
 * @returns {boolean} true when `child` is strictly inside `parent`
 */
function isStrictlyInside(child, parent) {
  return child.startsWith(parent + path.sep);
}

/**
 * Resolves a client-supplied attachment reference to the REAL path of a regular file
 * inside the project's attachment inbox, or null when it is not one.
 *
 * Both the inbox and the candidate are run through realpath, so a symlink anywhere on
 * the chain (a symlinked `.nassaj-uploads`, or a link inside the inbox pointing out)
 * is judged by where it really leads. The inbox itself must resolve inside the project
 * root, mirroring the upload endpoint's own guard. Missing files, directories and
 * unreadable chains are refused.
 *
 * @param {string} projectRoot the run's working directory (the project root)
 * @param {unknown} ref the attachment path from the request (cwd-relative or absolute)
 * @returns {string|null} absolute real path safe to hand to the provider, or null
 */
export function resolveInboxAttachment(projectRoot, ref) {
  if (typeof ref !== 'string' || ref.trim() === '' || ref.includes('\0')) {
    return null;
  }
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    return null;
  }
  try {
    const rootAbs = path.resolve(projectRoot);
    const realRoot = fs.realpathSync(rootAbs);
    const realInbox = fs.realpathSync(path.join(rootAbs, ...ATTACHMENT_INBOX_SEGMENTS));
    if (!isStrictlyInside(realInbox, realRoot)) {
      return null;
    }
    const candidate = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(rootAbs, ref);
    const realCandidate = fs.realpathSync(candidate);
    if (!isStrictlyInside(realCandidate, realInbox) || !fs.statSync(realCandidate).isFile()) {
      return null;
    }
    return realCandidate;
  } catch {
    return null;
  }
}
