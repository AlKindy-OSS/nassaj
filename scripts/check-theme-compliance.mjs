#!/usr/bin/env node
/**
 * STYLE_LOCK §2 — theme-preset compliance check.
 *
 * Raw Tailwind neutral surfaces (`bg-white`, `bg-gray-100`, `text-gray-900`,
 * `border-gray-200`, …) are frozen greys: they never read `--card`/`--muted`/
 * `--border`, so every brand preset in `src/lib/theme-presets.ts` leaves them
 * behind — a white card stranded on a cream background, a charcoal tooltip over
 * a warm surface. This script fails the build when new ones appear.
 *
 * It runs as a standalone check rather than an ESLint rule because
 * `eslint.config.js` is write-protected in this environment. The rule itself
 * lives in `eslint-style-lock-plugin.js` (`styleLock/no-raw-palette-surface`)
 * and can be wired into the flat config whenever that protection is lifted;
 * both read the same `SURFACE_REPLACEMENTS` table.
 *
 * Usage:
 *   node scripts/check-theme-compliance.mjs            # enforce the baseline
 *   node scripts/check-theme-compliance.mjs --list     # print every violation
 *   node scripts/check-theme-compliance.mjs --update   # re-baseline after a sweep
 *
 * Two exemptions, both requiring a written reason:
 *   `design-ok: <reason>`       — on the line (or the line above it), for a
 *                                 single deliberate deviation.
 *   `design-ok-file: <reason>`  — anywhere in the file, for surfaces that are
 *                                 dark by nature in BOTH modes (a terminal, a
 *                                 code block, an image viewer). Those are not
 *                                 unthemed leftovers; theming them would be the
 *                                 bug.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SURFACE_REPLACEMENTS } from '../eslint-style-lock-plugin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const BASELINE = path.join(ROOT, 'scripts', 'theme-compliance-baseline.json');

/** Shared primitives strand every screen that mounts them — zero tolerance. */
const STRICT_PREFIX = path.join('src', 'shared', 'view', 'ui');

const SKIP_RE = /\.test\.[tj]sx?$|__tests__|\.stories\./;

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, out);
    } else if (/\.[tj]sx$/.test(entry.name) && !SKIP_RE.test(full)) {
      out.push(full);
    }
  }
  return out;
}

function violationsIn(file) {
  const rel = path.relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  if (/design-ok-file:/i.test(src)) return [];

  const lines = src.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    // The class string is often long enough that the reason reads better on the
    // line above, so accept it there too.
    if (/design-ok/i.test(line) || /design-ok/i.test(lines[i - 1] ?? '')) return;
    for (const [re, suggest] of SURFACE_REPLACEMENTS) {
      const m = line.match(re);
      if (m) {
        found.push({ file: rel, line: i + 1, match: m[0], suggest });
        break;
      }
    }
  });
  return found;
}

const argv = process.argv.slice(2);
const files = await collect(SRC);
const all = files.flatMap(violationsIn);

const counts = {};
for (const v of all) counts[v.file] = (counts[v.file] || 0) + 1;

if (argv.includes('--list')) {
  for (const v of all) {
    console.log(`${v.file}:${v.line}  ${v.match}  →  ${v.suggest}`);
  }
  console.log(`\n${all.length} violation(s) across ${Object.keys(counts).length} file(s).`);
  process.exit(0);
}

if (argv.includes('--update')) {
  const prior = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).files ?? {} : {};
  const files = Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, allowed]) => [
        f,
        { allowed, reason: prior[f]?.reason ?? 'TODO: اشرح سبب البقاء أو اكنس الملف.' },
      ])
  );
  writeFileSync(BASELINE, `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(
    `baseline updated: ${all.length} violation(s) across ${Object.keys(counts).length} file(s).`
  );
  process.exit(0);
}

/**
 * Baseline entries are `{ allowed, reason }`. The reason is mandatory in spirit:
 * an accepted deviation with no written justification is indistinguishable from
 * one nobody looked at. Some deviations cannot carry an inline `design-ok`
 * comment at all — a class string inside a JSX attribute or an object literal
 * has no syntactically valid place for one — which is why they live here.
 */
const rawBaseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const baseline = Object.fromEntries(
  Object.entries(rawBaseline.files ?? rawBaseline).map(([f, v]) => [
    f,
    typeof v === 'number' ? v : v.allowed,
  ])
);
const failures = [];

for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0;
  const strict = file.startsWith(STRICT_PREFIX);
  if (strict && count > 0) {
    failures.push(`${file}: ${count} raw surface(s) — shared primitives allow none.`);
  } else if (count > allowed) {
    failures.push(`${file}: ${count} raw surface(s), baseline allows ${allowed}.`);
  }
}

if (failures.length) {
  console.error('STYLE_LOCK §2 — raw palette surfaces ignore theme presets:\n');
  for (const f of failures) console.error(`  ✖ ${f}`);
  console.error(
    '\nUse the semantic token (bg-card / bg-muted / text-foreground /' +
      ' text-muted-foreground / border-border), or add `design-ok: <reason>`' +
      ' on the line. Run with --list to see every hit.'
  );
  process.exit(1);
}

const swept = Object.entries(baseline).filter(([f, n]) => (counts[f] ?? 0) < n).length;
console.log(
  `STYLE_LOCK §2 clean: ${all.length} known violation(s) in ${Object.keys(counts).length} file(s)` +
    (swept ? `, ${swept} file(s) improved below baseline — run --update to lock the gain.` : '.')
);
