#!/usr/bin/env node
// i18n gap scanner for #896 — deterministic source of truth for the translation gap.
// Committed (not /tmp) so it survives across sessions and is a stable WS-D gate.
// Reports per language/namespace: missing (en key absent in L), orphan (L key absent in en),
// untranslated (value byte-identical to en). Gate for WS-D: missing==0 AND orphan==0.
// Usage: node scripts/i18n-gap-scan.cjs   (paths derived from this file's location)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const LOCALES = path.join(ROOT, 'src/i18n/locales');
const OUT = path.join(ROOT, 'docs/workitems');
const REF = 'en';
const LANGS = ['de', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN'];
function flatten(obj, prefix = '', out = {}) {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
// Returns true when key K is a plural variant (e.g. sessionCount_few) whose
// base form has at least one plural form present in the reference namespace.
// Plural suffixes per i18next convention: zero/one/two/few/many/other.
const PLURAL_SUFFIX_RE = /^(.+)_(zero|one|two|few|many|other)$/;
function isPluralVariant(k, refKeys) {
  const m = PLURAL_SUFFIX_RE.exec(k);
  if (!m) return false;
  const base = m[1];
  // Check whether the reference namespace contains any plural form of the same base.
  return refKeys.some(rk => {
    const rm = PLURAL_SUFFIX_RE.exec(rk);
    return rm && rm[1] === base;
  });
}
function load(lang, ns) {
  const p = path.join(LOCALES, lang, ns);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { __parse_error__: e.message }; }
}
const namespaces = fs.readdirSync(path.join(LOCALES, REF)).filter(f => f.endsWith('.json'));
const refFlat = {};
for (const ns of namespaces) refFlat[ns] = flatten(load(REF, ns));
const refTotal = Object.values(refFlat).reduce((a, o) => a + Object.keys(o).length, 0);
const manifest = { reference: REF, refTotalKeys: refTotal, namespaces, languages: {} };
let gateClean = true;
for (const lang of LANGS) {
  const entry = { missingFiles: [], totalMissingKeys: 0, totalOrphanKeys: 0, totalUntranslated: 0, namespaces: {} };
  for (const ns of namespaces) {
    const refKeys = Object.keys(refFlat[ns]);
    const o = load(lang, ns);
    if (o === null) {
      entry.missingFiles.push(ns);
      entry.namespaces[ns] = { missingFile: true, missingCount: refKeys.length, missingKeys: refKeys, orphanCount: 0, orphanKeys: [], untranslatedCount: 0, untranslatedKeys: [] };
      entry.totalMissingKeys += refKeys.length;
      continue;
    }
    const lf = flatten(o);
    const langKeys = Object.keys(lf);
    const missing = refKeys.filter(k => !(k in lf));
    const orphan = langKeys.filter(k => !(k in refFlat[ns]) && !isPluralVariant(k, refKeys));
    const untranslated = refKeys.filter(k => (k in lf) && typeof refFlat[ns][k] === 'string' && lf[k] === refFlat[ns][k] && String(refFlat[ns][k]).trim().length > 1);
    entry.namespaces[ns] = { missingFile: false, missingCount: missing.length, missingKeys: missing, orphanCount: orphan.length, orphanKeys: orphan, untranslatedCount: untranslated.length, untranslatedKeys: untranslated };
    entry.totalMissingKeys += missing.length;
    entry.totalOrphanKeys += orphan.length;
    entry.totalUntranslated += untranslated.length;
  }
  manifest.languages[lang] = entry;
  if (entry.totalMissingKeys > 0 || entry.totalOrphanKeys > 0) gateClean = false;
}
fs.writeFileSync(path.join(OUT, 'i18n-gap-manifest.json'), JSON.stringify(manifest, null, 2));
let md = '# i18n Gap Manifest (#896) — auto-generated diagnostic\n\n> Run: `node scripts/i18n-gap-scan.cjs`. Reference `en` = ' + refTotal + ' keys / ' + namespaces.length + ' namespaces.\n> **WS-D gate: missing==0 AND orphan==0 per language.** `untranslated` = value byte-identical to en (review heuristic).\n> Full per-key arrays in `i18n-gap-manifest.json` — that JSON is the deterministic source, not this summary.\n\n| lang | missing | orphan | untranslated | missing files |\n|---|---|---|---|---|\n';
for (const lang of LANGS) {
  const L = manifest.languages[lang];
  md += '| ' + lang + ' | ' + L.totalMissingKeys + ' | ' + L.totalOrphanKeys + ' | ' + L.totalUntranslated + ' | ' + (L.missingFiles.join(', ') || '—') + ' |\n';
}
md += '\n## Per-namespace (only non-clean)\n\n';
for (const lang of LANGS) {
  const L = manifest.languages[lang];
  md += '### ' + lang + ' (missing ' + L.totalMissingKeys + ', orphan ' + L.totalOrphanKeys + ', untranslated ' + L.totalUntranslated + ')\n';
  for (const ns of namespaces) {
    const N = L.namespaces[ns];
    if (N.missingCount || N.orphanCount || N.untranslatedCount) {
      md += '- `' + ns + '`: missing ' + N.missingCount + (N.missingFile ? ' **(FILE MISSING)**' : '') + ', orphan ' + N.orphanCount + (N.orphanCount ? ' [' + N.orphanKeys.join(', ') + ']' : '') + ', untranslated ' + N.untranslatedCount + '\n';
    }
  }
  md += '\n';
}
fs.writeFileSync(path.join(OUT, 'i18n-gap-manifest.md'), md);
console.log('=== i18n GAP (vs en=' + refTotal + ' keys) ===');
for (const lang of LANGS) {
  const L = manifest.languages[lang];
  console.log(lang.padEnd(6) + ' missing=' + String(L.totalMissingKeys).padStart(4) + ' orphan=' + String(L.totalOrphanKeys).padStart(3) + ' untranslated=' + String(L.totalUntranslated).padStart(4) + (L.missingFiles.length ? '  MISSING_FILES=[' + L.missingFiles.join(',') + ']' : ''));
}
console.log('GATE (missing==0 && orphan==0 all langs): ' + (gateClean ? 'CLEAN' : 'NOT MET — work remaining'));
console.log('Manifest -> docs/workitems/i18n-gap-manifest.{json,md}');
process.exit(0);
