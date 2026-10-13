/**
 * ADR-201 A1 — CI early warning, NOT a guarantee: a by-name read
 * (`createReadStream` / `readFile` / `open(`) whose argument names a stored
 * transcript path (`jsonl_path`, `jsonlPath`, `transcriptPath`, …) must not
 * appear in server code outside the shared transcript module. Such a read
 * bypasses tree confinement, the header id check and the pinned descriptor.
 * Since B-1596 the same holds for removing, moving or writing one by name
 * (`unlink`, `rm`, `rmdir`, `rename`, `appendFile`, `writeFile`, `truncate`),
 * and since B-1608 T3 for copying, linking or re-moding one (`copyFile`, `cp`,
 * `link`, `symlink`, `chmod`, `utimes`), also through aliased fs imports:
 * transcripts are removed only through `removeSessionTranscript`.
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
const READ_SINKS = [
  'createReadStream', 'readFileSync', 'readFile', 'openSync', 'open', 'realpathSync', 'realpath',
  'opendirSync', 'opendir', 'readdirSync', 'readdir',
];
const RESOLVE_SINKS = new Set(['realpath', 'realpathSync']);

/**
 * B-1596: calls that remove, move or write a file by name. Applied to a traced
 * stored path they bypass the confined deletion primitive
 * (`removeSessionTranscript`): a planted path or symlink would make them delete
 * or overwrite another member's file. `rename` is checked on both paths.
 */
const WRITE_SINKS = [
  'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'renameSync', 'rename', 'appendFileSync', 'appendFile',
  'writeFileSync', 'writeFile', 'truncateSync', 'truncate',
  // B-1608 T3: copying, linking or re-moding a transcript by name is as bad as writing it.
  'copyFileSync', 'copyFile', 'cpSync', 'cp', 'linkSync', 'link', 'symlinkSync', 'symlink',
  'chmodSync', 'chmod', 'lchmod', 'utimesSync', 'utimes', 'lutimes',
];
const TWO_PATH_SINKS = new Set([
  'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync',
]);
/** Namespaces every server file uses for `node:fs` / `node:fs/promises`. */
const FS_NAMESPACES = ['fs', 'fsp', 'fsSync', 'promises'];
const FS_MODULE = String.raw`['"](?:node:)?fs(?:/promises)?['"]`;

/** Local names bound to fs functions (`import { unlink as drop }`, `const { copyFile: dup } = fsp`) and fs namespaces. */
type FsBindings = { aliases: Map<string, string>; namespaces: string[] };

/** `a as b` / `a: b` specifiers of an import or destructuring list, into `aliases` (local → fs name). */
function addAliases(list: string, separator: RegExp, aliases: Map<string, string>): void {
  for (const spec of list.split(',')) {
    const [name, local] = spec.trim().split(separator).map((part) => part.trim());
    if (name && local && /^\w+$/.test(local)) aliases.set(local, name);
  }
}

/** B-1608 T3: the fs bindings of one source file (heuristic, import and destructuring lines). */
function fsBindingsOf(source: string): FsBindings {
  const aliases = new Map<string, string>();
  const namespaces = new Set(FS_NAMESPACES);
  for (const match of source.matchAll(new RegExp(String.raw`import\s+(?:(\w+)\s*,\s*)?\{([^}]*)\}\s*from\s*${FS_MODULE}`, 'g'))) {
    if (match[1]) namespaces.add(match[1]);
    addAliases(match[2], /\s+as\s+/, aliases);
  }
  for (const match of source.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*${FS_MODULE}`, 'g'))) {
    namespaces.add(match[1]);
  }
  const owners = [...namespaces].join('|');
  for (const match of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:${owners})(?:\.promises)?\s*;`, 'g'))) {
    addAliases(match[1], /\s*:\s*/, aliases);
  }
  return { aliases, namespaces: [...namespaces] };
}

type SinkPattern = { regex: RegExp; canonical: (name: string) => string };

/** Calls of `names` (or their local aliases), bare or on an fs namespace — never a method of another object. */
function sinkPattern(names: readonly string[], bindings: FsBindings): SinkPattern {
  const known = new Set(names);
  const callable = [...names, ...[...bindings.aliases].filter(([, name]) => known.has(name)).map(([local]) => local)]
    .sort((a, b) => b.length - a.length);
  return {
    regex: new RegExp(String.raw`(?:(?<![\w.$])|\b(?:${bindings.namespaces.join('|')})\.)(${callable.join('|')})\(`, 'g'),
    canonical: (name) => bindings.aliases.get(name) ?? name,
  };
}

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

/**
 * True when the path part of `expr` names a stored path, a tainted identifier
 * (not as a property) or a call to an in-file function that returns one.
 */
function mentions(expr: string, tainted: ReadonlySet<string>, returning: ReadonlySet<string> = new Set()): boolean {
  const part = pathPart(expr);
  if (STORED_PATH.test(part)) return true;
  const named = (name: string, suffix: string) => new RegExp(`(?<![\\w.$])${name}${suffix}`).test(part);
  return [...tainted].some((name) => named(name, '\\b')) || [...returning].some((name) => named(name, '\\s*\\('));
}

/** Calls `callee(args)` in `body`, with their top-level arguments. */
function* callsIn(body: string): Generator<{ callee: string; args: string[]; index: number }> {
  const call = /(?<![\w.$])(\w+)\s*\(/g;
  for (let match = call.exec(body); match; match = call.exec(body)) {
    const args = balancedArgs(body, match.index + match[0].length - 1);
    if (args !== null) yield { callee: match[1], args: splitTopLevel(args), index: match.index };
  }
}

/** `const x = expr`, `for (const x of expr)` and `x.push(expr)`: `x` takes the taint of `expr`. */
const TAINT_FLOWS = [
  /(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g,
  /for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+([^\n]+)\)/g,
  /(?<![\w.$])(\w+)\.push\(([^\n]+)\)/g,
];
const RETURN = /\breturn\s+([^;\n]+)/g;

/** `expr` with every `{…}` group blanked: a returned object literal is a record, not a path. */
function withoutObjectLiterals(expr: string): string {
  let out = expr;
  for (let open = out.indexOf('{'); open !== -1; open = out.indexOf('{', open + 1)) {
    let depth = 0;
    let close = open;
    for (; close < out.length; close += 1) {
      if (out[close] === '{') depth += 1;
      else if (out[close] === '}' && --depth === 0) break;
    }
    out = `${out.slice(0, open + 1)}${' '.repeat(Math.max(0, close - open - 1))}${out.slice(close)}`;
  }
  return out;
}

type Taint = { names: Map<FunctionBlock, Set<string>>; returning: Set<string> };

/** One pass of {@link taintedNames} over `block`; true when anything new was tainted. */
function propagate(block: FunctionBlock, byName: Map<string, FunctionBlock>, taint: Taint): boolean {
  const own = taint.names.get(block)!;
  let changed = false;
  const add = (set: Set<string>, name: string) => { if (!set.has(name)) { set.add(name); changed = true; } };
  for (const flow of TAINT_FLOWS) {
    for (const match of block.body.matchAll(flow)) if (mentions(match[2], own, taint.returning)) add(own, match[1]);
  }
  for (const match of block.body.matchAll(RETURN)) {
    if (mentions(withoutObjectLiterals(match[1]), own, taint.returning)) add(taint.returning, block.name);
  }
  for (const { callee, args } of callsIn(block.body)) {
    const target = byName.get(callee);
    if (!target || target === block) continue;
    args.forEach((arg, index) => {
      if (target.params[index] && mentions(arg, own, taint.returning)) add(taint.names.get(target)!, target.params[index]);
    });
  }
  return changed;
}

/**
 * Intra-file taint: a variable assigned from a stored path (or from a tainted
 * variable, a loop over one, a push of one), a parameter of an in-file function
 * called with one, and the result of an in-file function returning one are
 * tainted — whatever they are named. Iterates to a fixpoint.
 */
function taintedNames(blocks: FunctionBlock[]): Taint {
  const taint: Taint = { names: new Map(blocks.map((block) => [block, new Set<string>()] as const)), returning: new Set() };
  const byName = new Map(blocks.map((block) => [block.name, block] as const));
  for (let changed = true; changed;) {
    changed = false;
    for (const block of blocks) if (propagate(block, byName, taint)) changed = true;
  }
  return taint;
}

type TracedRead = { line: number; text: string; resolveOnly: boolean; kind: 'read' | 'write' };

/** Hits of `sink` in `block` whose checked arguments (first, or first two) carry a traced path. */
function sinkHits(block: FunctionBlock, sink: SinkPattern, kind: TracedRead['kind'], own: Set<string>, taint: Taint): TracedRead[] {
  const hits: TracedRead[] = [];
  for (const match of block.body.matchAll(sink.regex)) {
    const name = sink.canonical(match[1]);
    const args = balancedArgs(block.body, match.index + match[0].length - 1);
    const checked = splitTopLevel(args ?? '').slice(0, TWO_PATH_SINKS.has(name) ? 2 : 1);
    if (!checked.some((arg) => mentions(arg, own, taint.returning))) continue;
    const line = block.start + block.body.slice(0, match.index).split('\n').length;
    hits.push({ line, text: block.body.split('\n')[line - block.start - 1].trim(), resolveOnly: RESOLVE_SINKS.has(name), kind });
  }
  return hits;
}

/** Every by-name read, resolve, removal or write of a traced stored transcript path in `source`. */
function tracedReads(source: string): TracedRead[] {
  const blocks = functionBlocks(source);
  const taint = taintedNames(blocks);
  const bindings = fsBindingsOf(source);
  const reads = sinkPattern(READ_SINKS, bindings);
  const writes = sinkPattern(WRITE_SINKS, bindings);
  return blocks.flatMap((block) => {
    const own = taint.names.get(block)!;
    return [...sinkHits(block, reads, 'read', own, taint), ...sinkHits(block, writes, 'write', own, taint)];
  });
}

/**
 * B-1608 T3: the hits that fail the guard. A KNOWN_UNMIGRATED exemption
 * (`exemptReads`) covers read sinks only: removing, moving, copying, linking
 * or writing a stored path by name is never exempt.
 */
function guardHits(source: string, exemptReads: boolean): TracedRead[] {
  return tracedReads(source).filter((hit) => !exemptReads || hit.kind === 'write');
}

/** The shared transcript module: the one place allowed to open these paths (pinned). */
const SHARED_MODULE = new Set([
  'modules/providers/shared/pinned-fd.ts',
  'modules/providers/shared/session-transcript.ts',
  'modules/providers/shared/session-transcript-reader.ts',
  'modules/providers/shared/session-transcript-removal.ts',
  'modules/providers/shared/session-transcript-specs.ts',
  'modules/providers/shared/transcript-header-scan.ts',
]);

/**
 * By-name readers that cannot use the pinned reader yet, each with its reason.
 * Empty since B-1597 migrated the session fork. A new entry needs a documented
 * reason; a listed file that stops matching fails.
 */
const KNOWN_UNMIGRATED: Readonly<Record<string, string>> = Object.freeze({});

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

/**
 * `file:line` of every by-name transcript read in `file` (one-line pattern or
 * traced). With `exemptReads` (a KNOWN_UNMIGRATED file) only write sinks count.
 */
function byNameReads(file: string, exemptReads = Object.hasOwn(KNOWN_UNMIGRATED, file)): string[] {
  const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
  const lines = new Map<number, string>();
  if (!exemptReads) source.split('\n').forEach((line, index) => { if (BY_NAME_READ.test(line)) lines.set(index + 1, line.trim()); });
  for (const hit of guardHits(source, exemptReads)) {
    if (!(hit.resolveOnly && Object.hasOwn(RESOLVE_ONLY, file))) lines.set(hit.line, hit.text);
  }
  return [...lines].sort(([a], [b]) => a - b).map(([line, text]) => `${file}:${line}: ${text}`);
}

test('no by-name transcript read outside the shared transcript module (early warning)', () => {
  const hits = serverSources()
    .filter((file) => !SHARED_MODULE.has(file))
    .flatMap((file) => byNameReads(file));
  assert.deepEqual(hits, [], `by-name transcript reads (use openSessionTranscript / openRecordedTranscript):\n${hits.join('\n')}`);
});

test('every known-unmigrated entry still matches (stale entries are removed)', () => {
  const stale = Object.keys(KNOWN_UNMIGRATED).filter((file) =>
    !fs.existsSync(path.join(SERVER_ROOT, file)) || byNameReads(file, false).length === 0);
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

/**
 * The pre-B-1596 project delete (project-delete.service.ts at 6aa46d7c9,
 * abridged): the stored path flows through a loop, a push, a returned array
 * and a second loop into a by-name `unlink` — no one-line pattern sees it.
 */
const PRE_B1596_PROJECT_DELETE = `
function uniqueJsonlPathsFromSessions(
  sessions: Array<{ jsonl_path: string | null }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of sessions) {
    const raw = row.jsonl_path?.trim();
    if (!raw) {
      continue;
    }
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
    result.push(absolute);
  }
  return result;
}

async function unlinkJsonlIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    return;
  }
}

export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  const jsonlPaths = uniqueJsonlPathsFromSessions(
    sessionsDb.getSessionsByProjectPathIncludingArchived(row.project_path),
  );
  for (const filePath of jsonlPaths) {
    await unlinkJsonlIfExists(filePath);
  }
}
`;

test('B-1596: the traced check flags the pre-B-1596 project delete and every removal/write sink', () => {
  const lines = (source: string) => tracedReads(source).map((hit) => hit.text);
  assert.deepEqual(lines(PRE_B1596_PROJECT_DELETE), ['await fs.unlink(filePath);']);
  assert.equal(lines(PRE_B1596_PROJECT_DELETE.replaceAll('filePath', 'victim')).length, 1, 'renaming changes nothing');
  const sinks = [
    'unlink(x)', 'fsp.rm(x, { force: true })', 'fs.rmSync(x)', 'rmdir(x)', 'fs.renameSync(x, y)', 'rename(other, x)',
    "appendFile(x, 'a')", "fs.writeFileSync(x, 'a')", 'truncate(x, 0)',
  ];
  for (const sink of sinks) {
    assert.equal(lines(`async function f(row: Row) {\n  const x = row.jsonl_path;\n  await ${sink};\n}\n`).length, 1, sink);
  }
  // A returned record built from a path is not a path; the primitive and pinned handles are not by-name sinks.
  assert.deepEqual(lines(`
function describe(row: Row) {
  return { file: row.jsonl_path };
}
async function caller(row: Row) {
  const info = describe(row);
  await removeSessionTranscript(row, 'project-delete');
  await unlink(info.cachePath);
  await opened.fd.truncate(0);
}
`), []);
});

test('B-1597: the session fork is guarded (no exemption, no by-name read)', () => {
  const file = 'modules/providers/services/session-fork.service.ts';
  assert.equal(Object.hasOwn(KNOWN_UNMIGRATED, file), false, 'the fork reads through the pinned reader');
  assert.deepEqual(byNameReads(file), []);
});

test('B-1608 T3: copy, link, symlink, chmod and utimes of a traced path are sinks', () => {
  const lines = (source: string) => tracedReads(source).map((hit) => hit.text);
  const sinks = [
    'copyFile(x, y)', 'fsp.copyFile(other, x)', 'fs.cpSync(x, y)', 'cp(other, x, { recursive: true })',
    'link(x, y)', 'fs.linkSync(other, x)', 'symlink(x, y)', 'fsp.symlink(other, x)',
    'chmod(x, 0o777)', 'fs.chmodSync(x, 0o777)', 'utimes(x, 0, 0)', 'fsp.lutimes(x, 0, 0)',
  ];
  for (const sink of sinks) {
    assert.equal(lines(`async function f(row: Row) {\n  const x = row.jsonl_path;\n  await ${sink};\n}\n`).length, 1, sink);
  }
});

test('B-1608 T3: aliased fs imports and namespaces are sinks too', () => {
  const lines = (source: string) => tracedReads(source).map((hit) => hit.text);
  const cases = [
    "import { unlink as drop } from 'node:fs/promises';\nasync function f(row: Row) {\n  await drop(row.jsonl_path);\n}\n",
    "import { readFile as slurp, open } from 'fs/promises';\nasync function f(row: Row) {\n  return slurp(row.jsonl_path);\n}\n",
    "import * as nodeFs from 'node:fs';\nfunction f(row: Row) {\n  nodeFs.rmSync(row.jsonl_path);\n}\n",
    "import files from 'node:fs/promises';\nasync function f(row: Row) {\n  await files.rename(row.jsonl_path, 'x');\n}\n",
    "const { copyFile: duplicate } = fsp;\nasync function f(row: Row) {\n  await duplicate(row.jsonl_path, 'x');\n}\n",
  ];
  for (const source of cases) assert.equal(lines(source).length, 1, source);
  // An alias of a non-fs module stays out.
  assert.deepEqual(lines("import { drop } from './cache.js';\nasync function f(row: Row) {\n  await drop(row.jsonl_path);\n}\n"), []);
});

test('B-1608 T3: a KNOWN_UNMIGRATED exemption covers read sinks only', () => {
  const source = "async function f(row: Row) {\n  const x = row.jsonl_path;\n  await readFile(x);\n  await unlink(x);\n}\n";
  assert.deepEqual(guardHits(source, true).map((hit) => hit.text), ['await unlink(x);']);
  assert.equal(guardHits(source, false).length, 2);
});
