#!/usr/bin/env node
/**
 * fleet-sharing-preflight — READ-ONLY check of one node before the ADR-152 A1
 * release (T-2083, BE-14; ADR-152 A1 §3.6 and §4).
 *
 * After the release, a node in platform mode with more than one active user
 * refuses to boot for every provider (identity collapse onto the first user is
 * credential sharing). Before the release that was already so, EXCEPT on a node
 * that stored `claude = shared`. This script tells, per node, whether it would
 * refuse boot, and whether the upgrade is what changes that.
 *
 * Run from (or point --root at) the node's install root:
 *   node scripts/fleet-sharing-preflight.mjs [--root DIR] [--db FILE] [--home DIR] [--json]
 * or piped to a node without copying the file there (nothing is written):
 *   ssh <node> 'cd <root> && node -' < scripts/fleet-sharing-preflight.mjs
 *
 * Reports: the platform-mode flag per source (process env, <root>/.env, the pm2
 * ecosystem files), the active user count, the stored app_config
 * `provider_sharing` value (a policy, not a secret), and which install-wide
 * vendor keys exist — by key NAME only, nothing is decrypted or printed.
 *
 * Read-only by construction: the database is opened `readonly`, no file is
 * written, no key material is decrypted. Exit 0 = ok, 2 = would refuse boot,
 * 1 = could not decide (missing database, unreadable input).
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const PLATFORM_FLAG = 'VITE_IS_PLATFORM';

/**
 * Variables a provider child must never inherit (ADR-152 A1 §3.5, qa M5,
 * B-1745): XDG base dirs, the Bedrock/Vertex switches and any AWS_* credential.
 * Reported by NAME per source; a value is never read into the report.
 */
const INHERITED_NAME = /^(?:XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX)|ANTHROPIC_VERTEX_PROJECT_ID|AWS_[A-Z0-9_]+)$/;
const ECOSYSTEM_FILE = /^ecosystem(\..+)?\.config\.c?js$/;

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { root: process.cwd(), db: null, home: os.homedir(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (['--root', '--db', '--home'].includes(flag) && argv[i + 1]) args[flag.slice(2)] = argv[(i += 1)];
    else throw new Error(`unknown argument: ${flag}`);
  }
  args.root = path.resolve(args.root);
  return args;
}

/** KEY=VALUE pairs of a dotenv file (quotes stripped); {} when absent. */
function readDotenv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Ecosystem files in the root and in config/ (live nodes keep theirs there), root-relative. */
function ecosystemFiles(root) {
  const found = [];
  for (const dir of ['', 'config']) {
    try {
      for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
        if (ECOSYSTEM_FILE.test(name)) found.push(path.join(dir, name));
      }
    } catch {
      // directory absent
    }
  }
  return found;
}

/**
 * The platform flag in every source that sets it: process env, .env,
 * config/node.env, and the pm2 ecosystem files — scanned as TEXT (never
 * required: loading them would run their code).
 */
function platformSources(root, dotenv) {
  const sources = [];
  if (process.env[PLATFORM_FLAG] !== undefined) {
    sources.push({ source: 'process.env', value: process.env[PLATFORM_FLAG] });
  }
  if (dotenv[PLATFORM_FLAG] !== undefined) sources.push({ source: '.env', value: dotenv[PLATFORM_FLAG] });
  const nodeEnv = readDotenv(path.join(root, 'config', 'node.env'));
  if (nodeEnv[PLATFORM_FLAG] !== undefined) sources.push({ source: 'config/node.env', value: nodeEnv[PLATFORM_FLAG] });
  for (const rel of ecosystemFiles(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const match of text.matchAll(/VITE_IS_PLATFORM['"]?\s*:\s*['"]?(true|false)['"]?/g)) {
      sources.push({ source: rel, value: match[1] });
    }
  }
  return sources;
}

/** better-sqlite3 from the node's own install, else from this checkout. */
function loadSqlite(root) {
  for (const base of [path.join(root, 'package.json'), import.meta.url]) {
    try {
      return createRequire(base)('better-sqlite3');
    } catch {
      // try the next location
    }
  }
  throw new Error('better-sqlite3 is not installed in the node root or this checkout');
}

/** Facts from the database, opened read-only. */
function readDatabase(root, dbPath) {
  const Database = loadSqlite(root);
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`cannot open the database read-only at ${dbPath}: ${error.message}`);
  }
  try {
    const active = db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_active = 1 AND status = 'active'").get();
    const policy = db.prepare("SELECT value FROM app_config WHERE key = 'provider_sharing'").get();
    const retired = db.prepare(
      "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'provider_sharing_retirement'",
    ).get();
    return {
      activeUserCount: Number(active?.count ?? 0),
      providerSharing: { present: policy !== undefined, value: policy?.value ?? null },
      retirementSnapshotTable: Boolean(retired),
    };
  } finally {
    db.close();
  }
}

/** The vendor slots the retired install-wide fallback served (provider-secrets-store). */
const VENDOR_SLOTS = new Set(['kimi', 'deepseek', 'glm']);

/**
 * Install-wide store entry NAMES with a non-empty stored value, split into the
 * vendor slots the retired fallback served and any other operator secret.
 * Never a value.
 */
function installWideKeys(home) {
  const file = path.join(home, '.nassaj-provider-secrets', 'keys.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'unreadable', present: [], otherSecrets: [] };
  }
  try {
    const keys = JSON.parse(raw);
    const names = Object.keys(keys).filter((name) => typeof keys[name] === 'string' && keys[name].length > 0).sort();
    return {
      state: 'ok',
      present: names.filter((name) => VENDOR_SLOTS.has(name)),
      otherSecrets: names.filter((name) => !VENDOR_SLOTS.has(name)),
    };
  } catch {
    return { state: 'unreadable', present: [], otherSecrets: [] };
  }
}

/** True when the stored policy marks claude as shared (the one pre-upgrade exemption). */
function claudeWasShared(value) {
  try {
    return JSON.parse(value ?? 'null')?.claude === 'shared';
  } catch {
    return false;
  }
}

/** Variable NAMES matching INHERITED_NAME in one text (dotenv lines or ecosystem `KEY:` entries). */
function inheritedNamesIn(text) {
  const names = new Set();
  for (const match of text.matchAll(/(?:^|[\s{,'"])(?:export\s+)?([A-Z][A-Z0-9_]*)['"]?\s*[:=]/gm)) {
    if (INHERITED_NAME.test(match[1])) names.add(match[1]);
  }
  return [...names].sort();
}

/** Per source (.env, config/node.env, ecosystem files): the inherited-credential names it sets. */
function inheritedCredentialVariables(root) {
  const out = {};
  for (const rel of ['.env', path.join('config', 'node.env'), ...ecosystemFiles(root)]) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const names = inheritedNamesIn(text);
    if (names.length > 0) out[rel] = names;
  }
  return out;
}

function buildReport(args) {
  const dotenv = readDotenv(path.join(args.root, '.env'));
  const dbPath = path.resolve(args.root, args.db ?? process.env.DATABASE_PATH ?? dotenv.DATABASE_PATH ?? 'server/database/auth.db');
  const sources = platformSources(args.root, dotenv);
  const effective = sources.some((s) => s.value === 'true');
  const facts = readDatabase(args.root, dbPath);
  const refuse = effective && facts.activeUserCount > 1;
  return {
    root: args.root,
    databasePath: dbPath,
    platformMode: { effective, sources },
    ...facts,
    installWideVendorKeys: installWideKeys(args.home),
    inheritedCredentialVariables: inheritedCredentialVariables(args.root),
    verdict: refuse ? 'would_refuse_boot' : 'ok',
    // Before ADR-152 A1 the guard exempted a stored `claude = shared`.
    changedByUpgrade: refuse && claudeWasShared(facts.providerSharing.value),
  };
}

function printHuman(report) {
  const lines = [
    `node root: ${report.root}`,
    `database: ${report.databasePath} (opened read-only)`,
    `platform mode: ${report.platformMode.effective ? 'ON' : 'off'}`
      + (report.platformMode.sources.length
        ? ` (${report.platformMode.sources.map((s) => `${s.source}=${s.value}`).join(', ')})`
        : ' (not set anywhere)'),
    `active users: ${report.activeUserCount}`,
    `app_config provider_sharing: ${report.providerSharing.present ? report.providerSharing.value : 'absent'}`,
    `install-wide vendor keys: ${report.installWideVendorKeys.present.join(', ') || 'none'}`
      + ` (store ${report.installWideVendorKeys.state}; presence only)`,
    `other install-wide secrets (not vendor slots): ${report.installWideVendorKeys.otherSecrets.join(', ') || 'none'}`,
    `inherited credential variables: ${Object.entries(report.inheritedCredentialVariables)
      .map(([source, names]) => `${source}: ${names.join(', ')}`).join('; ') || 'none'} (names only)`,
    `retirement snapshot table: ${report.retirementSnapshotTable ? 'present' : 'absent'}`,
    `verdict: ${report.verdict === 'would_refuse_boot' ? 'WOULD REFUSE BOOT' : 'ok'}`
      + (report.changedByUpgrade ? ' — newly, because claude was stored as shared' : ''),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  let report;
  try {
    const args = parseArgs(process.argv.slice(2));
    report = buildReport(args);
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report);
  } catch (error) {
    process.stderr.write(`fleet-sharing-preflight: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = report.verdict === 'would_refuse_boot' ? 2 : 0;
}

main();
