/**
 * Pure helpers of the ADR-173 P0 shared-resume proof (scripts/prove-claude-shared-resume.mjs):
 * the CLI's project-dir encoding, the per-turn invariants, and the mode verdict.
 */
import fs from 'node:fs';
import path from 'node:path';

import { SHARED_RESUME_CHECKS } from '../server/services/isolation/claude-shared-resume-proof.js';

/** The CLI's project-dir name for a cwd: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-');
}

/** Non-empty line count of a file. */
export function lineCount(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

/**
 * The writer-side links of a mode and where each must point.
 * @param {'file_link'|'dir_link'} mode
 * @param {{writerDir: string, creatorDir: string, sessionId: string}} layout
 * @returns {Array<{link: string, target: string}>}
 */
export function expectedLinks(mode, { writerDir, creatorDir, sessionId }) {
  if (mode === 'dir_link') return [{ link: writerDir, target: creatorDir }];
  return [
    { link: path.join(writerDir, `${sessionId}.jsonl`), target: path.join(creatorDir, `${sessionId}.jsonl`) },
    { link: path.join(writerDir, sessionId), target: path.join(creatorDir, sessionId) },
  ];
}

/** True when every expected link is still a symlink to its target. */
export function linksIntact(links) {
  return links.every(({ link, target }) => {
    try {
      return fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target;
    } catch {
      return false;
    }
  });
}

/**
 * Invariants after one resumed turn.
 * @param {{result: {sessionId?: string, isError?: boolean}, sessionId: string, recorded: string,
 *   inode: number, linesBefore: number, links: Array<{link: string, target: string}>}} input
 */
export function turnInvariants({ result, sessionId, recorded, inode, linesBefore, links }) {
  const stat = fs.statSync(recorded);
  const lines = lineCount(recorded);
  return {
    sameSession: result.sessionId === sessionId && !result.isError,
    appended: lines > linesBefore,
    inodeStable: stat.ino === inode,
    linksIntact: linksIntact(links),
    lines,
    inode: stat.ino,
  };
}

/** Files (recursively) under a dir whose name matches `pattern`; [] when absent. */
export function filesUnder(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The mode's check verdicts from the turn records; a check never observed is `unproven`.
 * @param {Record<string, 'pass'|'fail'|'unproven'>} observed
 */
export function modeVerdict(observed) {
  return Object.fromEntries(SHARED_RESUME_CHECKS.map((check) => [check, observed[check] ?? 'unproven']));
}
