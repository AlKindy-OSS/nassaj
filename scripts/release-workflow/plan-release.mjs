#!/usr/bin/env node
/**
 * `plan` job of release-generation.yml (ADR-174 §9.2 step 4). Advisory: it runs
 * code from the tagged commit, and the node check (§7.4) is the control.
 *
 * Checks: the tag is annotated, names the checked-out commit, is on main and
 * equals `v<package.json version>`; the committed release fields (§7.3,
 * `package.json` → `releaseGeneration`) are well formed; releaseSequence and
 * version are greater than every published generation's. Writes the job
 * outputs (`version`, `channel`, `release-sequence`, `min-upgrade-from`,
 * `migration-class`) to $GITHUB_OUTPUT.
 *
 * TODO(ADR-174 §7.3): the release orchestrator must write
 * `releaseGeneration` into package.json in the release commit; until it does,
 * this job fails closed with `release_fields_missing`.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareNassajReleaseVersions, isNassajReleaseVersion } from '../../shared/release-version-policy.js';
import { MIGRATION_CLASSES, RELEASE_CHANNELS } from '../lib/release-generation/release-manifest.mjs';
import { highestSequence, latestPerChannel, listPublishedGenerations } from './published-generations.mjs';

const VALUE_FLAGS = new Map([['--tag', 'tag'], ['--commit', 'commit'], ['--repository', 'repository'],
    ['--github-output', 'githubOutput'], ['--root', 'root']]);

/** Parse CLI flags; unknown or incomplete flags throw. */
export function parsePlanArguments(argv) {
    const options = { root: process.cwd() };
    for (let index = 0; index < argv.length; index += 1) {
        const key = VALUE_FLAGS.get(argv[index]);
        if (!key || index + 1 >= argv.length) throw new Error(`usage: unknown or incomplete option ${argv[index]}`);
        options[key] = argv[index += 1];
    }
    for (const required of ['tag', 'commit', 'repository', 'githubOutput']) {
        if (!options[required]) throw new Error(`usage: --${required.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`);
    }
    return options;
}

/**
 * Validate the committed release fields against the package version and tag.
 * @param {object} pkg parsed package.json
 * @param {string} tag pushed tag name
 * @returns {{version: string, channel: string, releaseSequence: number, minUpgradeFrom: string,
 *   migrationClass: string}}
 */
export function planFromPackage(pkg, tag) {
    const version = pkg?.version;
    if (!isNassajReleaseVersion(version)) throw new Error(`release_version_invalid: ${version}`);
    if (tag !== `v${version}`) throw new Error(`release_tag_mismatch: tag ${tag} is not v${version}`);
    const fields = pkg.releaseGeneration;
    if (!fields || typeof fields !== 'object') throw new Error('release_fields_missing: package.json releaseGeneration');
    const { channel, releaseSequence, minUpgradeFrom, migrationClass } = fields;
    if (!RELEASE_CHANNELS.includes(channel)) throw new Error(`release_fields_invalid: channel ${channel}`);
    if (!Number.isSafeInteger(releaseSequence) || releaseSequence < 1) {
        throw new Error(`release_fields_invalid: releaseSequence ${releaseSequence}`);
    }
    if (!isNassajReleaseVersion(minUpgradeFrom) || compareNassajReleaseVersions(minUpgradeFrom, version) > 0) {
        throw new Error(`release_fields_invalid: minUpgradeFrom ${minUpgradeFrom}`);
    }
    if (!MIGRATION_CLASSES.includes(migrationClass)) throw new Error(`release_fields_invalid: migrationClass ${migrationClass}`);
    return { version, channel, releaseSequence, minUpgradeFrom, migrationClass };
}

/**
 * The plan must be strictly newer than what is published: sequence above every
 * channel's, version above the same channel's latest.
 * @param {object} plan result of planFromPackage
 * @param {Array<{tag: string, manifest: object}>} generations published generations
 * @param {string} tag current tag (ignored when already published, e.g. a re-run)
 */
export function assertNewerThanPublished(plan, generations, tag) {
    const others = generations.filter(generation => generation.tag !== tag);
    const highest = highestSequence(others);
    if (plan.releaseSequence <= highest) {
        throw new Error(`release_sequence_not_greater: ${plan.releaseSequence} <= published ${highest}`);
    }
    const sameChannel = latestPerChannel(others, tag).get(plan.channel);
    if (sameChannel && compareNassajReleaseVersions(plan.version, sameChannel.manifest.version) <= 0) {
        throw new Error(`release_version_not_newer: ${plan.version} <= ${sameChannel.manifest.version}`);
    }
}

function git(root, args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git_failed: git ${args.join(' ')}: ${(result.stderr || '').trim()}`);
    return result.stdout.trim();
}

/**
 * Tag shape in git: annotated, peels to the checked-out commit, reachable from main.
 * @param {string} root repository checkout (fetch-depth 0)
 * @param {string} tag
 * @param {string} commit GITHUB_SHA
 * @param {(root: string, args: string[]) => string} [runGit]
 */
export function assertTagShape(root, tag, commit, runGit = git) {
    if (runGit(root, ['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') throw new Error(`release_tag_not_annotated: ${tag}`);
    const peeled = runGit(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
    if (peeled !== commit) throw new Error(`release_tag_commit_mismatch: ${tag} -> ${peeled}, run ${commit}`);
    runGit(root, ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
}

/** `key=value` lines for $GITHUB_OUTPUT; values are validated and single-line. */
export function outputLines(plan) {
    return [`version=${plan.version}`, `channel=${plan.channel}`, `release-sequence=${plan.releaseSequence}`,
        `min-upgrade-from=${plan.minUpgradeFrom}`, `migration-class=${plan.migrationClass}`, ''].join('\n');
}

/**
 * Run the whole plan; injectable for tests.
 * @returns {Promise<object>} the plan
 */
export async function runPlan(options, { fetchImpl = fetch, runGit = git, token = process.env.GH_TOKEN } = {}) {
    const pkg = JSON.parse(readFileSync(path.join(options.root, 'package.json'), 'utf8'));
    const plan = planFromPackage(pkg, options.tag);
    assertTagShape(options.root, options.tag, options.commit, runGit);
    const generations = await listPublishedGenerations({ repository: options.repository, fetchImpl, token, pages: 3 });
    assertNewerThanPublished(plan, generations, options.tag);
    appendFileSync(options.githubOutput, outputLines(plan));
    return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runPlan(parsePlanArguments(process.argv.slice(2))).then(plan => {
        process.stdout.write(`plan ok: ${JSON.stringify(plan)}\n`);
    }, error => {
        process.stderr.write(`plan failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
