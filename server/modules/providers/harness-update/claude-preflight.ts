/**
 * Pre-run facts of the claude install (ADR-215 stage B), read from the file
 * system only and before any download, lease or child process:
 *
 *   - systemCopy (owner decision 2): `/usr/bin/claude` or `/usr/local/bin/claude`
 *     exists. The user-level install is still allowed after the owner reads a
 *     warning; nothing is deleted.
 *   - npmRemoval (measured 2026-10-20): `claude install` runs
 *     `npm uninstall --global @anthropic-ai/claude-code`. When an npm-global
 *     claude sits under a prefix this uid can write, the owner must confirm
 *     its removal first.
 *
 * Both reuse the server-built acknowledgement dialog of ADR-159
 * (409 CONFIRMATION_REQUIRED, single-use tokens bound to the facts).
 */

import fs from 'node:fs';
import path from 'node:path';

/** System locations a fleet bootstrap may have used. */
export const SYSTEM_CLAUDE_PATHS: readonly string[] = Object.freeze(['/usr/bin/claude', '/usr/local/bin/claude']);

/** node locations on the installer's fixed PATH (/usr/local/bin:/usr/bin:/bin). */
const NODE_CANDIDATES: readonly string[] = Object.freeze(['/usr/local/bin/node', '/usr/bin/node', '/bin/node']);

const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The system claude copies that exist (lstat; a dangling link counts). */
export function existingSystemCopies(paths: readonly string[] = SYSTEM_CLAUDE_PATHS): string[] {
  return paths.filter(exists);
}

/** `prefix=` of ~/.npmrc (the installer env passes no npm_config_*), or null. */
export function npmrcPrefix(home: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, '.npmrc'), 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split('\n')) {
    const match = /^\s*prefix\s*=\s*(.+?)\s*$/u.exec(raw);
    if (!match) continue;
    const value = match[1].replace(/^["']|["']$/gu, '').replace(/^~(?=\/)/u, home).replace(/\$\{HOME\}/gu, home);
    return path.isAbsolute(value) ? value : null;
  }
  return null;
}

/**
 * Global prefixes the vendor's `npm uninstall --global` may act on: the
 * ~/.npmrc prefix, then npm's built-in default (the prefix of the node it
 * runs under) for every node on the fixed PATH.
 */
export function npmGlobalPrefixes(home: string, nodeCandidates: readonly string[] = NODE_CANDIDATES): string[] {
  const prefixes: string[] = [];
  const configured = npmrcPrefix(home);
  if (configured) prefixes.push(configured);
  for (const node of nodeCandidates) {
    try {
      prefixes.push(path.dirname(path.dirname(fs.realpathSync(node))));
    } catch {
      /* absent */
    }
  }
  return [...new Set(prefixes)];
}

/** The npm-global claude package `claude install` would remove, or null. */
export function detectNpmGlobalClaude(prefixes: readonly string[]): { packageDir: string } | null {
  for (const prefix of prefixes) {
    const packageDir = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    if (!exists(packageDir)) continue;
    try {
      fs.accessSync(path.dirname(packageDir), fs.constants.W_OK);
      return { packageDir };
    } catch {
      /* not writable by this uid: npm cannot remove it */
    }
  }
  return null;
}
