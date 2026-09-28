/**
 * Release license gate (ADR-174 §6.5, §16 P1 exit 8). Fails closed.
 *
 * For every package in the shipped closure it reads the installed
 * package.json and license/notice files, checks the declared SPDX expression
 * against the public allowlist (`scripts/release-license-allowlist.json`),
 * and refuses `SEE LICENSE IN …`, `UNLICENSED`, missing, unparseable, denied
 * and non-allowlisted licenses, and packages without a license file.
 *
 * The only ways past a failure are reviewed override entries, keyed by exact
 * `name@version` so an upgrade forces a new review:
 *   - `license`: the SPDX expression for a package whose package.json has no
 *     usable string (never allowed to contradict a declared string);
 *   - `suppliedText`: a canonical text shipped by us (sha256-pinned in the
 *     policy) for a package that ships no license file;
 *   - `excerpt`: a line range of a file inside the package (e.g. a README
 *     "License" section) carried into the notices as copyright evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertShape, shape } from './strict-shape.mjs';
import { failRelease } from './release-manifest-codes.mjs';
import { GATE_CODES as CODES, GATE_WARNINGS as WARNINGS, compareText, finding } from './release-gate-findings.mjs';
import { SpdxParseError, electAllowedLicense, formatSpdxTree, parseSpdxExpression, spdxLicenseIds } from './spdx-expression.mjs';

export const LICENSE_POLICY_SCHEMA = 'nassaj-release-license-policy/v1';
export const MAX_LICENSE_TEXT_BYTES = 256 * 1024;

const LICENSE_FILE = /^(?:licen[cs]e|copying|unlicense)(?:[._-].*)?$/i;
const NOTICE_FILE = /^notice(?:[._-].*)?$/i;
const SEE_LICENSE = /^SEE LICEN[CS]E IN\b/i;
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+ -]*$/;
const PACKAGE_KEY = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9A-Za-z.+-]+$/;
const TEXT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const POLICY_SHAPE = shape.object({
    schema: shape.oneOf([LICENSE_POLICY_SCHEMA]),
    allowed: shape.array(shape.string(SPDX_ID, 128), { min: 1, max: 128, key: id => id }),
    denied: shape.array(shape.string(SPDX_ID, 128), { max: 256, key: id => id }),
    texts: shape.array(shape.object({
        id: shape.string(SPDX_ID, 128),
        file: shape.string(TEXT_FILE, 256),
        sha256: shape.string(/^[0-9a-f]{64}$/, 64),
        source: shape.string(/^https:\/\//, 512),
    }), { max: 32, key: entry => entry.id }),
    overrides: shape.array(shape.object({
        package: shape.string(PACKAGE_KEY, 256),
        license: shape.string(null, 256),
        suppliedText: shape.string(SPDX_ID, 128),
        excerpt: shape.object({
            file: shape.string(BASENAME, 128),
            fromLine: shape.integer(1, 100000),
            toLine: shape.integer(1, 100000),
        }),
        evidence: shape.string(null, 1024),
        reviewed: shape.string(/^\d{4}-\d{2}-\d{2} \S.*$/, 256),
    }, ['license', 'suppliedText', 'excerpt']), { max: 512, key: entry => entry.package }),
});

/**
 * Validate the policy and load its sha256-pinned canonical texts.
 * @param {unknown} document parsed policy JSON
 * @param {string} policyDir directory the `texts[].file` paths are relative to
 */
export function loadLicensePolicy(document, policyDir) {
    assertShape(POLICY_SHAPE, document, 'policy', CODES.POLICY_INVALID);
    const allowed = new Set(document.allowed);
    const denied = new Set(document.denied);
    if (document.denied.some(id => allowed.has(id))) failRelease(CODES.POLICY_INVALID, 'an id is both allowed and denied');
    const texts = new Map(document.texts.map(entry => [entry.id, loadSuppliedText(entry, policyDir)]));
    for (const override of document.overrides) assertOverrideShape(override, texts);
    const overrides = new Map(document.overrides.map(entry => [entry.package, entry]));
    return Object.freeze({ allowed, allowedOrder: Object.freeze([...document.allowed]), denied, texts, overrides });
}

function loadSuppliedText(entry, policyDir) {
    const bytes = fs.readFileSync(path.join(policyDir, entry.file));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        failRelease(CODES.SUPPLIED_TEXT_TAMPERED, `${entry.file} does not match its pinned sha256`);
    }
    return Object.freeze({ ...entry, text: normalizeText(bytes, entry.file) });
}

function assertOverrideShape(override, texts) {
    const where = `override ${override.package}`;
    if (!override.license && !override.suppliedText && !override.excerpt) {
        failRelease(CODES.POLICY_INVALID, `${where} changes nothing`);
    }
    if (override.suppliedText && !texts.has(override.suppliedText)) {
        failRelease(CODES.POLICY_INVALID, `${where} names a supplied text that the policy does not pin`);
    }
    if (override.excerpt && override.excerpt.toLine < override.excerpt.fromLine) {
        failRelease(CODES.POLICY_INVALID, `${where} excerpt range is inverted`);
    }
}

/**
 * Decode a license file: UTF-8 only (BOM dropped), CRLF → LF, trailing
 * whitespace trimmed, exactly one final newline. Throws on bad input.
 */
export function normalizeText(bytes, label) {
    const text = decodeLines(bytes, label).map(line => line.trimEnd()).join('\n').trim();
    if (text.length === 0) throw new LicenseTextError(`${label} is empty`);
    return `${text}\n`;
}

/** Size-capped strict UTF-8 decode into LF-split lines (a leading BOM is dropped). */
function decodeLines(bytes, label) {
    if (bytes.byteLength > MAX_LICENSE_TEXT_BYTES) throw new LicenseTextError(`${label} is over ${MAX_LICENSE_TEXT_BYTES} bytes`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
        throw new LicenseTextError(`${label} is not valid UTF-8`);
    }
    return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}

/** A license or notice file that cannot be carried into the notices. */
export class LicenseTextError extends Error {
    constructor(detail) { super(detail); this.name = 'LicenseTextError'; }
}

/** `author` in any npm form → one display line, or null. */
export function formatAuthor(author) {
    if (typeof author === 'string') return author.trim() || null;
    if (!author || typeof author !== 'object' || typeof author.name !== 'string') return null;
    const email = typeof author.email === 'string' ? ` <${author.email}>` : '';
    const url = typeof author.url === 'string' ? ` (${author.url})` : '';
    return `${author.name}${email}${url}`;
}

/**
 * Evaluate one shipped package.
 * @param {object} pkg closure entry from computeShippedClosure
 * @param {{treeRoot: string, policy: ReturnType<typeof loadLicensePolicy>}} context
 * @returns {{record: object|null, findings: object[]}}
 */
export function evaluatePackage(pkg, { treeRoot, policy }) {
    const dir = path.join(treeRoot, ...pkg.path.split('/'));
    const manifestFile = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestFile)) return fail(pkg, CODES.PACKAGE_NOT_INSTALLED, 'no installed package.json');
    const installed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (installed.name !== pkg.name || installed.version !== pkg.version) {
        return fail(pkg, CODES.PACKAGE_IDENTITY_MISMATCH, 'installed name/version differ from the lockfile');
    }
    const override = policy.overrides.get(`${pkg.name}@${pkg.version}`);
    const license = resolveLicense(pkg, installed, override, policy);
    if (license.error) return fail(pkg, license.error.code, license.error.detail);
    const texts = collectTexts(dir, override, license.elected, policy);
    if (texts.error) return fail(pkg, texts.error.code, texts.error.detail);
    return {
        findings: [],
        record: Object.freeze({
            name: pkg.name,
            version: pkg.version,
            path: pkg.path,
            resolved: typeof pkg.resolved === 'string' ? pkg.resolved : null,
            declared: typeof installed.license === 'string' ? installed.license : null,
            license: formatSpdxTree(license.elected),
            author: formatAuthor(installed.author),
            override: override ? Object.freeze({ evidence: override.evidence, reviewed: override.reviewed }) : null,
            texts: texts.items,
        }),
    };
}

function fail(pkg, code, detail) {
    return { record: null, findings: [finding(code, pkg.path, detail)] };
}

function resolveLicense(pkg, installed, override, policy) {
    const declared = typeof installed.license === 'string' ? installed.license.trim() : null;
    if (declared && typeof pkg.license === 'string' && pkg.license !== installed.license) {
        return error(CODES.LICENSE_MISMATCH, 'lockfile and installed package.json declare different licenses');
    }
    if (override?.license && declared && declared !== override.license) {
        return error(CODES.OVERRIDE_CONFLICT, 'override contradicts the declared license');
    }
    const expression = override?.license ?? declared;
    if (!expression) {
        const legacy = installed.license ?? installed.licenses;
        const hint = legacy === undefined ? 'no license field' : 'license is not an SPDX string (legacy form)';
        return error(CODES.LICENSE_MISSING, `${hint}; needs a reviewed override`);
    }
    return electLicense(expression, policy);
}

function electLicense(expression, policy) {
    if (expression === 'UNLICENSED') return error(CODES.LICENSE_UNLICENSED, 'UNLICENSED');
    if (SEE_LICENSE.test(expression)) return error(CODES.LICENSE_SEE_FILE, expression);
    let tree;
    try { tree = parseSpdxExpression(expression); } catch (caught) {
        if (!(caught instanceof SpdxParseError)) throw caught;
        return error(CODES.LICENSE_UNPARSEABLE, expression);
    }
    const elected = electAllowedLicense(tree, policy.allowedOrder);
    if (elected) return { elected };
    const denied = spdxLicenseIds(tree).filter(id => policy.denied.has(id));
    return denied.length
        ? error(CODES.LICENSE_DENIED, `${expression} (denied: ${denied.join(', ')})`)
        : error(CODES.LICENSE_NOT_ALLOWLISTED, expression);
}

function error(code, detail) {
    return { error: { code, detail } };
}

function collectTexts(dir, override, elected, policy) {
    const names = fs.readdirSync(dir, { withFileTypes: true })
        .filter(dirent => dirent.isFile()).map(dirent => dirent.name).sort(compareText);
    const licenseFiles = names.filter(name => LICENSE_FILE.test(name));
    const noticeFiles = names.filter(name => NOTICE_FILE.test(name));
    try {
        const items = [...licenseFiles, ...noticeFiles]
            .map(name => ({ title: name, text: normalizeText(fs.readFileSync(path.join(dir, name)), name) }));
        const supplied = suppliedTextItem(licenseFiles, override, elected, policy);
        if (supplied.error) return supplied;
        if (supplied.item) items.push(supplied.item);
        if (override?.excerpt) items.push(excerptItem(dir, override.excerpt));
        return { items: Object.freeze(items) };
    } catch (caught) {
        if (caught instanceof LicenseTextError) return error(CODES.LICENSE_TEXT_INVALID, caught.message);
        if (caught instanceof OverrideError) return error(CODES.OVERRIDE_INVALID, caught.message);
        throw caught;
    }
}

function suppliedTextItem(licenseFiles, override, elected, policy) {
    const suppliedId = override?.suppliedText;
    if (licenseFiles.length > 0) {
        return suppliedId ? error(CODES.OVERRIDE_INVALID, 'package ships a license file; suppliedText must be dropped') : {};
    }
    if (!suppliedId) return error(CODES.LICENSE_FILE_MISSING, 'no license file; needs a reviewed suppliedText override');
    if (!spdxLicenseIds(elected).includes(suppliedId)) {
        return error(CODES.OVERRIDE_INVALID, `suppliedText ${suppliedId} is not the elected license`);
    }
    const text = policy.texts.get(suppliedId);
    return { item: { title: `${suppliedId} (canonical text supplied by Nassaj; ${text.source})`, text: text.text } };
}

class OverrideError extends Error {}

function excerptItem(dir, { file, fromLine, toLine }) {
    const target = path.join(dir, file);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new OverrideError(`excerpt file ${file} is missing`);
    const lines = decodeLines(fs.readFileSync(target), file);
    if (toLine > lines.length) throw new OverrideError(`excerpt ${file}:${fromLine}-${toLine} is out of range`);
    const text = normalizeText(Buffer.from(lines.slice(fromLine - 1, toLine).join('\n')), `${file} excerpt`);
    return { title: `${file} lines ${fromLine}-${toLine} (license statement)`, text };
}

/**
 * Evaluate every shipped package; unused overrides become warnings.
 * @param {object[]} shipped closure.shipped
 * @param {{treeRoot: string, policy: ReturnType<typeof loadLicensePolicy>}} context
 */
export function evaluateClosureLicenses(shipped, context) {
    const records = [];
    const findings = [];
    for (const pkg of shipped) {
        const outcome = evaluatePackage(pkg, context);
        findings.push(...outcome.findings);
        if (outcome.record) records.push(outcome.record);
    }
    const used = new Set(shipped.map(pkg => `${pkg.name}@${pkg.version}`));
    const warnings = [...context.policy.overrides.keys()].filter(key => !used.has(key)).sort(compareText)
        .map(key => finding(WARNINGS.OVERRIDE_UNUSED, key, 'override matches no shipped package'));
    return { records, findings, warnings };
}
