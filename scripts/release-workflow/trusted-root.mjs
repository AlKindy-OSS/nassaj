#!/usr/bin/env node
/**
 * Sigstore trusted root for release generations (ADR-174 §7.9).
 *
 *   fetch   --out FILE --cache DIR
 *       `build` job: fetch the root fresh through TUF (embedded TUF root ->
 *       verified metadata chain) and write its canonical JSON. Never cached
 *       across runs; expired or unverifiable TUF metadata fails the build.
 *   recheck --manifest FILE --shipped FILE --cache DIR [--previous-dir DIR]
 *       `verify` job (M4): fetch the root again in this process, require
 *       sha256(canonical fresh) == manifest.sigstoreTrustedRootSha256 ==
 *       sha256(shipped file), and log the key-id diff against each previous
 *       generation root found under DIR/<channel>/trusted_root.json.
 *
 * TODO(ADR-174 §7.9): `@sigstore/tuf` is not yet a pinned dependency of this
 * repository; until it is added, both commands fail closed with
 * `sigstore_tuf_unavailable` (the workflow cannot publish without a fresh root).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_CHANNELS } from '../lib/release-generation/release-manifest.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Load the TUF client and the protobuf codec; missing packages fail closed.
 * @param {(name: string) => Promise<object>} [importer]
 */
export async function loadSigstore(importer = name => import(name)) {
    let tuf;
    let specs;
    try {
        tuf = await importer('@sigstore/tuf');
        specs = await importer('@sigstore/protobuf-specs');
    } catch (error) {
        throw new Error(`sigstore_tuf_unavailable: ${error.code || error.message}`);
    }
    const getTrustedRoot = tuf.getTrustedRoot ?? tuf.default?.getTrustedRoot;
    const TrustedRoot = specs.TrustedRoot ?? specs.default?.TrustedRoot;
    if (typeof getTrustedRoot !== 'function' || !TrustedRoot) throw new Error('sigstore_tuf_unavailable: unexpected exports');
    return { getTrustedRoot, TrustedRoot };
}

/**
 * Canonical text of a trusted root: protobuf JSON form, one-space indent, as
 * measured in the S1 evidence (`fetch-root.mjs`).
 * @param {object} root TrustedRoot message
 * @param {{toJSON: (m: object) => object}} TrustedRoot codec
 */
export function canonicalRootText(root, TrustedRoot) {
    return JSON.stringify(TrustedRoot.toJSON(root), null, 1);
}

/** Key ids per section, for a stable add/remove diff. */
export function rootKeyIds(root) {
    return {
        tlogs: (root.tlogs ?? []).map(entry => `${entry.baseUrl} ${entry.logId?.keyId}`),
        ctlogs: (root.ctlogs ?? []).map(entry => `${entry.baseUrl} ${entry.logId?.keyId}`),
        cas: (root.certificateAuthorities ?? []).map(entry => `${entry.uri} ${entry.validFor?.start}`),
        tsas: (root.timestampAuthorities ?? []).map(entry => `${entry.uri} ${entry.validFor?.start}`),
    };
}

/**
 * Human-readable key-id diff (previous -> next), one line per section.
 * @param {object} previous root JSON
 * @param {object} next root JSON
 * @returns {string[]}
 */
export function keyIdDiff(previous, next) {
    const before = rootKeyIds(previous);
    const after = rootKeyIds(next);
    return Object.keys(after).map(section => {
        const added = after[section].filter(item => !before[section].includes(item));
        const removed = before[section].filter(item => !after[section].includes(item));
        return `${section}: ${after[section].length} (added ${added.length}${added.map(item => ` +${item}`).join('')}; `
            + `removed ${removed.length}${removed.map(item => ` -${item}`).join('')})`;
    });
}

/**
 * M4 comparison. Returns findings; empty means the three digests agree.
 * @param {{freshText: string, shippedBytes: Uint8Array, manifestSha256: string}} input
 */
export function compareRoots({ freshText, shippedBytes, manifestSha256 }) {
    const findings = [];
    const fresh = sha256(Buffer.from(freshText, 'utf8'));
    const shipped = sha256(shippedBytes);
    if (!/^[0-9a-f]{64}$/.test(manifestSha256 ?? '')) findings.push('manifest sigstoreTrustedRootSha256 is missing');
    if (fresh !== manifestSha256) findings.push(`fresh root ${fresh} != manifest ${manifestSha256}`);
    if (shipped !== manifestSha256) findings.push(`shipped root ${shipped} != manifest ${manifestSha256}`);
    return findings;
}

const FLAGS = new Map([['--out', 'out'], ['--cache', 'cache'], ['--manifest', 'manifest'], ['--shipped', 'shipped'],
    ['--previous-dir', 'previousDir']]);

/** Parse `<command> [flags]`. */
export function parseRootArguments(argv) {
    const [command, ...rest] = argv;
    if (command !== 'fetch' && command !== 'recheck') throw new Error('usage: trusted-root.mjs fetch|recheck [options]');
    const options = { command };
    for (let index = 0; index < rest.length; index += 1) {
        const key = FLAGS.get(rest[index]);
        if (!key || index + 1 >= rest.length) throw new Error(`usage: unknown or incomplete option ${rest[index]}`);
        options[key] = rest[index += 1];
    }
    const required = command === 'fetch' ? ['out', 'cache'] : ['manifest', 'shipped', 'cache'];
    for (const key of required) if (!options[key]) throw new Error(`usage: ${command} needs --${key}`);
    return options;
}

async function fetchCanonical(options, sigstore) {
    const root = await sigstore.getTrustedRoot({ cachePath: options.cache });
    return canonicalRootText(root, sigstore.TrustedRoot);
}

/**
 * Execute one command; `sigstore` and `log` are injectable for tests.
 * @returns {Promise<void>}
 */
export async function runTrustedRoot(options, { sigstore, log = line => process.stdout.write(`${line}\n`) } = {}) {
    const tools = sigstore ?? await loadSigstore();
    const freshText = await fetchCanonical(options, tools);
    if (options.command === 'fetch') {
        writeFileSync(options.out, freshText, { flag: 'wx', mode: 0o644 });
        log(`trusted root fetched: sha256 ${sha256(Buffer.from(freshText, 'utf8'))}`);
        return;
    }
    const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
    const findings = compareRoots({ freshText, shippedBytes: readFileSync(options.shipped),
        manifestSha256: manifest.sigstoreTrustedRootSha256 });
    if (findings.length) throw new Error(`trusted_root_mismatch: ${findings.join('; ')}`);
    log(`trusted root re-fetched independently: sha256 ${manifest.sigstoreTrustedRootSha256} matches`);
    logPreviousDiffs(options.previousDir, JSON.parse(freshText), log);
}

function logPreviousDiffs(previousDir, fresh, log) {
    let found = 0;
    for (const channel of RELEASE_CHANNELS) {
        const file = previousDir ? path.join(previousDir, channel, 'trusted_root.json') : '';
        if (!file || !existsSync(file)) continue;
        found += 1;
        log(`key-id diff vs previous ${channel} generation root:`);
        for (const line of keyIdDiff(JSON.parse(readFileSync(file, 'utf8')), fresh)) log(`  ${line}`);
    }
    if (!found) log('key-id diff: no previous generation root (first release on every channel)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    Promise.resolve().then(() => runTrustedRoot(parseRootArguments(process.argv.slice(2)))).catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
