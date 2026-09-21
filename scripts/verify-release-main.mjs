#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoGitlinks } from './no-gitlinks.mjs';

const REVIEWED_REF = 'refs/heads/main';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function authenticatedFetchArgs() {
  if (process.env.NASSAJ_RELEASE_GIT_AUTH !== 'gh') {
    return ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'];
  }
  if (!process.env.GH_TOKEN) {
    throw new Error('governed release read credential is unavailable');
  }
  return [
    '-c', "credential.helper=!gh auth git-credential",
    'fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main',
  ];
}

/**
 * Prove that this dispatch runs on the exact commit currently published as
 * origin/main, and that the commit carries no submodule (ADR-156 G1). The
 * gitlink check runs here too, not only in `npm run test:scripts`, because
 * release.yml calls this file three times — before, during and after the build.
 */
export function verifyReleaseMain({ root, ref }) {
  if (ref !== REVIEWED_REF) {
    throw new Error(`release dispatch must run from ${REVIEWED_REF}`);
  }
  assertNoGitlinks(root);
  git(root, authenticatedFetchArgs());
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const originMain = git(root, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  if (head !== originMain) {
    throw new Error('release HEAD does not match the freshly fetched origin/main commit');
  }
  return { ok: true, ref, head, originMain, gitlinks: 'none' };
}

function main() {
  const root = path.resolve(process.env.NASSAJ_RELEASE_ROOT || process.cwd());
  const result = verifyReleaseMain({ root, ref: process.env.GITHUB_REF });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`verify-release-main: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
