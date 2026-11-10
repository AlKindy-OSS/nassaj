// T-2089 S2: builds anonymized-managed-settings.json from a real Claude managed-settings
// file (default /etc/claude-code/managed-settings.json). Same keys, hook events, matchers,
// timeouts, rule effects, rule counts and rule SHAPES (tool name, exact / `:*` prefix / `*`
// glob, path anchors //, ~/, /, ./); every word, path segment, command and plugin name is
// replaced by a stable placeholder. Usage: node make-anonymized-settings.mjs [src] [out]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [src = '/etc/claude-code/managed-settings.json', out = path.join(here, 'anonymized-managed-settings.json')] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(src, 'utf8'));
const words = new Map();
const word = (w) => { if (!words.has(w)) words.set(w, `w${words.size + 1}`); return words.get(w); };
/** Keeps shell/glob/path punctuation and the rule shape; replaces every word. */
const anonymize = (text) => text.replace(/[A-Za-z0-9_.@$-]+/g, (w) => (/^\$?[A-Z_]+$/.test(w) && w.startsWith('$') ? w : word(w)));
const RULE = /^([A-Za-z][A-Za-z0-9_]*)(?:\(([\s\S]*)\))?$/;
const rule = (raw) => {
  const m = RULE.exec(raw);
  if (!m) return anonymize(raw);
  const [, tool, spec] = m;
  if (tool.startsWith('mcp__')) return `mcp__${word(tool.slice(5))}`;
  return spec === undefined ? tool : `${tool}(${spec === '*' ? '*' : anonymize(spec)})`;
};
let hookN = 0;
const result = { ...settings };
if (settings.enabledPlugins) {
  result.enabledPlugins = Object.fromEntries(Object.entries(settings.enabledPlugins).map(([, on], i) => [`plugin${i + 1}@market`, on]));
}
if (settings.hooks) {
  result.hooks = Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [event, groups.map((g) => ({
    ...g, hooks: g.hooks.map((h) => ({ ...h, command: `node $HOME/hooks/h${(hookN += 1)}.js` })),
  }))]));
}
if (settings.permissions) {
  result.permissions = { ...settings.permissions };
  for (const effect of ['allow', 'deny', 'ask']) {
    if (Array.isArray(settings.permissions[effect])) result.permissions[effect] = settings.permissions[effect].map(rule);
  }
  if (Array.isArray(settings.permissions.additionalDirectories)) {
    result.permissions.additionalDirectories = settings.permissions.additionalDirectories.map(anonymize);
  }
}
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
