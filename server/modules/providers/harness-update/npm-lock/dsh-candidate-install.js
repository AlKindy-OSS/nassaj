/**
 * dsh-candidate-install — installs ONE exact dsh candidate for the update pipeline (T-2091).
 * A fresh package.json naming `@deepseek-ai/dsh@<exact version>` (never a tag or a range),
 * `npm install --ignore-scripts --save-exact` with the cache, HOME and TMPDIR inside the
 * pipeline's staging dir (Nassaj data, never tmpfs, never a member tree). Returns the generated
 * lockfile and package.json; the pipeline derives and keeps the full-tree manifest.
 */
import fs from 'node:fs';
import path from 'node:path';

import { npmCliBesideNode } from './pins.js';

const PKG = '@deepseek-ai/dsh';
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** A refusal the pipeline records as the held code. */
const refused = (code) => Object.assign(new Error(code), { code });

/** The argv of the candidate install (exported for review and tests). */
export function dshCandidateInstallArgv(node, cacheDir) {
  return [npmCliBesideNode(node), 'install', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund',
    '--no-update-notifier', '--cache', cacheDir];
}

/**
 * @param {{ version: string, dir: string, cacheDir: string }} job
 * @param {{ node: string, runCommand: (cmd: string, args: string[], opts: any) => Promise<{ code: number|null, timedOut?: boolean }>,
 *   buildEnv: (home: string) => NodeJS.ProcessEnv, timeoutMs?: number }} deps
 */
export async function installDshCandidate({ version, dir, cacheDir }, { node, runCommand, buildEnv, timeoutMs = 10 * 60 * 1000 }) {
  if (!EXACT_VERSION.test(version)) throw refused('dsh_update_version_not_pinned');
  const packageJson = `${JSON.stringify({ name: 'nassaj-dsh-candidate', private: true, version: '0.0.0',
    dependencies: { [PKG]: version } }, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'package.json'), packageJson, { flag: 'wx' });
  const tmp = path.join(path.dirname(cacheDir), 'tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const env = { ...buildEnv(path.dirname(cacheDir)), HOME: path.dirname(cacheDir), TMPDIR: tmp,
    PATH: `${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin` };
  const result = await runCommand(node, dshCandidateInstallArgv(node, cacheDir), { env, cwd: dir, timeoutMs });
  if (result.timedOut || result.code !== 0) throw refused('dsh_update_install_failed');
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  } catch {
    throw refused('dsh_update_install_failed');
  }
  if (installed !== version) throw refused('dsh_update_install_failed');
  const lock = fs.readFileSync(path.join(dir, 'package-lock.json'));
  return { lock, packageJson: Buffer.from(packageJson) };
}
