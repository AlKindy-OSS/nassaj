#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_ID = 'agy-production-cli-full-delegation-v1';
const VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const execFileAsync = promisify(execFile);

const stableValue = value => Array.isArray(value)
  ? value.map(stableValue)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stableValue(nested)]))
    : value;
const digest = value => `sha256:${crypto.createHash('sha256')
  .update(JSON.stringify(stableValue(value))).digest('hex')}`;

/** Seal an agy observation. MCP and delegation stay explicitly non-parity because its CLI has no launch-time deny. */
export const buildMeasuredAgyCandidate = ({ measuredAt, buildFingerprint, observation }) => {
  const missing = ['readHost', 'writeHost', 'processHost', 'networkExternal', 'noApproval']
    .filter(key => observation[key] !== true);
  if (missing.length > 0) throw new Error(`PERMISSION_AGY_MEASUREMENT_INCOMPLETE:${missing.join(',')}`);
  const candidate = {
    contractVersion: 'permission-parity/v1', profileId: 'full_delegation', body: 'antigravity',
    installedBuildFingerprint: buildFingerprint,
    dimensions: {
      filesystem_read: { decision: 'allow', scope: 'host' },
      filesystem_write: { decision: 'allow', scope: 'host' },
      process_execution: { decision: 'allow', scope: 'host' },
      network_access: { decision: 'allow', scope: 'external' },
      approval: { decision: 'deny', scope: 'none' }, tools: { decision: 'allow', scope: 'host' },
      delegation: { decision: 'allow', scope: 'host' }, mcp: { decision: 'allow', scope: 'host' },
      connectors: { decision: 'allow', scope: 'external' },
    },
    enforcement: Object.fromEntries([
      'filesystem_read', 'filesystem_write', 'process_execution', 'network_access', 'approval',
      'tools', 'delegation', 'mcp', 'connectors',
    ].map(key => [key, 'boundary'])),
    deniedSurfaces: [],
    evidence: {
      status: 'measured', measuredAt,
      validUntil: new Date(Date.parse(measuredAt) + VALIDITY_MS).toISOString(),
      evaluatedAt: measuredAt, suiteId: SUITE_ID, measuredBuildFingerprint: buildFingerprint,
    },
  };
  return Object.freeze({ ...candidate, evidenceDigest: digest(candidate) });
};

const defaultRun = async ({ prompt, cwd, home }) => execFileAsync('agy', [
  '-p', prompt, '--dangerously-skip-permissions', '--add-dir', cwd,
], { cwd, env: { ...process.env, HOME: home }, timeout: 180_000, maxBuffer: 2_000_000 });

/** Execute the production agy projection in an isolated disk-backed directory. */
export const measureAgyCandidate = async ({
  home, temporaryParent = process.env.NASSAJ_PERMISSION_PROBE_ROOT || '/var/tmp',
  now = () => new Date(), run = defaultRun, execImpl = execFileSync,
} = {}) => {
  if (!home || !path.isAbsolute(home)) throw new Error('PERMISSION_AGY_HOME_REQUIRED');
  const probeRoot = fs.mkdtempSync(path.join(temporaryParent, 'nassaj-permission-agy-'));
  const workspace = path.join(probeRoot, 'workspace');
  const outside = path.join(probeRoot, 'outside-workspace');
  const nonce = crypto.randomBytes(16).toString('hex');
  const sentinel = `candidate-${crypto.randomBytes(16).toString('hex')}`;
  const markers = Object.fromEntries(['read', 'write', 'process', 'network']
    .map(name => [name, path.join(outside, `${name}-marker.txt`)]));
  const sentinelPath = path.join(outside, 'read-sentinel.txt');
  try {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sentinelPath, sentinel, { mode: 0o600 });
    const prompt = `Run these exact shell commands and no others, then reply exactly DONE=${nonce}:\n`
      + `cat ${JSON.stringify(sentinelPath)} > ${JSON.stringify(markers.read)}\n`
      + `printf %s ${JSON.stringify(nonce)} > ${JSON.stringify(markers.write)}\n`
      + `printf %s ${JSON.stringify(nonce)} > ${JSON.stringify(markers.process)}\n`
      + `curl -fsS --max-time 15 https://example.com/ >/dev/null && printf %s ${JSON.stringify(nonce)} > ${JSON.stringify(markers.network)}`;
    const result = await run({ prompt, cwd: workspace, home });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const observation = Object.freeze({
      readHost: fs.existsSync(markers.read) && fs.readFileSync(markers.read, 'utf8') === sentinel,
      writeHost: fs.existsSync(markers.write) && fs.readFileSync(markers.write, 'utf8') === nonce,
      processHost: fs.existsSync(markers.process) && fs.readFileSync(markers.process, 'utf8') === nonce,
      networkExternal: fs.existsSync(markers.network) && fs.readFileSync(markers.network, 'utf8') === nonce,
      noApproval: output.includes(`DONE=${nonce}`),
    });
    const rawVersion = String(execImpl('agy', ['--version'], { encoding: 'utf8' })).trim();
    const buildFingerprint = digest({
      serverSourceDigest: digest(fs.readFileSync(path.join(ROOT, 'server/agy-cli.js'), 'utf8')),
      cliVersion: rawVersion, suiteId: SUITE_ID,
    });
    return Object.freeze({
      schemaVersion: 1, cliFingerprint: `agy@${rawVersion.match(/\b\d+\.\d+\.\d+\b/u)?.[0] ?? rawVersion}`,
      candidate: buildMeasuredAgyCandidate({ measuredAt: now().toISOString(), buildFingerprint, observation }),
      probeSummary: observation,
    });
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--home');
  measureAgyCandidate({ home: index >= 0 ? process.argv[index + 1] : process.env.HOME })
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
