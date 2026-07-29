#!/usr/bin/env node
/**
 * ensure-wiki-index.mjs (B-303) — make the client build independent of any
 * operator content.
 *
 * `src/components/wiki/wikiContent.ts` imports `docs/team-wiki/index.json`
 * STATICALLY, so the file must exist for vite (and vitest) to resolve the
 * module at all. On this repo's own checkout that path is a symlink into a
 * private governance repository; on every OTHER node — a fleet node, a fresh
 * clone, a contributor's laptop — it simply does not exist, and `npm run build`
 * failed there with a module-not-found that reads like a code error but is a
 * missing-content one. A deployed node sat on a half-built tree for hours
 * because of exactly this (2026-07-29).
 *
 * So: seed an EMPTY, valid index when none is present. The wiki panel then
 * renders empty instead of failing the build — the same neutral seed the public
 * export writes. Never overwrites an existing index: on a node that DOES have
 * the content, this is a no-op and the real pages keep loading.
 *
 * Idempotent, dependency-free, and safe to run from any working directory.
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'docs', 'team-wiki');
const INDEX = path.join(DIR, 'index.json');

if (existsSync(INDEX)) {
  process.exit(0);
}

// mkdir is required, not defensive: docs/team-wiki may be an absent symlink
// target, so nothing else creates the directory on a content-less node.
mkdirSync(DIR, { recursive: true });
writeFileSync(INDEX, '{\n  "pages": []\n}\n');
console.log(`[wiki] seeded an empty ${path.relative(ROOT, INDEX)} (no team-wiki content on this node)`);
