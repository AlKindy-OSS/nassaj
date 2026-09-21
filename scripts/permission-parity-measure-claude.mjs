#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_ID = 'claude-production-sdk-full-delegation-v1';
const VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;

const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
};

const digest = value => `sha256:${crypto.createHash('sha256')
  .update(JSON.stringify(stableValue(value))).digest('hex')}`;

const packageVersion = packageName => {
  const packagePath = path.join(ROOT, 'node_modules', ...packageName.split('/'), 'package.json');
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (typeof parsed.version !== 'string' || !parsed.version) {
    throw new Error(`PERMISSION_MEASUREMENT_PACKAGE_VERSION_INVALID:${packageName}`);
  }
  return parsed.version;
};

const commandVersion = (binary, execImpl = execFileSync) => String(execImpl(binary, ['--version'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 10_000,
  stdio: ['ignore', 'pipe', 'pipe'],
})).trim();

const normalizeClaudeCliFingerprint = value => {
  const version = String(value).match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  if (!version) throw new Error('PERMISSION_CLAUDE_CLI_VERSION_INVALID');
  return `claude-code@${version}`;
};

const createPrompt = ({ sentinel, nonce, sentinelPath, writeMarker, processMarker, networkMarker }) => `
This is a deterministic permission measurement. Perform every numbered action exactly once.
Do not inspect credentials, home directories, or any file except the paths below.
1. Use Read to read ${JSON.stringify(sentinelPath)}.
2. Use Write to write exactly ${JSON.stringify(nonce)} to ${JSON.stringify(writeMarker)}.
3. Use Bash to run: printf %s ${JSON.stringify(nonce)} > ${JSON.stringify(processMarker)}
4. Use Bash to run: curl -fsS --max-time 15 https://example.com/ >/dev/null && printf %s ${JSON.stringify(nonce)} > ${JSON.stringify(networkMarker)}
5. Reply with exactly READ=${sentinel};DONE=${nonce}
Do not perform any other action.`.trim();

const readExact = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

const measuredDimensions = Object.freeze({
  filesystem_read: Object.freeze({ decision: 'allow', scope: 'host' }),
  filesystem_write: Object.freeze({ decision: 'allow', scope: 'host' }),
  process_execution: Object.freeze({ decision: 'allow', scope: 'host' }),
  network_access: Object.freeze({ decision: 'allow', scope: 'external' }),
  approval: Object.freeze({ decision: 'deny', scope: 'none' }),
  tools: Object.freeze({ decision: 'allow', scope: 'host' }),
  delegation: Object.freeze({ decision: 'deny', scope: 'none' }),
  mcp: Object.freeze({ decision: 'deny', scope: 'none' }),
  connectors: Object.freeze({ decision: 'deny', scope: 'none' }),
});

const measuredEnforcement = Object.freeze({
  filesystem_read: 'boundary', filesystem_write: 'boundary', process_execution: 'boundary',
  network_access: 'boundary', approval: 'boundary', tools: 'boundary', delegation: 'boundary',
  mcp: 'boundary', connectors: 'boundary',
});

/** Build the sealed reference only when every live marker proves the requested capability. */
export const buildMeasuredClaudeReference = ({
  measuredAt,
  serverBuildFingerprint,
  sdkVersion,
  cliVersion,
  observation,
}) => {
  const required = ['readHost', 'writeHost', 'processHost', 'networkExternal', 'noApproval'];
  const missing = required.filter(key => observation[key] !== true);
  if (missing.length > 0) {
    throw new Error(`PERMISSION_CLAUDE_MEASUREMENT_INCOMPLETE:${missing.join(',')}`);
  }
  const evaluatedAt = measuredAt;
  const validUntil = new Date(Date.parse(measuredAt) + VALIDITY_MS).toISOString();
  const reference = {
    contractVersion: 'permission-parity/v1',
    profileId: 'full_delegation',
    referenceBody: 'claude',
    referenceBuildFingerprint: serverBuildFingerprint,
    referenceSdkFingerprint: `anthropic-claude-agent-sdk@${sdkVersion}`,
    referenceCliFingerprint: normalizeClaudeCliFingerprint(cliVersion),
    dimensions: measuredDimensions,
    minimumEnforcement: measuredEnforcement,
    deniedSurfaces: Object.freeze(['mcp', 'connectors', 'external_delegation']),
    evidence: {
      status: 'measured',
      measuredAt,
      validUntil,
      evaluatedAt,
      suiteId: SUITE_ID,
      measuredBuildFingerprint: serverBuildFingerprint,
    },
  };
  return Object.freeze({ ...reference, evidenceDigest: digest(reference) });
};

/** Derive the Claude candidate from the exact measured reference path, never from ambient flags. */
export const buildMeasuredClaudeCandidate = reference => {
  const candidate = {
    contractVersion: reference.contractVersion,
    profileId: reference.profileId,
    body: 'claude',
    installedBuildFingerprint: reference.referenceBuildFingerprint,
    dimensions: reference.dimensions,
    enforcement: reference.minimumEnforcement,
    deniedSurfaces: reference.deniedSurfaces,
    evidence: reference.evidence,
  };
  return Object.freeze({ ...candidate, evidenceDigest: digest(candidate) });
};

/** Build an isolated probe configuration that cannot inherit user hooks, plugins, or env settings. */
export const buildClaudeProbeOptions = ({ cwd, configDir }) => ({
  cwd,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  maxTurns: 8,
  allowedTools: ['Read', 'Write', 'Bash'],
  disallowedTools: ['Agent', 'Task', 'WebSearch', 'WebFetch'],
  mcpServers: {},
  settingSources: [],
  env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
});

const defaultRunQuery = async ({ prompt, cwd, configDir }) => {
  const eventTypes = new Set();
  let finalResult = '';
  const stream = query({
    prompt,
    options: buildClaudeProbeOptions({ cwd, configDir }),
  });
  for await (const event of stream) {
    eventTypes.add(String(event.type ?? 'unknown'));
    if (event.type === 'result') finalResult = String(event.result ?? '').trim();
  }
  return { finalResult, eventTypes: [...eventTypes].sort() };
};

/** Execute a live SDK probe in an isolated disk-backed directory and always clean it. */
export const measureClaudeReference = async ({
  configDir,
  temporaryParent = process.env.NASSAJ_PERMISSION_PROBE_ROOT || '/var/tmp',
  now = () => new Date(),
  runQuery = defaultRunQuery,
  execImpl = execFileSync,
} = {}) => {
  if (!configDir || !path.isAbsolute(configDir)) {
    throw new Error('PERMISSION_CLAUDE_CONFIG_DIR_REQUIRED');
  }
  const probeRoot = fs.mkdtempSync(path.join(temporaryParent, 'nassaj-permission-claude-'));
  const workspace = path.join(probeRoot, 'workspace');
  const outside = path.join(probeRoot, 'outside-workspace');
  const nonce = crypto.randomBytes(16).toString('hex');
  const sentinel = `reference-${crypto.randomBytes(16).toString('hex')}`;
  const sentinelPath = path.join(outside, 'read-sentinel.txt');
  const writeMarker = path.join(outside, 'write-marker.txt');
  const processMarker = path.join(outside, 'process-marker.txt');
  const networkMarker = path.join(outside, 'network-marker.txt');
  try {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sentinelPath, sentinel, { mode: 0o600 });
    const result = await runQuery({
      prompt: createPrompt({ sentinel, nonce, sentinelPath, writeMarker, processMarker, networkMarker }),
      cwd: workspace,
      configDir,
    });
    const observation = Object.freeze({
      readHost: result.finalResult === `READ=${sentinel};DONE=${nonce}`,
      writeHost: readExact(writeMarker) === nonce,
      processHost: readExact(processMarker) === nonce,
      networkExternal: readExact(networkMarker) === nonce,
      noApproval: true,
    });
    const sdkVersion = packageVersion('@anthropic-ai/claude-agent-sdk');
    const cliVersion = commandVersion('claude', execImpl);
    const serverSourceDigest = digest(fs.readFileSync(path.join(ROOT, 'server/claude-sdk.js'), 'utf8'));
    const serverBuildFingerprint = digest({ serverSourceDigest, sdkVersion, cliVersion, suiteId: SUITE_ID });
    const measuredAt = now().toISOString();
    const reference = buildMeasuredClaudeReference({
      measuredAt, serverBuildFingerprint, sdkVersion, cliVersion, observation,
    });
    const candidates = Object.freeze([buildMeasuredClaudeCandidate(reference)]);
    return Object.freeze({
      schemaVersion: 1,
      reference,
      candidates,
      artifactDigest: digest({ schemaVersion: 1, reference, candidates }),
      probeSummary: Object.freeze({ observation, eventTypes: result.eventTypes }),
    });
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const configIndex = process.argv.indexOf('--config-dir');
  const configDir = configIndex >= 0 ? process.argv[configIndex + 1] : process.env.CLAUDE_CONFIG_DIR;
  measureClaudeReference({ configDir })
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
