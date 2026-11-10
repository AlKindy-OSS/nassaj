/**
 * path-rule-match — Claude path rule anchoring and matching for the parity engine
 * (T-2089, ADR-225). Anchors: `//x` absolute; `~/x` a home (allow: Claude's HOME only;
 * deny/ask: Claude's AND dsh's HOME); `/x` relative to the settings file's own dir;
 * `x` and `./x` relative to cwd. Globs: `**` any depth, `*` and `?` within one segment.
 * A pattern with no `/` matches the basename at any depth for deny/ask (gitignore), and
 * directly under its anchor for allow (stricter). Paths are matched after normalization
 * (resolve `..`) and after realpath: deny/ask match when EITHER does, allow when BOTH do.
 */
import fs from 'node:fs';
import path from 'node:path';

const escape = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Glob (already anchored, absolute) → RegExp; a trailing `/**` also matches the dir itself. */
function globRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (glob.startsWith('/**', i) && i + 3 === glob.length) { source += '(?:/.*)?'; break; }
    if (glob.startsWith('**/', i)) { source += '(?:.*/)?'; i += 2; continue; }
    if (glob.startsWith('**', i)) { source += '.*'; i += 1; continue; }
    source += ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : escape(ch);
  }
  return new RegExp(`^${source}$`);
}

/**
 * Anchored matchers of one path specifier.
 * @param {string} specifier e.g. `//etc/**`, `~/notes/**`, `/policy/**`, `src/**`
 * @param {'allow'|'deny'|'ask'} effect
 * @param {{ cwd: string, settingsDir: string, claudeHome: string, dshHome: string }} anchors
 * @returns {RegExp[]}
 */
export function pathMatchers(specifier, effect, { cwd, settingsDir, claudeHome, dshHome }) {
  const spec = specifier.trim();
  let bases;
  let rest;
  if (spec.startsWith('//')) { bases = ['/']; rest = spec.slice(2); }
  else if (spec === '~' || spec.startsWith('~/')) {
    bases = effect === 'allow' ? [claudeHome] : [...new Set([claudeHome, dshHome])];
    rest = spec.slice(2);
  } else if (spec.startsWith('/')) { bases = [settingsDir]; rest = spec.slice(1); }
  else { bases = [cwd]; rest = spec.replace(/^\.\//, ''); }
  const anywhere = !rest.includes('/') && effect !== 'allow';
  return bases.map((base) => globRegExp(path.join(base, anywhere && rest ? `**/${rest}` : rest) || '/'));
}

/** realpath of the longest existing prefix of an absolute path, plus the rest. */
export function realPathOf(file) {
  const tail = [];
  let current = file;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return file;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Both forms of a path a decision is taken on: normalized and real. */
export function pathForms(file) {
  const normal = path.resolve(file);
  return { normal, real: realPathOf(normal) };
}

/** True when `forms` match `matchers` under the effect's rule (allow needs both forms). */
export function formsMatch(forms, matchers, effect) {
  const hit = (value) => matchers.some((re) => re.test(value));
  return effect === 'allow' ? hit(forms.normal) && hit(forms.real) : hit(forms.normal) || hit(forms.real);
}

/** True when both forms lie inside one of `dirs` (each also taken in both forms). */
export function insideDirs(forms, dirs) {
  const inside = (value, dir) => value === dir || value.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
  const all = dirs.flatMap((dir) => [path.resolve(dir), realPathOf(path.resolve(dir))]);
  return all.some((dir) => inside(forms.normal, dir)) && all.some((dir) => inside(forms.real, dir));
}
