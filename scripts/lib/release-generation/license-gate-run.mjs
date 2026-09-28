/**
 * One call that runs the whole ADR-174 license/exclusion gate for a target:
 * closure from the lockfile, exclusion checks (required-by, lifecycle
 * scripts, optional installed-tree check), the license gate and — only when
 * everything passes — the THIRD_PARTY_NOTICES text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sortFindings } from './release-gate-findings.mjs';
import { evaluateClosureLicenses, loadLicensePolicy } from './license-gate.mjs';
import {
    collectLifecycleScriptSources, compareTreeToClosure, computeShippedClosure, excludedScriptReferenceFindings,
    listInstalledPackagePaths, loadExclusionPolicy,
} from './production-closure.mjs';
import { renderThirdPartyNotices } from './third-party-notices.mjs';

export const DEFAULT_POLICY_FILE = 'scripts/release-license-allowlist.json';
export const DEFAULT_EXCLUSIONS_FILE = 'scripts/release-excluded-packages.json';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * @param {object} options
 * @param {string} options.root project root (package.json, package-lock.json, policy files)
 * @param {string} [options.treeRoot] directory holding the node_modules to inspect (default root)
 * @param {string} [options.target] release target (default linux-x64-glibc)
 * @param {string} [options.policyFile] license policy path (default under root)
 * @param {string} [options.exclusionsFile] exclusion list path (default under root)
 * @param {boolean} [options.checkTree] require the installed tree to equal the closure
 * @returns {{ok: boolean, target: string, lockfileSha256: string, counts: object,
 *   findings: object[], warnings: object[], notices: string|null, closure: object}}
 */
export function runReleaseLicenseGate(options) {
    const root = path.resolve(options.root);
    const treeRoot = path.resolve(options.treeRoot ?? root);
    const target = options.target ?? 'linux-x64-glibc';
    const policyFile = path.resolve(root, options.policyFile ?? DEFAULT_POLICY_FILE);
    const exclusions = loadExclusionPolicy(readJson(path.resolve(root, options.exclusionsFile ?? DEFAULT_EXCLUSIONS_FILE)));
    const policy = loadLicensePolicy(readJson(policyFile), path.dirname(policyFile));
    const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'));
    const lockfileSha256 = createHash('sha256').update(lockBytes).digest('hex');

    const closure = computeShippedClosure(JSON.parse(lockBytes.toString('utf8')), { target, exclusions });
    const findings = [...closure.findings];
    findings.push(...excludedScriptReferenceFindings(collectLifecycleScriptSources(root), exclusions));
    if (options.checkTree) findings.push(...compareTreeToClosure(listInstalledPackagePaths(treeRoot), closure, exclusions));
    const licenses = evaluateClosureLicenses(closure.shipped, { treeRoot, policy });
    findings.push(...licenses.findings);

    const ok = findings.length === 0;
    return {
        ok,
        target,
        lockfileSha256,
        counts: { shipped: closure.shipped.length, excluded: closure.excluded.length, skipped: closure.skipped.length },
        findings: sortFindings(findings),
        warnings: sortFindings([...closure.warnings, ...licenses.warnings]),
        notices: ok ? renderThirdPartyNotices({ target, lockfileSha256, records: licenses.records, excluded: closure.excluded }) : null,
        closure,
    };
}
