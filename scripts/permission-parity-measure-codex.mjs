#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Codex } from '@openai/codex-sdk';
import { readCodexExecutableIdentity, codexLaunchOptions } from '../server/shared/codex-executable.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_ID = 'codex-production-sdk-full-delegation-v1';
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

const packageVersion = (packageName, packageRoot = ROOT) => {
  const packagePath = path.join(packageRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
};

const commandVersion = (binary, execImpl = execFileSync) => String(execImpl(binary, ['--version'], {
  cwd: ROOT, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
})).trim();

const shellQuote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

export const readInstalledIdentity = (execImpl = execFileSync, runtime = { root: ROOT, readNative: readCodexExecutableIdentity, sdkVersion: packageVersion('@openai/codex-sdk') }) => {
  const { executablePath, pathDirs, ...nativeIdentity } = runtime.readNative();
  return {
    executablePath, pathDirs,
    serverSourceDigest: digest(fs.readFileSync(path.join(runtime.root, 'server/openai-codex.js'), 'utf8')),
    sdkVersion: runtime.sdkVersion,
    cliVersion: commandVersion(executablePath, execImpl),
    suiteId: SUITE_ID, ...nativeIdentity,
  };
};
export const identityDigest = ({ executablePath: _path, pathDirs: _dirs, ...identity }) => digest(identity);

/** Load measurement identity and SDK from the exact reviewed compiled runtime root. */
export async function resolveMeasurementRuntime(runtimeRoot) {
  const root = fs.realpathSync(runtimeRoot);
  const helper = await import(pathToFileURL(path.join(root, 'server/shared/codex-executable.js')).href);
  const sdkEntry = helper.resolveCodexSdkEntry();
  let directory = path.dirname(sdkEntry);
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('PERMISSION_CODEX_SDK_PACKAGE_MISSING');
    directory = parent;
  }
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (sdkPackage.name !== '@openai/codex-sdk') throw new Error('PERMISSION_CODEX_SDK_PACKAGE_INVALID');
  const { Codex: RuntimeCodex } = await import(pathToFileURL(sdkEntry).href);
  return { root, readNative: helper.readCodexExecutableIdentity, sdkVersion: sdkPackage.version, RuntimeCodex, launchOptions: helper.codexLaunchOptions };
}

const normalizeCliFingerprint = value => {
  const version = String(value).match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  if (!version) throw new Error('PERMISSION_CODEX_CLI_VERSION_INVALID');
  return `codex-cli@${version}`;
};

const dimensions = Object.freeze({
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

const enforcement = Object.freeze({
  filesystem_read: 'boundary', filesystem_write: 'boundary', process_execution: 'boundary',
  network_access: 'boundary', approval: 'boundary', tools: 'boundary', delegation: 'boundary',
  mcp: 'boundary', connectors: 'boundary',
});

/** Seal a measured Codex candidate only after every live marker succeeds. */
export const buildMeasuredCodexCandidate = ({
  measuredAt, buildFingerprint, observation,
}) => {
  const missing = ['readHost', 'writeHost', 'processHost', 'networkExternal', 'noApproval']
    .filter(key => observation[key] !== true);
  if (missing.length > 0) throw new Error(`PERMISSION_CODEX_MEASUREMENT_INCOMPLETE:${missing.join(',')}`);
  const candidate = {
    contractVersion: 'permission-parity/v1',
    profileId: 'full_delegation',
    body: 'codex',
    installedBuildFingerprint: buildFingerprint,
    dimensions,
    enforcement,
    deniedSurfaces: Object.freeze(['mcp', 'connectors', 'external_delegation']),
    evidence: {
      status: 'measured',
      measuredAt,
      validUntil: new Date(Date.parse(measuredAt) + VALIDITY_MS).toISOString(),
      evaluatedAt: measuredAt,
      suiteId: SUITE_ID,
      measuredBuildFingerprint: buildFingerprint,
    },
  };
  return Object.freeze({ ...candidate, evidenceDigest: digest(candidate) });
};

export const defaultRunTurn = async ({ prompt, cwd, codexHome, executablePath, pathDirs, RuntimeCodex = Codex, launchOptions = codexLaunchOptions }) => {
  const codex = new RuntimeCodex({
    ...launchOptions({ ...process.env, CODEX_HOME: codexHome }, { executablePath, pathDirs }),
    config: { project_doc_max_bytes: 0, 'features.multi_agent': false, mcp_servers: {} },
  });
  const thread = codex.startThread({
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    webSearchEnabled: false,
    webSearchMode: 'disabled',
  });
  const result = await thread.run(prompt);
  return { finalResponse: String(result.finalResponse ?? '').trim() };
};

/** Execute the Codex production-SDK projection in an isolated disk-backed directory. */
export const measureCodexCandidate = async ({
  codexHome,
  temporaryParent = process.env.NASSAJ_PERMISSION_PROBE_ROOT || '/var/tmp',
  now = () => new Date(),
  runTurn = defaultRunTurn,
  execImpl = execFileSync,
  readIdentity,
  runtimeRoot,
  expectedFingerprint,
} = {}) => {
  if (!codexHome || !path.isAbsolute(codexHome)) throw new Error('PERMISSION_CODEX_HOME_REQUIRED');
  if (runTurn === defaultRunTurn && (!runtimeRoot || !path.isAbsolute(runtimeRoot))) throw new Error('PERMISSION_CODEX_RUNTIME_ROOT_REQUIRED');
  if (runTurn === defaultRunTurn && !/^sha256:[a-f0-9]{64}$/u.test(expectedFingerprint || '')) {
    throw new Error('PERMISSION_CODEX_REVIEWED_FINGERPRINT_REQUIRED');
  }
  const runtime = await resolveMeasurementRuntime(runtimeRoot || ROOT);
  const measureIdentity = readIdentity || (() => readInstalledIdentity(execImpl, runtime));
  const identityBefore = measureIdentity();
  const fingerprintBefore = identityDigest(identityBefore);
  if (expectedFingerprint && expectedFingerprint !== fingerprintBefore) throw new Error('PERMISSION_CODEX_REVIEWED_FINGERPRINT_MISMATCH');
  normalizeCliFingerprint(identityBefore.cliVersion);
  const probeRoot = fs.mkdtempSync(path.join(temporaryParent, 'nassaj-permission-codex-'));
  const workspace = path.join(probeRoot, 'workspace');
  const outside = path.join(probeRoot, 'outside-workspace');
  const nonce = crypto.randomBytes(16).toString('hex');
  const sentinel = `candidate-${crypto.randomBytes(16).toString('hex')}`;
  const sentinelPath = path.join(outside, 'read-sentinel.txt');
  const readMarker = path.join(outside, 'read-marker.txt');
  const writeMarker = path.join(outside, 'write-marker.txt');
  const processMarker = path.join(outside, 'process-marker.txt');
  const networkMarker = path.join(outside, 'network-marker.txt');
  try {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sentinelPath, sentinel, { mode: 0o600 });
    const prompt = `Run these exact shell commands and no others, then reply exactly DONE=${nonce}:\n`
      + `cat ${shellQuote(sentinelPath)} > ${shellQuote(readMarker)}\n`
      + `printf %s ${shellQuote(nonce)} > ${shellQuote(writeMarker)}\n`
      + `printf %s ${shellQuote(nonce)} > ${shellQuote(processMarker)}\n`
      + `curl -fsS --max-time 15 https://example.com/ >/dev/null && printf %s ${shellQuote(nonce)} > ${shellQuote(networkMarker)}`;
    const result = await runTurn({ prompt, cwd: workspace, codexHome, executablePath: identityBefore.executablePath, pathDirs: identityBefore.pathDirs, RuntimeCodex: runtime.RuntimeCodex, launchOptions: runtime.launchOptions });
    const observation = Object.freeze({
      readHost: fs.existsSync(readMarker) && fs.readFileSync(readMarker, 'utf8') === sentinel,
      writeHost: fs.existsSync(writeMarker) && fs.readFileSync(writeMarker, 'utf8') === nonce,
      processHost: fs.existsSync(processMarker) && fs.readFileSync(processMarker, 'utf8') === nonce,
      networkExternal: fs.existsSync(networkMarker) && fs.readFileSync(networkMarker, 'utf8') === nonce,
      noApproval: result.finalResponse === `DONE=${nonce}`,
    });
    const identityAfter = measureIdentity();
    if (fs.realpathSync(runtimeRoot || ROOT) !== runtime.root || identityDigest(identityAfter) !== fingerprintBefore) {
      throw new Error('PERMISSION_CODEX_IDENTITY_CHANGED_DURING_MEASUREMENT');
    }
    const { sdkVersion, cliVersion: rawCliVersion } = identityBefore;
    const buildFingerprint = fingerprintBefore;
    const candidate = buildMeasuredCodexCandidate({
      measuredAt: now().toISOString(), buildFingerprint, observation,
    });
    return Object.freeze({
      schemaVersion: 1,
      sdkFingerprint: `openai-codex-sdk@${sdkVersion}`,
      cliFingerprint: normalizeCliFingerprint(rawCliVersion),
      candidate,
      probeSummary: observation,
    });
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
};

const EXPECTED_BODIES = Object.freeze(['claude', 'codex', 'cursor', 'antigravity',
  'opencode', 'kimi', 'deepseek', 'glm', 'hermes', 'qwen', 'sakana']);

const artifactPayload = ({ schemaVersion, reference, candidates, unavailableBodies }) =>
  ({ schemaVersion, reference, candidates, unavailableBodies });

/** Load pure validation functions from the already reviewed compiled runtime. */
export async function loadMeasurementValidators(runtimeRoot) {
  const base = path.join(fs.realpathSync(runtimeRoot), 'server/modules/execution-permissions');
  const validation = await import(pathToFileURL(path.join(base, 'validation.js')).href);
  const parity = await import(pathToFileURL(path.join(base, 'parity.js')).href);
  return { ...validation, ...parity };
}

const validUnavailable = record => record &&
  Object.keys(record).sort().join(',') === 'body,observedAt,reasonCode'
  && EXPECTED_BODIES.includes(record.body)
  && /^[A-Z][A-Z0-9_]{2,63}$/u.test(record.reasonCode)
  && Number.isFinite(Date.parse(record.observedAt))
  && new Date(record.observedAt).toISOString() === record.observedAt;

function validateIntegrationArtifact(artifact, expectedDigest, validators) {
  if (!artifact || artifact.schemaVersion !== 1 || !Array.isArray(artifact.candidates)
    || !Array.isArray(artifact.unavailableBodies)
    || Object.keys(artifact).sort().join(',') !== 'artifactDigest,candidates,reference,schemaVersion,unavailableBodies'
    || artifact.artifactDigest !== expectedDigest || digest(artifactPayload(artifact)) !== expectedDigest
    || !validators.validateClaudeReferenceVector(artifact.reference)
    || validators.computeReferenceEvidenceDigest(artifact.reference) !== artifact.reference.evidenceDigest
    || artifact.candidates.some(candidate => !validators.validatePermissionCandidateVector(candidate)
      || validators.computeCandidateEvidenceDigest(candidate) !== candidate.evidenceDigest)
    || artifact.unavailableBodies.some(record => !validUnavailable(record))) {
    throw new Error('PERMISSION_CODEX_INTEGRATION_ARTIFACT_INVALID');
  }
  const bodies = [...artifact.candidates, ...artifact.unavailableBodies].map(record => record.body);
  if (bodies.length !== EXPECTED_BODIES.length || new Set(bodies).size !== bodies.length
    || bodies.some(body => !EXPECTED_BODIES.includes(body))
    || !artifact.candidates.some(candidate => candidate.body === 'codex')) {
    throw new Error('PERMISSION_CODEX_INTEGRATION_CLASSIFICATION_INVALID');
  }
}

function validateIntegrationMeasurement(measurement, reviewed, validators, reference, now) {
  const candidate = measurement?.candidate;
  const evaluatedAt = new Date(now).toISOString();
  if (measurement?.schemaVersion !== 1
    || !['readHost', 'writeHost', 'processHost', 'networkExternal', 'noApproval']
      .every(key => measurement.probeSummary?.[key] === true)
    || !/^sha256:[a-f0-9]{64}$/u.test(reviewed?.expectedFingerprint || '')
    || !/^openai-codex-sdk@\d+\.\d+\.\d+$/u.test(measurement.sdkFingerprint || '')
    || !/^codex-cli@\d+\.\d+\.\d+$/u.test(measurement.cliFingerprint || '')
    || measurement.sdkFingerprint !== reviewed.registry?.sdkFingerprint
    || measurement.cliFingerprint !== reviewed.registry?.cliFingerprint
    || reviewed.registry?.buildFingerprint !== reviewed.expectedFingerprint
    || !validators.validatePermissionCandidateVector(candidate)
    || candidate.body !== 'codex' || candidate.evidence.suiteId !== SUITE_ID
    || candidate.installedBuildFingerprint !== reviewed.expectedFingerprint
    || candidate.evidence.measuredBuildFingerprint !== reviewed.expectedFingerprint
    || validators.computeCandidateEvidenceDigest(candidate) !== candidate.evidenceDigest) {
    throw new Error('PERMISSION_CODEX_INTEGRATION_MEASUREMENT_INVALID');
  }
  const evaluated = { ...candidate, evidence: { ...candidate.evidence, evaluatedAt } };
  evaluated.evidenceDigest = validators.computeCandidateEvidenceDigest(evaluated);
  if (validators.evaluateParity(reference, candidate).kind !== 'parity'
    || validators.evaluateParity(reference, evaluated).kind !== 'parity') {
    throw new Error('PERMISSION_CODEX_INTEGRATION_PARITY_DENIED');
  }
}

/** Integrate genuine evidence without a provider call or filesystem mutation.
 * The trusted operator supplies current `now`, reviewed preparation identity and compiled validators.
 * This pure function authenticates consistency, not the provenance of caller-supplied inputs.
 */
export function integrateMeasuredCodexEvidence({ artifact, measurement, reviewed,
  expectedArtifactDigest, validators, now }) {
  validateIntegrationArtifact(artifact, expectedArtifactDigest, validators);
  validateIntegrationMeasurement(measurement, reviewed, validators, artifact.reference, now);
  const payload = structuredClone(artifactPayload(artifact));
  const index = payload.candidates.findIndex(candidate => candidate.body === 'codex');
  payload.candidates[index] = structuredClone(measurement.candidate);
  return { ...payload, artifactDigest: digest(payload) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const homeIndex = process.argv.indexOf('--codex-home');
  const codexHome = homeIndex >= 0 ? process.argv[homeIndex + 1] : process.env.CODEX_HOME;
  const runtimeIndex = process.argv.indexOf('--runtime-root');
  const runtimeRoot = runtimeIndex >= 0 ? process.argv[runtimeIndex + 1] : undefined;
  const fingerprintIndex = process.argv.indexOf('--expected-fingerprint');
  const expectedFingerprint = fingerprintIndex >= 0 ? process.argv[fingerprintIndex + 1] : undefined;
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) throw new Error('PERMISSION_CODEX_RUNTIME_ROOT_REQUIRED');
  measureCodexCandidate({ codexHome, runtimeRoot, expectedFingerprint })
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
