#!/usr/bin/env node
import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

const scratch = process.argv[2];
const repositoryRoot = realpathSync(process.cwd());

function fail(message) {
  process.stderr.write(`cleanup-test-scratch: ${message}\n`);
  process.exit(64);
}

if (!scratch) fail('an exact scratch path is required');

const resolvedScratch = path.resolve(scratch);
if (path.dirname(resolvedScratch) !== repositoryRoot
  || !/^\.test-scripts-scratch\.[A-Za-z0-9]{6}$/.test(path.basename(resolvedScratch))) {
  fail('refusing to clean a path outside the owned test:scripts scratch contract');
}

const rootMetadata = lstatSync(resolvedScratch);
if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
  fail('the owned scratch root must be a real directory');
}

function restoreOwnerPermissions(entry) {
  const metadata = lstatSync(entry);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  chmodSync(entry, metadata.mode | 0o700);
  for (const child of readdirSync(entry)) restoreOwnerPermissions(path.join(entry, child));
}

restoreOwnerPermissions(resolvedScratch);
rmSync(resolvedScratch, { recursive: true, force: true });
