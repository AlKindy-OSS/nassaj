/**
 * ADR-201 A1 — CI early warning, NOT a guarantee: a by-name read
 * (`createReadStream` / `readFile` / `open(`) whose argument names a stored
 * transcript path (`jsonl_path`, `jsonlPath`, `transcriptPath`, …) must not
 * appear in server code outside the shared transcript module. Such a read
 * bypasses tree confinement, the header id check and the pinned descriptor.
 *
 * A one-line grep misses a path passed through another variable; the real
 * guarantee is the negative test per migrated reader. Readers not yet migrated
 * are listed below by file with the reason, so a NEW hit fails with its list,
 * and a listed file that no longer matches fails too (drop its entry).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** A by-name read whose first argument line mentions a stored transcript path. */
const BY_NAME_READ = /\b(?:createReadStream|readFileSync|readFile|openSync|open)\(\s*[^)]*\b(?:jsonl_path|jsonlPath|storedJsonlPath|transcriptPath|transcriptFile|rolloutPath)\b/;

/** Names that hold a stored transcript path wherever they appear. */
const STORED_PATH = /\b(?:jsonl_path|jsonlPath|storedJsonlPath|transcriptPath|transcriptFile|rolloutPath)\b/;

/**
 * Calls that open, read or resolve a file or directory by name: `fs`/`fsp`
 * functions called bare or on an fs namespace — never a method of a pinned
 * handle (`handle.readFile`, `transcript.fd.stat`). `realpath` counts (the old
 * skill readers resolved the stored path here and opened the result in another
 * file); metadata probes (`lstat`, `stat`) read nothing and stay allowed.
 */
const PATH_SINK = /(?:(?<![\w.$])|\b(?:fs|fsp|fsSync|promises)\.)(createReadStream|readFileSync|readFile|openSync|open|realpathSync|realpath|opendirSync|opendir|readdirSync|readdir)\(/g;
const RESOLVE_SINKS = new Set(['realpath', 'realpathSync']);

/** Calls whose result is (a spelling of) their path argument; any other call's result is not a path. */
const PATH_PRESERVING = new Set(['join', 'resolve', 'dirname', 'normalize', 'realpath', 'realpathSync', 'trim', 'String']);

/** Text of the balanced `(...)` group opening at `open` (the index of `(`), or null. */
function balancedArgs(text: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if ('([{'.includes(text[index])) depth += 1;
    else if (')]}'.includes(text[index]) && --depth === 0) return text.slice(open + 1, index);
  }
  return null;
}

/** Top-level comma split of an argument or parameter list. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    if ('([{<'.includes(list[index])) depth += 1;
    else if (')]}>'.includes(list[index])) depth -= 1;
    else if (list[index] === ',' && depth === 0) { parts.push(list.slice(start, index)); start = index + 1; }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

type FunctionBlock = { name: string; params: string[]; start: number; body: string };

/** A function declaration line: top-level `function`, `const x = (…) =>`, or a 2-space class method. */
const DECLARATION = /^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*(?:<[^(]*>)?\(|(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(|\s{2}(?:(?:private|public|protected|static|async|readonly)\s+)*(?!(?:if|for|while|switch|return|await|catch|const|let|new|throw)\b)(\w+)\s*\()/;

/** Functions of `source` with their parameter names and body text (heuristic, line based). */
function functionBlocks(source: string): FunctionBlock[] {
  const lines = source.split('\n');
  const starts: Array<{ line: number; name: string }> = [];
  lines.forEach((line, index) => {
    const match = DECLARATION.exec(line);
    if (match) starts.push({ line: index, name: match[1] ?? match[2] ?? match[3] });
  });
  return starts.map(({ line, name }, index) => {
    const end = starts[index + 1]?.line ?? lines.length;
    const body = lines.slice(line, end).join('\n');
    const params = splitTopLevel(balancedArgs(body, body.indexOf('(')) ?? '')
      .map((param) => /^(?:\.\.\.)?(\w+)/.exec(param)?.[1] ?? '').filter(Boolean);
    return { name, params, start: line, body };
  });
}

/**
 * `expr` with the argument list of every call that is not path-preserving
 * blanked out: `createState(row.jsonl_path)` returns a state, not a path, while
 * `path.join(dirname(jsonlPath), x)` is still the path.
 */
function pathPart(expr: string): string {
  let out = expr;
  const call = /(?<![\w$])((?:\w+\.)*(\w+))\s*\(/g;
  for (let match = call.exec(out); match; match = call.exec(out)) {
    if (PATH_PRESERVING.has(match[2])) continue;
    const open = match.index + match[0].length - 1;
    const args = balancedArgs(out, open);
    if (args === null) break;
    out = `${out.slice(0, open + 1)}${' '.repeat(args.length)}${out.slice(open + 1 + args.length)}`;
  }
  return out;
}

/** True when the path part of `expr` names a stored path or a tainted identifier (not as a property). */
function mentions(expr: string, tainted: ReadonlySet<string>): boolean {
  const part = pathPart(expr);
  if (STORED_PATH.test(part)) return true;
  return [...tainted].some((name) => new RegExp(`(?<![\\w.$])${name}\\b`).test(part));
}

/** Calls `callee(args)` in `body`, with their top-level arguments. */
function* callsIn(body: string): Generator<{ callee: string; args: string[]; index: number }> {
  const call = /(?<![\w.$])(\w+)\s*\(/g;
  for (let match = call.exec(body); match; match = call.exec(body)) {
    const args = balancedArgs(body, match.index + match[0].length - 1);
    if (args !== null) yield { callee: match[1], args: splitTopLevel(args), index: match.index };
  }
}

/**
 * Intra-file taint: a variable assigned from a stored path (or from a tainted
 * variable), and a parameter of an in-file function called with one, are
 * tainted — whatever they are named. Iterates to a fixpoint.
 */
function taintedNames(blocks: FunctionBlock[]): Map<FunctionBlock, Set<string>> {
  const taint = new Map(blocks.map((block) => [block, new Set<string>()] as const));
  const byName = new Map(blocks.map((block) => [block.name, block] as const));
  const assignment = /(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g;
  for (let changed = true; changed;) {
    changed = false;
    const add = (block: FunctionBlock, name: string) => {
      const set = taint.get(block)!;
      if (!set.has(name)) { set.add(name); changed = true; }
    };
    for (const block of blocks) {
      const own = taint.get(block)!;
      for (let match = assignment.exec(block.body); match; match = assignment.exec(block.body)) {
        if (mentions(match[2], own)) add(block, match[1]);
      }
      for (const { callee, args } of callsIn(block.body)) {
        const target = byName.get(callee);
        if (!target || target === block) continue;
        args.forEach((arg, index) => { if (target.params[index] && mentions(arg, own)) add(target, target.params[index]); });
      }
    }
  }
  return taint;
}

type TracedRead = { line: number; text: string; resolveOnly: boolean };

/** Every by-name read (or resolve) of a traced stored transcript path in `source`. */
function tracedReads(source: string): TracedRead[] {
  const blocks = functionBlocks(source);
  const taint = taintedNames(blocks);
  const hits: TracedRead[] = [];
  for (const block of blocks) {
    const own = taint.get(block)!;
    for (let match = PATH_SINK.exec(block.body); match; match = PATH_SINK.exec(block.body)) {
      const args = balancedArgs(block.body, match.index + match[0].length - 1);
      const first = args === null ? '' : splitTopLevel(args)[0] ?? '';
      if (!mentions(first, own)) continue;
      const line = block.start + block.body.slice(0, match.index).split('\n').length;
      hits.push({ line, text: block.body.split('\n')[line - block.start - 1].trim(), resolveOnly: RESOLVE_SINKS.has(match[1]) });
    }
  }
  return hits;
}

/** The shared transcript module: the one place allowed to open these paths (pinned). */
const SHARED_MODULE = new Set([
  'modules/providers/shared/pinned-fd.ts',
  'modules/providers/shared/session-transcript.ts',
  'modules/providers/shared/session-transcript-reader.ts',
  'modules/providers/shared/session-transcript-specs.ts',
  'modules/providers/shared/transcript-header-scan.ts',
]);

/**
 * By-name readers that cannot use the pinned reader yet, each with its reason.
 * Since the traced check (ADR-201 qa M1) also sees a path passed through other
 * names, the session-fork reader (backlog L2) is listed here. A new entry needs
 * a documented reason; a listed file that stops matching fails.
 */
const KNOWN_UNMIGRATED: Readonly<Record<string, string>> = Object.freeze({
  'modules/providers/services/session-fork.service.ts':
    'ADR-201 L2 (backlog): the fork source is lstat/realpath-checked (single link, project root, <id>.jsonl) '
    + 'but not opened through the pinned reader yet.',
});

const SKIPPED_DIRS = new Set(['node_modules', '__tests__', '__fixtures__', 'dist']);
const SOURCE_FILE = /\.(?:ts|js|mjs|cjs)$/;
const TEST_FILE = /\.test\.(?:ts|js|mjs)$/;

/** Server source files (non-test), relative to server/. */
function serverSources(dir: string = SERVER_ROOT): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...serverSources(path.join(dir, entry.name)));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(path.relative(SERVER_ROOT, path.join(dir, entry.name)));
    }
  }
  return files;
}

/**
 * Files whose traced `realpath` of a stored path only canonicalises it — for a
 * cache key or an identity hash — while every open of it is pinned. Only their
 * `realpath` hits are exempt; an open or read by name still fails.
 */
const RESOLVE_ONLY: Readonly<Record<string, string>> = Object.freeze({
  'modules/providers/services/cost/session-cost.service.ts':
    'realpath(transcriptPath) is the cost cache key; the transcript is read through its pinned CostTranscript.',
  'modules/providers/services/cost/usage-statistics-v3.service.ts':
    'realpath canonicalises manifest locators for their identity hash; opens are openPinned single-link (ADR-201 L1).',
});

/** `file:line` of every by-name transcript read in `file` (one-line pattern or traced). */
function byNameReads(file: string): string[] {
  const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
  const lines = new Map<number, string>();
  source.split('\n').forEach((line, index) => { if (BY_NAME_READ.test(line)) lines.set(index + 1, line.trim()); });
  for (const hit of tracedReads(source)) {
    if (!(hit.resolveOnly && Object.hasOwn(RESOLVE_ONLY, file))) lines.set(hit.line, hit.text);
  }
  return [...lines].sort(([a], [b]) => a - b).map(([line, text]) => `${file}:${line}: ${text}`);
}

test('no by-name transcript read outside the shared transcript module (early warning)', () => {
  const hits = serverSources()
    .filter((file) => !SHARED_MODULE.has(file) && !Object.hasOwn(KNOWN_UNMIGRATED, file))
    .flatMap(byNameReads);
  assert.deepEqual(hits, [], `by-name transcript reads (use openSessionTranscript / openRecordedTranscript):\n${hits.join('\n')}`);
});

test('every known-unmigrated entry still matches (stale entries are removed)', () => {
  const stale = Object.keys(KNOWN_UNMIGRATED).filter((file) =>
    !fs.existsSync(path.join(SERVER_ROOT, file)) || byNameReads(file).length === 0);
  assert.deepEqual(stale, [], `drop these entries, they no longer read by name:\n${stale.join('\n')}`);
});

test('every resolve-only entry still has a traced realpath (stale entries are removed)', () => {
  const stale = Object.keys(RESOLVE_ONLY).filter((file) => !fs.existsSync(path.join(SERVER_ROOT, file))
    || !tracedReads(fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8')).some((hit) => hit.resolveOnly));
  assert.deepEqual(stale, [], `drop these entries:\n${stale.join('\n')}`);
});

/**
 * The pre-M1 skill-observation reader (skill-observations.service.ts at
 * 4ca4e1c4d, abridged): the stored path reaches `realpath` and the confined
 * open through a parameter that the one-line pattern never sees.
 */
const PRE_M1_SKILL_READER = `
async function createState(principal: number, provider: 'claude' | 'codex', sessionId: string,
  owner: number, file: string | null, workspace: string | null, scope: string): Promise<SkillScanState | null> {
  if (!file) return null;
  const home = readOnlyHome(owner, provider);
  try {
    const root = await realpath(path.join(home, provider === 'codex' ? 'sessions' : 'projects'));
    const target = await realpath(file);
    if (!target.startsWith(\`\${root}\${path.sep}\`)) return null;
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    return null;
  } catch { return null; }
}

export async function readSessionSkills(sessionId: string, provider: string, userId: number | null) {
  const auth = authorize(sessionId, provider, userId);
  const state = await createState(auth.principal, provider, sessionId, auth.owner!, auth.row.jsonl_path, auth.row.project_path, auth.scope);
  return state;
}
`;

test('M1: the traced check flags the pre-M1 skill reader, whatever its variables are called', () => {
  const lines = (source: string) => tracedReads(source).map((hit) => hit.text);
  assert.deepEqual(lines(PRE_M1_SKILL_READER), [
    'const target = await realpath(file);',
    'const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);',
  ]);
  const renamed = PRE_M1_SKILL_READER.replaceAll('file', 'anything').replaceAll('target', 'resolvedThing');
  assert.equal(lines(renamed).length, 2, 'renaming the variables changes nothing');
  // A state object built from the path is not itself a path; a pinned handle read is not a by-name read.
  assert.deepEqual(lines(`
async function caller(row: Row) {
  const state = await createState(row.jsonl_path);
  const opened = await openRecordedTranscript(row, 'history');
  await opened.fd.readFile({ encoding: 'utf8' });
  return readFile(state.homeConfig, 'utf8');
}
`), []);
});

test('the pattern catches the shapes A-P2 removed and ignores pinned reads', () => {
  for (const line of [
    'const fileStream = fsSync.createReadStream(session.jsonl_path);',
    "const content = await readFile(jsonlPath, 'utf8');",
    "const handle = await open(filePath ?? row.jsonl_path, 'r');",
    'const rfd = fs.openSync(transcriptPath, "r");',
  ]) assert.ok(BY_NAME_READ.test(line), line);
  for (const line of [
    'const rl = readline.createInterface({ input: pinnedReadStream(opened.fd) });',
    "return await transcript.fd.readFile({ encoding: 'utf8' });",
    'const opened = await openRecordedTranscript(row, "search");',
  ]) assert.ok(!BY_NAME_READ.test(line), line);
});
