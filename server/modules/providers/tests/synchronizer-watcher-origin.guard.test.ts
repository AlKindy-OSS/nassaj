import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * B-1620 structural guard. DiscoveredSession.origin defaults to 'launch' so JS
 * launch writers (not tsc-checked) stay unaffected; the price is that a
 * synchronizer forgetting `origin: 'watcher'` would silently skip the temp-root
 * rule. Every discovery-writer call in a synchronizer file must therefore pass
 * the literal `origin: 'watcher'`.
 */

const serverRoot = fileURLToPath(new URL('../../..', import.meta.url));
const WRITER_CALL = /\b(?:recordDiscoveredSession|insertDiscoveredSession|refreshDiscoveredSession)\s*\(/g;
const WATCHER_ORIGIN = /\borigin\s*:\s*['"]watcher['"]/;
const SYNCHRONIZER_FILE = /synchronizer[^/]*\.[cm]?[jt]s$/i;

function isTestFile(relative: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(relative) || relative.split(path.sep).includes('__tests__');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[cm]?[jt]s$/.test(entry.name) ? [full] : [];
  });
}

/** The argument text of the call whose `(` is at `open`, up to its matching `)`. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return source.slice(open + 1, index);
  }
  return source.slice(open + 1);
}

/** `file:line` of every discovery-writer call in `source` lacking `origin: 'watcher'`. */
function callsWithoutWatcherOrigin(relative: string, source: string): string[] {
  return [...source.matchAll(WRITER_CALL)].flatMap((match) => {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (WATCHER_ORIGIN.test(callArguments(source, open))) return [];
    return [`${relative}:${source.slice(0, match.index).split('\n').length}`];
  });
}

/** Non-test synchronizer files under server/ that call a discovery writer. */
function synchronizerWriterFiles(): string[] {
  return sourceFiles(serverRoot)
    .map((file) => path.relative(serverRoot, file))
    .filter((relative) => SYNCHRONIZER_FILE.test(relative) && !isTestFile(relative))
    .filter((relative) => new RegExp(WRITER_CALL.source).test(readFileSync(path.join(serverRoot, relative), 'utf8')));
}

test('every synchronizer discovery write passes origin: watcher (B-1620)', () => {
  const files = synchronizerWriterFiles();
  for (const expected of [
    'modules/providers/list/antigravity/antigravity-session-synchronizer.provider.ts',
    'modules/providers/list/claude/claude-session-synchronizer.provider.ts',
    'modules/providers/list/codex/codex-session-synchronizer.provider.ts',
    'modules/providers/list/cursor/cursor-session-synchronizer.provider.ts',
    'modules/providers/list/opencode/opencode-session-synchronizer.provider.ts',
    'modules/providers/shared/vendor/vendor-session-synchronizer.provider.ts',
    'services/isolation/kimi-agent-session-synchronizer.provider.ts',
  ]) {
    assert.ok(files.includes(expected), `scan must cover ${expected}`);
  }
  const offenders = files.flatMap((relative) => (
    callsWithoutWatcherOrigin(relative, readFileSync(path.join(serverRoot, relative), 'utf8'))
  ));
  assert.deepEqual(offenders, []);
});

test('the guard flags a missing or non-watcher origin and accepts the literal', () => {
  const bad = [
    "sessionsDb.recordDiscoveredSession({ sessionId, provider, projectPath });",
    "sessionsDb.insertDiscoveredSession({ sessionId, origin: 'launch' });",
    "sessionsDb.refreshDiscoveredSession({ sessionId, meta: f(x) });\nother({ origin: 'watcher' });",
  ];
  for (const source of bad) assert.equal(callsWithoutWatcherOrigin('x.ts', source).length, 1, source);
  assert.deepEqual(callsWithoutWatcherOrigin('x.ts',
    "sessionsDb.recordDiscoveredSession({\n  sessionId: id(a),\n  origin: \"watcher\",\n});"), []);
});
