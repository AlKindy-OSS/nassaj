#!/usr/bin/env node
/**
 * `verify` job checks of release-generation.yml (ADR-174 §9.2 step 7).
 *
 *   self-check --dir GEN --bundle-dir DIR
 *       (a) the standalone verifier FROM THE BUILD ARTIFACT runs its full node
 *       path (verifyAndDecide: strict schema, verifier version, attestation,
 *       every archive and the installer bound to manifest and subjects, and
 *       the fresh-node decision), then every digests.txt line is checked
 *       against its file and the subjects.
 *   fleet --dir GEN --bundle-dir DIR --tag TAG --work DIR
 *       (b) fleet simulation (H2): for each channel, the latest PUBLISHED
 *       generation's verifier + trusted root, run with that generation's
 *       official Node, must accept N+1 as a node running N would: every N+1
 *       asset, `--installed <N version>@<N sequence>`. Its assets are first
 *       checked against its own manifest and it must verify its own release.
 *       A refusal is `attestation_trust_root_stale` or `verifier_incompatible`
 *       (any other code, e.g. `verifier_too_old` for a newer schema or
 *       minVerifierVersion); both block publish. No published generation on
 *       a channel (first release) skips that channel with a logged note.
 *
 * (c) the independent root re-fetch (M4) is trusted-root.mjs `recheck`.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GITHUB_OIDC_ISSUER, REF_PATTERN, REQUIRED_RUNNER, TRUST_POLICY_SCHEMA }
    from '../lib/release-generation/attestation-verifier.mjs';
import { RELEASE_BUNDLE_NAME, RELEASE_CHANNELS, RELEASE_MANIFEST_NAME }
    from '../lib/release-generation/release-manifest.mjs';
import { assetUrl, fetchBytes, latestPerChannel, listPublishedGenerations, loadIdentity }
    from './published-generations.mjs';

const VERIFIER_NAME = 'attestation-verifier.mjs';
const VERIFIER_IN_ARCHIVE = 'verifier/attestation-verifier.mjs';
const ROOT_NAME = 'trusted_root.json';
const FILES_NAME = 'GENERATION_FILES.json';
const INSTALL_NODE = fileURLToPath(new URL('./install-official-node.sh', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * The node-side identity policy (§7.1) built from the committed pin.
 * @param {{repository: string, repositoryId: string, ownerId: string, workflowPath: string}} identity
 * @param {string} channel
 */
export function policyFor(identity, channel) {
    return { schema: TRUST_POLICY_SCHEMA, issuer: GITHUB_OIDC_ISSUER, repository: identity.repository,
        repositoryId: identity.repositoryId, ownerId: identity.ownerId, workflowPath: identity.workflowPath,
        refPattern: REF_PATTERN, runnerEnvironment: REQUIRED_RUNNER, channel };
}

/**
 * Parse sha256sum-format digests.txt.
 * @param {string} text
 * @returns {Array<{sha256: string, name: string}>}
 */
export function parseDigests(text) {
    const lines = text.split('\n').filter(Boolean);
    if (!lines.length) throw new Error('digests_invalid: empty digests.txt');
    return lines.map(line => {
        const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/.exec(line);
        if (!match) throw new Error(`digests_invalid: ${JSON.stringify(line.slice(0, 80))}`);
        return { sha256: match[1], name: match[2] };
    });
}

/** The single bundle file downloaded from the attest job's artifact. */
export function findBundle(bundleDir) {
    const files = readdirSync(bundleDir).filter(name => name.endsWith('.json'));
    if (files.length !== 1) throw new Error(`attestation_bundle_count: expected 1, found ${files.length}`);
    return path.join(bundleDir, files[0]);
}

/**
 * (a) Self-check with the verifier module shipped in the artifact.
 * @param {{dir: string, bundleDir: string}} options
 * @param {{identity?: object, importVerifier?: (file: string) => Promise<object>}} [deps]
 * @returns {Promise<{subjects: number, artifacts: number}>}
 */
export async function selfCheck(options, deps = {}) {
    const identity = deps.identity ?? loadIdentity();
    const importVerifier = deps.importVerifier ?? (file => import(pathToFileURL(file).href));
    const read = name => readFileSync(path.join(options.dir, name));
    const manifestBytes = read(RELEASE_MANIFEST_NAME);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.source?.repositoryId !== identity.repositoryId) {
        throw new Error(`self_check_failed: manifest repositoryId ${manifest.source?.repositoryId} is not the pin`);
    }
    const verifier = await importVerifier(path.join(options.dir, VERIFIER_NAME));
    const result = verifier.verifyAndDecide({ bundleBytes: readFileSync(findBundle(options.bundleDir)), manifestBytes,
        trustedRoot: JSON.parse(read(ROOT_NAME).toString('utf8')), policy: policyFor(identity, manifest.channel),
        completeArtifacts: true, artifacts: parsed => [...parsed.targets.map(target => target.archive), parsed.installer]
            .map(entry => ({ name: entry.name, actualSha256: sha256(read(entry.name)) })) });
    if (result.decision.verdict !== 'accept') {
        throw new Error(`self_check_failed: decision ${result.decision.verdict} ${result.decision.code}`);
    }
    for (const line of parseDigests(read('digests.txt').toString('utf8'))) {
        if (sha256(read(line.name)) !== line.sha256) throw new Error(`self_check_failed: ${line.name} != digests.txt`);
        if (!result.verified.subjects.has(line.sha256)) throw new Error(`self_check_failed: ${line.name} is not a subject`);
    }
    return { subjects: result.verified.subjects.size, artifacts: result.artifacts };
}

/**
 * Check a previous generation's downloaded verifier and root against its own
 * manifest (root sha256 in the manifest; verifier sha256 in GENERATION_FILES,
 * whose sha256 is in the manifest).
 * @param {object} manifest previous manifest
 * @param {{root: Buffer, files: Buffer, verifier: Buffer}} assets
 * @returns {string[]} findings
 */
export function checkPreviousAssets(manifest, assets) {
    const findings = [];
    if (sha256(assets.root) !== manifest.sigstoreTrustedRootSha256) findings.push('trusted_root.json sha256');
    const target = manifest.targets.find(entry => entry.target === 'linux-x64-glibc') ?? manifest.targets[0];
    if (sha256(assets.files) !== target.fileManifestSha256) {
        findings.push(`${FILES_NAME} sha256`);
        return findings;
    }
    const listed = JSON.parse(assets.files.toString('utf8')).files?.find(entry => entry.path === VERIFIER_IN_ARCHIVE);
    if (!listed || listed.sha256 !== sha256(assets.verifier)) findings.push(`${VERIFIER_NAME} sha256`);
    return findings;
}

/**
 * CLI arguments that make the previous verifier decide N+1 as a node on N:
 * every N+1 asset from the generation dir, N as installed. The shim version
 * is N+1's own minimum: a shim bump is an operator reinstall (§5.2 c), not a
 * verifier incompatibility.
 * @param {object} previous manifest of N
 * @param {object} next manifest of N+1
 * @param {string} dir N+1 generation dir
 * @returns {string[]}
 */
export function fleetDecisionArguments(previous, next, dir) {
    if (!Number.isSafeInteger(next?.minShimVersion) || next.minShimVersion < 1) {
        throw new Error('fleet_simulation_failed: N+1 manifest has no minShimVersion');
    }
    return ['--artifacts', dir, '--installed', `${previous.version}@${previous.releaseSequence}`,
        '--shim-version', String(next.minShimVersion)];
}

/**
 * Map an old verifier's CLI result onto the fleet-simulation verdict.
 * @param {{status: number|null, stdout?: string}} result
 * @returns {'ok'|'attestation_trust_root_stale'|'verifier_incompatible'}
 */
export function classifyFleetResult(result) {
    if (result.status === 0) return 'ok';
    if (/^REJECTED attestation_trust_root_stale\b/m.test(result.stdout ?? '')) return 'attestation_trust_root_stale';
    return 'verifier_incompatible';
}

function runProcess(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function installNode(version, sha, dest) {
    const result = runProcess('bash', [INSTALL_NODE, '--version', version, '--sha256', sha, dest]);
    if (result.status !== 0) throw new Error(`previous_node_unavailable: ${result.stderr.trim()}`);
    return result.stdout.trim().split('\n').pop();
}

async function downloadPrevious(generation, dir, { repository, fetchImpl, token }) {
    const get = name => fetchBytes(fetchImpl, assetUrl(repository, generation.tag, name), { token });
    const assets = { bundle: await get(RELEASE_BUNDLE_NAME), verifier: await get(VERIFIER_NAME),
        root: await get(ROOT_NAME), files: await get(FILES_NAME) };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, RELEASE_BUNDLE_NAME), assets.bundle);
    writeFileSync(path.join(dir, VERIFIER_NAME), assets.verifier);
    writeFileSync(path.join(dir, ROOT_NAME), assets.root);
    writeFileSync(path.join(dir, RELEASE_MANIFEST_NAME), generation.manifestBytes);
    return assets;
}

/**
 * (b) One channel of the fleet simulation.
 * @returns {Promise<string>} verdict ('ok' or a failure code)
 */
export async function simulateChannel({ generation, options, identity, deps }) {
    const dir = path.join(options.work, generation.manifest.channel);
    const assets = await downloadPrevious(generation, dir, deps);
    const findings = checkPreviousAssets(generation.manifest, assets);
    if (findings.length) throw new Error(`previous_generation_assets_mismatch: ${generation.tag}: ${findings.join(', ')}`);
    const target = generation.manifest.targets.find(entry => entry.target === 'linux-x64-glibc')
        ?? generation.manifest.targets[0];
    const node = deps.installNode(target.node.version, target.node.sha256, path.join(dir, 'node'));
    const policyFile = path.join(dir, 'policy.json');
    writeFileSync(policyFile, `${JSON.stringify(policyFor(identity, generation.manifest.channel))}\n`);
    const verifier = path.join(dir, VERIFIER_NAME);
    const own = deps.runProcess(node, [verifier, path.join(dir, RELEASE_BUNDLE_NAME), path.join(dir, ROOT_NAME),
        policyFile, path.join(dir, RELEASE_MANIFEST_NAME)]);
    if (own.status !== 0) throw new Error(`previous_generation_unverified: ${generation.tag}: ${own.stdout.trim()}`);
    const nextManifestFile = path.join(options.dir, RELEASE_MANIFEST_NAME);
    // Read loosely on purpose: judging N+1's schema is the previous verifier's job.
    const nextManifest = JSON.parse(readFileSync(nextManifestFile, 'utf8'));
    const next = deps.runProcess(node, [verifier, findBundle(options.bundleDir), path.join(dir, ROOT_NAME),
        policyFile, nextManifestFile, ...fleetDecisionArguments(generation.manifest, nextManifest, options.dir)]);
    deps.log(`fleet ${generation.manifest.channel}: ${generation.tag} verifier -> ${next.stdout.trim()}`);
    return classifyFleetResult(next);
}

/**
 * (b) Fleet simulation over every channel.
 * @returns {Promise<Map<string, string>>} channel -> verdict ('skipped' when nothing is published)
 */
export async function fleetSimulation(options, deps = {}) {
    const identity = deps.identity ?? loadIdentity();
    const full = { fetchImpl: fetch, token: process.env.GH_TOKEN, runProcess, installNode,
        log: line => process.stdout.write(`${line}\n`), repository: identity.repository, ...deps };
    const generations = await listPublishedGenerations({ repository: full.repository, fetchImpl: full.fetchImpl,
        token: full.token, pages: 3 });
    const latest = latestPerChannel(generations, options.tag);
    const verdicts = new Map();
    for (const channel of RELEASE_CHANNELS) {
        const generation = latest.get(channel);
        if (!generation) {
            full.log(`fleet ${channel}: skipped, no published generation (first release on this channel)`);
            verdicts.set(channel, 'skipped');
            continue;
        }
        verdicts.set(channel, await simulateChannel({ generation, options, identity, deps: full }));
    }
    const failed = [...verdicts].filter(([, verdict]) => verdict !== 'ok' && verdict !== 'skipped');
    if (failed.length) throw new Error(`fleet_simulation_failed: ${failed.map(([c, v]) => `${c}=${v}`).join(', ')}`);
    return verdicts;
}

const FLAGS = new Map([['--dir', 'dir'], ['--bundle-dir', 'bundleDir'], ['--tag', 'tag'], ['--work', 'work']]);

/** Parse `<command> [flags]`. */
export function parseVerifyArguments(argv) {
    const [command, ...rest] = argv;
    if (command !== 'self-check' && command !== 'fleet') throw new Error('usage: verify-generation.mjs self-check|fleet');
    const options = { command };
    for (let index = 0; index < rest.length; index += 1) {
        const key = FLAGS.get(rest[index]);
        if (!key || index + 1 >= rest.length) throw new Error(`usage: unknown or incomplete option ${rest[index]}`);
        options[key] = rest[index += 1];
    }
    const required = command === 'fleet' ? ['dir', 'bundleDir', 'tag', 'work'] : ['dir', 'bundleDir'];
    for (const key of required) if (!options[key]) throw new Error(`usage: ${command} needs --${key}`);
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    Promise.resolve().then(async () => {
        const options = parseVerifyArguments(process.argv.slice(2));
        const result = options.command === 'fleet' ? Object.fromEntries(await fleetSimulation(options))
            : await selfCheck(options);
        process.stdout.write(`${options.command} ok: ${JSON.stringify(result)}\n`);
    }).catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
