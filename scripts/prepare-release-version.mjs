#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FOUR_PART_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI_UPDATES_PATH = path.join('docs', 'team-wiki', '00-updates.md');

export function validateReleaseVersion(value) {
  if (!FOUR_PART_VERSION.test(value ?? '')) {
    throw new Error('release version must contain exactly four canonical numeric segments (for example 1.41.0.0)');
  }
  const segments = value.split('.').map(Number);
  if (segments.some(segment => !Number.isSafeInteger(segment))) {
    throw new Error('release version segments must be safe integers');
  }
  return value;
}

function parseArgs(argv) {
  let version = null;
  let write = false;
  let requireCurrent = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--version') version = argv[++index] ?? null;
    else if (token === '--write') write = true;
    else if (token === '--require-current') requireCurrent = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (write && requireCurrent) throw new Error('--write and --require-current are mutually exclusive');
  return { version: validateReleaseVersion(version), write, requireCurrent };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Require the human-facing wiki changelog to name the exact release. */
export async function assertReleaseWikiUpdated(root, version) {
  const exactVersion = validateReleaseVersion(version);
  const wikiPath = path.join(root, WIKI_UPDATES_PATH);
  let source;
  try {
    source = await fs.readFile(wikiPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`release wiki page is missing: ${WIKI_UPDATES_PATH}`);
    }
    throw error;
  }
  const escaped = exactVersion.replaceAll('.', '\\.');
  const heading = new RegExp(`^##\\s+الإصدار\\s+${escaped}(?:\\s|$)`, 'm');
  const visibleMarkdown = source.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  if (!heading.test(visibleMarkdown)) {
    throw new Error(`release wiki page must include an entry for ${exactVersion}: ${WIKI_UPDATES_PATH}`);
  }
}

export async function prepareReleaseVersion({ root, version, write = false, requireCurrent = false }) {
  const exactVersion = validateReleaseVersion(version);
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const [packageJson, lockJson] = await Promise.all([
    readJson(packagePath),
    readJson(lockPath),
  ]);
  if (!lockJson.packages?.['']) throw new Error('package-lock.json is missing its root package');

  const previous = {
    packageVersion: packageJson.version,
    lockVersion: lockJson.version,
    lockRootVersion: lockJson.packages[''].version,
  };
  if (requireCurrent) {
    const identities = [packageJson.version, lockJson.version, lockJson.packages[''].version];
    if (!identities.every(value => value === exactVersion)) {
      throw new Error('requested release version does not match the reviewed package and lock identities');
    }
  }
  if (write || requireCurrent) await assertReleaseWikiUpdated(root, exactVersion);
  packageJson.version = exactVersion;
  lockJson.version = exactVersion;
  lockJson.packages[''].version = exactVersion;

  if (write) {
    await writeJson(packagePath, packageJson);
    await writeJson(lockPath, lockJson);
  }
  return {
    ok: true,
    write,
    requireCurrent,
    version: exactVersion,
    tag: `v${exactVersion}`,
    previous,
  };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  // A terminal launched by an immutable release inherits NASSAJ_RELEASE_ROOT.
  // Treating that runtime marker as a CLI destination let `release.sh --write`
  // mutate the sealed active release instead of this source checkout. The
  // release CLI is project-local by contract; a conflicting inherited marker
  // blocks write mode before either package file is opened.
  const inheritedReleaseRoot = process.env.NASSAJ_RELEASE_ROOT
    ? path.resolve(process.env.NASSAJ_RELEASE_ROOT)
    : null;
  if (input.write && inheritedReleaseRoot && inheritedReleaseRoot !== PROJECT_ROOT) {
    throw new Error(
      'refusing release version write: inherited NASSAJ_RELEASE_ROOT points outside this project; ' +
      'run from a clean operator environment'
    );
  }
  const result = await prepareReleaseVersion({ root: PROJECT_ROOT, ...input });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`prepare-release-version: ${error.message}\n`);
    process.exitCode = 2;
  });
}
