#!/usr/bin/env node
/**
 * Writes the reviewed tree manifest of an npm-lock harness pin (T-2086 S4).
 *
 * Usage (reviewer, once per new pin; never at runtime):
 *   node scripts/harness-lock-manifest.mjs <harness> <pkg> <bin-rel> <lock-dir> <installed-dir>
 *
 *   <lock-dir>       server/harness-locks/<harness>/<version> holding the reviewed
 *                    package.json + package-lock.json
 *   <installed-dir>  a fresh `npm ci --ignore-scripts` of exactly those two files
 *                    (made under /var/tmp, deleted afterwards)
 *
 * Output: <lock-dir>/tree-manifest.json and <lock-dir>/licenses.json.
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildPinManifest } from '../server/modules/providers/harness-update/npm-lock/tree-manifest.js';

const [harness, pkg, binRel, lockDir, installedDir] = process.argv.slice(2);
if (!harness || !pkg || !binRel || !lockDir || !installedDir) {
  process.stderr.write('usage: harness-lock-manifest.mjs <harness> <pkg> <bin-rel> <lock-dir> <installed-dir>\n');
  process.exit(2);
}

const lockBytes = fs.readFileSync(path.join(lockDir, 'package-lock.json'));
for (const name of ['package.json', 'package-lock.json']) {
  if (!fs.readFileSync(path.join(installedDir, name)).equals(fs.readFileSync(path.join(lockDir, name)))) {
    process.stderr.write(`${name} of the installed tree differs from the reviewed one\n`);
    process.exit(1);
  }
}
const lock = JSON.parse(lockBytes.toString('utf8'));
const manifest = await buildPinManifest({ harness, pkg, binRel, installedDir, lockBytes });
fs.writeFileSync(path.join(lockDir, 'tree-manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
const keys = Object.keys(manifest.packages).filter((key) => key !== '');

const licenses = {};
for (const key of keys.sort()) {
  const meta = lock.packages[key];
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  licenses[`${name}@${meta.version}`] = meta.license ?? 'UNKNOWN';
}
fs.writeFileSync(path.join(lockDir, 'licenses.json'), `${JSON.stringify(licenses, null, 1)}\n`);
process.stdout.write(`${harness} ${manifest.version}: ${manifest.fileCount} files, `
  + `${manifest.totalBytes} bytes, tree ${manifest.treeSha256}\n`);
