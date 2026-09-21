/**
 * ADR-156 WI-6 (T-1718) — the identity of the build this process actually RAN.
 *
 * The whole point of B-1055 is that `package.json` in the working tree stops
 * describing the running server the moment `git checkout` stages a release. The
 * answer lives in the provenance of the artefact that was LOADED, so this
 * module reads `dist-server/BUILD_PROVENANCE.json` — and only when this process
 * is genuinely running out of `dist-server`. Under `tsx` the same file on disk
 * describes a build that is NOT running, and reporting it would restate the
 * very lie the work item exists to end.
 *
 * "Is this process running from dist-server?" is answered by where THIS module
 * resolved from, so no caller has to know its own depth in the tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FIELD_LEN = 200;

/** True when this module was loaded out of `<appRoot>/dist-server`. */
export function isRunningFromDistServer(appRoot, moduleUrl = import.meta.url) {
  try {
    return path.dirname(fileURLToPath(moduleUrl))
      === path.join(appRoot, 'dist-server', 'server', 'services');
  } catch {
    return false;
  }
}

/** One short, printable provenance field, or null when unreadable/implausible. */
function readProvenanceText(file, field) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.[field];
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LEN
      ? value : null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ runtimeVersion: string|null, runtimeCommit: string|null }}
 *   Both null when this process is not running the built artefact.
 */
export function readRuntimeIdentity(appRoot, moduleUrl = import.meta.url) {
  if (!isRunningFromDistServer(appRoot, moduleUrl)) {
    return { runtimeVersion: null, runtimeCommit: null };
  }
  const provenance = path.join(appRoot, 'dist-server', 'BUILD_PROVENANCE.json');
  return {
    runtimeVersion: readProvenanceText(provenance, 'version'),
    runtimeCommit: readProvenanceText(provenance, 'commit'),
  };
}
