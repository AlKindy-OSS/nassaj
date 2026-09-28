/**
 * Deterministic THIRD_PARTY_NOTICES for a release generation (ADR-174 §6.5).
 *
 * Input is the license gate's per-package records, so the notices describe
 * exactly the shipped closure. Output bytes depend only on the input: no
 * timestamps, code-unit sort order, LF line endings, one trailing newline.
 * One copy of a `name@version` appears even when npm installed it at several
 * paths (the first path in sort order is used as the source of its texts).
 */
import { compareText } from './release-gate-findings.mjs';

const RULE = '='.repeat(80);
const THIN_RULE = '-'.repeat(80);

function uniqueRecords(records) {
    const byKey = new Map();
    const sorted = [...records].sort((a, b) => compareText(a.name, b.name)
        || compareText(a.version, b.version) || compareText(a.path, b.path));
    for (const record of sorted) {
        const key = `${record.name}@${record.version}`;
        if (!byKey.has(key)) byKey.set(key, record);
    }
    return [...byKey.values()];
}

function licenseSummary(records) {
    const counts = new Map();
    for (const record of records) counts.set(record.license, (counts.get(record.license) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
        .map(([license, count]) => `  ${license}: ${count}`);
}

function renderRecord(record) {
    const lines = [RULE, `Package: ${record.name}@${record.version}`, `License: ${record.license}`];
    if (record.declared && record.declared !== record.license) lines.push(`Declared: ${record.declared}`);
    if (record.author) lines.push(`Author: ${record.author}`);
    if (record.resolved) lines.push(`Source: ${record.resolved}`);
    if (record.override) lines.push(`License review: ${record.override.evidence} (${record.override.reviewed})`);
    for (const item of record.texts) lines.push(THIN_RULE, `[${item.title}]`, '', item.text.trimEnd());
    return lines.join('\n');
}

function renderExcluded(excluded) {
    const unique = [...new Set(excluded.map(pkg => `${pkg.installName ?? pkg.name}@${pkg.version}`))].sort(compareText);
    if (unique.length === 0) return [];
    return [
        '',
        'Not included in this archive (never redistributed by Nassaj). Where a node',
        'needs one of them, the node downloads it itself from https://registry.npmjs.org/',
        'at the version and integrity pinned in release-manifest.json, and uses it',
        'under its own license terms. The others are not installed at all:',
        ...unique.map(key => `  ${key}`),
    ];
}

/**
 * Render THIRD_PARTY_NOTICES.
 * @param {{target: string, lockfileSha256: string, records: object[], excluded?: object[]}} input
 * @returns {string}
 */
export function renderThirdPartyNotices({ target, lockfileSha256, records, excluded = [] }) {
    const unique = uniqueRecords(records);
    const header = [
        'THIRD-PARTY SOFTWARE NOTICES',
        '',
        'Nassaj is licensed under the GNU Affero General Public License v3.0 (see LICENSE).',
        'This release generation bundles the third-party npm packages listed below,',
        'each under its own license. Generated from package-lock.json; do not edit.',
        '',
        `Target: ${target}`,
        `package-lock.json sha256: ${lockfileSha256}`,
        `Packages: ${unique.length}`,
        'Licenses:',
        ...licenseSummary(unique),
        ...renderExcluded(excluded),
        '',
    ];
    return `${[header.join('\n'), ...unique.map(renderRecord), RULE].join('\n')}\n`;
}
