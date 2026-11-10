/**
 * bash-command-split — splits a shell command into the simple commands Claude's Bash
 * rules are matched against (T-2089, ADR-225; qa round 3 against
 * code.claude.com/docs/en/permissions, 2026-11-07). Conservative by construction:
 *  - control operators `&&` `||` `;` `|` `&`, newlines and subshell parens `( )` split,
 *    outside quotes; the keywords `if then do else elif while until ! { }` that open a
 *    body are dropped, so `if x; then cmd; fi` and `for …; do cmd; done` expose `cmd`;
 *  - `$(...)` and backtick bodies (also inside double quotes) are split recursively and
 *    added as parts; the enclosing part keeps its literal text;
 *  - `bash|sh|zsh|dash -c <string>` adds the split of <string>;
 *  - redirections are removed from the part; `>` `>>` `>|` `&>` `>& file` `<>` targets are
 *    `writes` (an allow never covers them), `<` `<>` targets are `reads`;
 *  - `denyParts` (deny/ask side only, stricter): every part, the part with Claude's
 *    wrappers stripped (timeout, time, nice, nohup, stdbuf, command, builtin, noglob,
 *    xargs, env assignments), and each of those de-quoted / de-backslashed;
 *  - `fileWrites` / `fileReads` (deny/ask side only): redirection targets (also attached:
 *    `x>/f`) plus the file arguments of tee, sed (-i), dd of=/if= and common file writers /
 *    readers, for Edit and Read path rules; `cdTargets` lists `cd` dirs of the chain;
 *  - anything this splitter cannot read for certain (unbalanced quotes or substitutions,
 *    heredocs, process substitution) sets `parseable: false`. Callers then match deny/ask
 *    conservatively against the raw text and never allow.
 */

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const REDIRECT = /^(?:\d*|&)(>>|>\||>&|<>|<&|>|<)(.*)$/;
const OPENERS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', '{', '}']);
const CLOSERS = new Set(['fi', 'done', 'esac', '}']);
const PLAIN_WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin', 'noglob']);
/** Wrapper options that take a separate value (`timeout -s KILL`, `nice -n 5`, `xargs -I {}`). */
const VALUE_OPTIONS = { timeout: ['-s', '-k', '--signal', '--kill-after'], nice: ['-n', '--adjustment'],
  stdbuf: ['-i', '-o', '-e'], xargs: ['-I', '-n', '-d', '-P', '-L', '-s', '-E', '-a', '-i'] };
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed', 'less', 'more', 'grep', 'egrep', 'fgrep', 'awk', 'cut', 'sort',
  'uniq', 'wc', 'diff', 'nl', 'tac', 'base64', 'xxd', 'od', 'strings', 'cmp', 'file', 'stat', 'cp']);
const WRITE_COMMANDS = new Set(['tee', 'touch', 'rm', 'mv', 'cp', 'truncate', 'mkdir', 'rmdir', 'ln', 'chmod', 'chown', 'install',
  'sed']);

/** Index just past the `)` closing a `$(` that opened before `start`; -1 when unbalanced. */
function closingParen(text, start) {
  let depth = 1;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && quote !== "'") { i += 1; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')' && (depth -= 1) === 0) return i + 1;
  }
  return -1;
}

/** Length of the control operator at `i` (0 when none). */
function operatorAt(text, i, current) {
  const ch = text[i];
  const two = text.slice(i, i + 2);
  if (two === '&&' || two === '||') return 2;
  if (ch === '|') return /[<>]$/.test(current) ? 0 : 1; // `>|` is a redirection
  if (ch === '&') return /[<>]$/.test(current) || text[i + 1] === '>' ? 0 : 1;
  return ';\n()'.includes(ch) ? 1 : 0;
}

/** Splits `text` at top-level control operators and parens; collects substitution bodies. */
function scan(text, state) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (ch === '\\' && quote !== "'") { current += text.slice(i, i + 2); i += 1; continue; }
    if (quote === "'") { current += ch; if (ch === "'") quote = null; continue; }
    if (two === '$(' || ch === '`') {
      const end = ch === '`' ? text.indexOf('`', i + 1) + 1 : closingParen(text, i + 2);
      if (end <= 0) { state.parseable = false; return segments; }
      state.nested.push(text.slice(i + (ch === '`' ? 1 : 2), end - 1));
      current += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (quote === '"') { current += ch; if (ch === '"') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (two === '<<' || two === '<(' || two === '>(') { state.parseable = false; current += ch; continue; }
    const operator = operatorAt(text, i, current);
    if (operator) { segments.push(current); current = ''; i += operator - 1; continue; }
    current += ch;
  }
  if (quote) state.parseable = false;
  segments.push(current);
  return segments;
}

/** Shell words of one simple command (quotes kept), split on unquoted whitespace. */
function words(segment) {
  const out = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '\\' && quote !== "'") { current += segment.slice(i, i + 2); i += 1; continue; }
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (/\s/.test(ch)) { if (current) out.push(current); current = ''; continue; }
    // An attached redirection (`x>/f`, `a<b`) starts its own word; `2>`, `&>`, `>>` stay whole.
    if ((ch === '<' || ch === '>') && current && !/^(\d+|&)$/.test(current) && !/[<>&|]$/.test(current)) {
      out.push(current);
      current = '';
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

const unquote = (word) => word.replace(/^(['"])([\s\S]*)\1$/, '$2');
/** A word with every quote and backslash escape removed (`"rm"`, `r\m` → `rm`). */
export const dequote = (word) => word.replace(/\\(.)/g, '$1').replace(/['"]/g, '');

/** Removes redirections from `list`, recording their file targets. */
function stripRedirections(list, state) {
  const kept = [];
  for (let i = 0; i < list.length; i += 1) {
    const match = REDIRECT.exec(list[i]);
    if (!match) {
      if (/^[^'"]*[<>]/.test(list[i])) state.writes.push(list[i]);
      kept.push(list[i]);
      continue;
    }
    const [, op, rest] = match;
    const target = unquote(rest || list[(i += 1)] || '');
    const fd = /^(\d+|-)$/.test(target) || target === '';
    if (op === '<&' || (op === '>&' && fd)) continue;
    if (op === '<' || op === '<>') state.reads.push(target);
    if (op !== '<' && target !== '/dev/null') state.writes.push(target);
  }
  return kept;
}

/**
 * Drops body-opening keywords and closing words in front (`then cmd`, `do cmd`, `}`, `done`):
 * after a `;` they start their own segment. A trailing word is an argument (`echo done`).
 */
function stripKeywords(list) {
  let start = 0;
  while (start < list.length && (OPENERS.has(list[start]) || CLOSERS.has(list[start]))) start += 1;
  return list.slice(start);
}

/** Drops options of `wrapper` (and their separate values) from the front of `rest`. */
function dropOptions(wrapper, rest) {
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) {
    i += (VALUE_OPTIONS[wrapper] ?? []).includes(rest[i]) ? 2 : 1;
  }
  return rest.slice(i);
}

/** The command under Claude's wrappers (repeatedly), with env assignments dropped. */
export function unwrapCommand(list) {
  let current = list;
  for (;;) {
    const [head, ...rest] = current;
    let next = current;
    if (head !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) next = rest;
    else if (PLAIN_WRAPPERS.has(head)) next = dropOptions(head, rest);
    else if (head === 'timeout') next = dropOptions('timeout', rest).slice(1);
    else if (head === 'nice' || head === 'stdbuf' || head === 'xargs') next = dropOptions(head, rest);
    if (next === current || next.length === 0) return current;
    current = next;
  }
}

/** File arguments of known readers / writers (deny/ask side). */
function fileArguments(list, state) {
  const [head, ...rest] = list.map(dequote);
  const args = rest.filter((word) => word && !word.startsWith('-'));
  if (WRITE_COMMANDS.has(head)) state.fileWrites.push(...args);
  if (READ_COMMANDS.has(head)) state.fileReads.push(...args);
  if (head === 'dd') {
    for (const word of args) {
      if (word.startsWith('of=')) state.fileWrites.push(word.slice(3));
      if (word.startsWith('if=')) state.fileReads.push(word.slice(3));
    }
  }
  if (head === 'cd' && args[0]) state.cdTargets.push(args[0]);
}

/** Adds one simple command and its deny-side variants. */
function addPart(list, state, depth) {
  state.parts.push(list.join(' '));
  const unwrapped = unwrapCommand(list);
  for (const variant of [list, unwrapped]) {
    state.denyParts.add(variant.join(' '));
    state.denyParts.add(variant.map(dequote).join(' '));
  }
  fileArguments(unwrapped, state);
  const shell = dequote(unwrapped[0] ?? '').split('/').pop();
  const flag = unwrapped.indexOf('-c');
  if (SHELLS.has(shell) && flag > 0 && unwrapped[flag + 1]) splitInto(unquote(unwrapped[flag + 1]), state, depth + 1);
}

/** Recursive worker: adds the parts of `text` to `state`. */
function splitInto(text, state, depth) {
  if (depth > 8) { state.parseable = false; return; }
  for (const segment of scan(text, state)) {
    const list = stripKeywords(stripRedirections(words(segment), state));
    if (list.length > 0) addPart(list, state, depth);
  }
  const nested = state.nested.splice(0);
  for (const body of nested) splitInto(body, state, depth + 1);
}

/**
 * @param {string} command the raw Bash command
 * @returns {{ parts: string[], denyParts: string[], writes: string[], reads: string[],
 *   fileWrites: string[], fileReads: string[], parseable: boolean }}
 */
export function splitBashCommand(command) {
  const state = { parts: [], denyParts: new Set(), writes: [], reads: [], fileWrites: [], fileReads: [], cdTargets: [], nested: [],
    parseable: true };
  splitInto(String(command), state, 0);
  return { parts: state.parts, denyParts: [...state.denyParts], writes: state.writes, reads: state.reads,
    fileWrites: [...state.writes, ...state.fileWrites], fileReads: [...state.reads, ...state.fileReads], cdTargets: state.cdTargets,
    parseable: state.parseable };
}
