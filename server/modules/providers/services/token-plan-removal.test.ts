/**
 * ADR-200 S7 — tripwire: the Coding Plan consent, `sk-sp-` requirement and
 * interactive-only guard are gone, and no source file references their symbols
 * again. Test files are skipped (they may name a symbol to prove its absence);
 * the names below are assembled from parts so this file never matches itself.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const SCANNED_DIRS = ['server', 'src', 'shared'];
const SOURCE_FILE = /\.(?:[cm]?js|tsx?)$/;
const SKIPPED_FILE = /\.test\.(?:[cm]?js|tsx?)$|\.d\.ts$/;
const SKIPPED_DIR = new Set(['node_modules', 'dist', 'dist-server', '.git', '__tests__']);

const REMOVED_SYMBOLS = [
  ['is', 'Qwen', 'CodingPlanKey'],
  ['QWEN_', 'CONSENT_VERSION'],
  ['CONSENT_REQUIRED_', 'COMPANIES'],
  ['company', 'ConsentVersion'],
  ['NOT_', 'INTERACTIVE'],
  ['INCOMPATIBLE_', 'PROFILE'],
  ['is', 'Qwen', 'InteractiveTurn'],
  ['QWEN_', 'INTERACTIVE_AUTH_KINDS'],
  ['without', 'ClientQwenMarker'],
  ['qwen', 'InteractiveVerified'],
  ['qwen_plan_', 'not_interactive'],
  ['redact', 'QwenPlanSecrets'],
  ['INVALID_QWEN_', 'CODING_PLAN_KEY'],
].map((parts) => parts.join(''));

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (SOURCE_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

test('no source file references a removed Coding Plan / interactive-guard symbol', () => {
  const files = SCANNED_DIRS.flatMap((dir) => listSourceFiles(path.join(ROOT, dir)));
  assert.ok(files.length > 100, `scanned ${files.length} files under ${ROOT}`);
  const hits: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const symbol of REMOVED_SYMBOLS) {
      if (text.includes(symbol)) hits.push(`${path.relative(ROOT, file)}: ${symbol}`);
    }
  }
  assert.deepEqual(hits, []);
});
