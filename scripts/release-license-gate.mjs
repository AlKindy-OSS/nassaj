#!/usr/bin/env node
/**
 * ADR-174 release license + exclusion gate (public build script).
 *
 * Usage:
 *   node scripts/release-license-gate.mjs [--root DIR] [--tree DIR] [--target T]
 *     [--policy FILE] [--exclusions FILE] [--check-tree] [--notices-out FILE] [--json]
 *
 * Exit 0 = pass (notices written when --notices-out is given), 1 = gate
 * failed (findings printed, nothing written), 2 = usage or policy error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runReleaseLicenseGate } from './lib/release-generation/license-gate-run.mjs';

const VALUE_FLAGS = new Map([
    ['--root', 'root'], ['--tree', 'treeRoot'], ['--target', 'target'], ['--policy', 'policyFile'],
    ['--exclusions', 'exclusionsFile'], ['--notices-out', 'noticesOut'],
]);
const BOOLEAN_FLAGS = new Map([['--check-tree', 'checkTree'], ['--json', 'json']]);

/** Parse argv into options; throws UsageError on anything unknown. */
export function parseArgs(argv) {
    const options = { root: process.cwd() };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (BOOLEAN_FLAGS.has(flag)) { options[BOOLEAN_FLAGS.get(flag)] = true; continue; }
        if (!VALUE_FLAGS.has(flag) || index + 1 >= argv.length) throw new UsageError(`unknown or incomplete option ${flag}`);
        options[VALUE_FLAGS.get(flag)] = argv[index += 1];
    }
    return options;
}

class UsageError extends Error {}

function printHuman(report, write) {
    const { counts } = report;
    write(`license gate [${report.target}] shipped=${counts.shipped} excluded=${counts.excluded} `
        + `platform-skipped=${counts.skipped} findings=${report.findings.length} warnings=${report.warnings.length}\n`);
    for (const item of report.findings) write(`FAIL ${item.code} ${item.subject}: ${item.detail}\n`);
    for (const item of report.warnings) write(`WARN ${item.code} ${item.subject}: ${item.detail}\n`);
    write(report.ok ? 'license gate: PASS\n' : 'license gate: FAIL\n');
}

/**
 * CLI entry; returns the process exit code.
 * @param {string[]} argv arguments after the script path
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [io]
 */
export function main(argv, io = {}) {
    const stdout = io.stdout ?? (text => process.stdout.write(text));
    const stderr = io.stderr ?? (text => process.stderr.write(text));
    let options;
    let report;
    try {
        options = parseArgs(argv);
        report = runReleaseLicenseGate(options);
    } catch (caught) {
        stderr(`license gate error: ${caught.code ? `${caught.code}: ` : ''}${caught.detail ?? caught.message}\n`);
        return 2;
    }
    if (options.json) {
        const { notices, closure, ...summary } = report;
        stdout(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
        printHuman(report, stdout);
    }
    if (report.ok && options.noticesOut) fs.writeFileSync(path.resolve(options.noticesOut), report.notices);
    return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
