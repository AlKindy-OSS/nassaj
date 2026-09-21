#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_DIRECTORIES = new Set([
  '.git',
  'coverage',
  'dist',
  'dist-server',
  'node_modules',
]);
const CRASH_ARTIFACT = /^(?:core(?:\.\d+)?|.*\.core)$/;
const rootArg = process.argv.find((argument) => argument.startsWith('--root='));

function resolveDefaultRoot() {
  try {
    const commonGitDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return path.dirname(commonGitDir);
  } catch {
    return process.cwd();
  }
}

const scanRoot = path.resolve(rootArg ? rootArg.slice('--root='.length) : resolveDefaultRoot());
const artifacts = [];

/** Walk the repository without following symlinks or entering generated trees. */
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walk(target);
      continue;
    }
    if (!entry.isFile() || !CRASH_ARTIFACT.test(entry.name)) continue;
    const stat = fs.statSync(target);
    artifacts.push({
      path: path.relative(scanRoot, target) || entry.name,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
}

const rootStat = fs.lstatSync(scanRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error(`Crash artifact scan root must be a real directory: ${scanRoot}`);
}

walk(scanRoot);

const filesystem = fs.statfsSync(scanRoot);
const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
const availablePercent = totalBytes === 0 ? 0 : (availableBytes / totalBytes) * 100;
const pressure = availableBytes < 10 * 1024 ** 3 || availablePercent < 15;
const report = {
  ok: artifacts.length === 0,
  scanRoot,
  artifacts,
  disk: {
    availableBytes,
    availablePercent: Number(availablePercent.toFixed(2)),
    pressure,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (artifacts.length > 0) process.exitCode = 1;
