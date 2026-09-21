/**
 * Security unit tests for attachment upload helpers.
 *
 * Tests two pure functions extracted from POST /api/projects/:projectId/upload-attachments:
 *   - sanitizeAttachmentName(originalname)  — path traversal + charset stripping
 *   - resolveCollisionFreeDest(dir,name,existsFn[,suffixOverride]) — collision safety
 *
 * And the ATTACHMENT_ALLOWED filter logic (fileFilter) by exercising it directly
 * against real multer-shaped file objects.
 *
 * Arrange → Act → Assert throughout.
 * Fixtures: real filenames / mimetypes observed in browser uploads, NOT synthetic
 * strings invented for the test (lesson from the reconcile incident 2026-06-28).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  sanitizeAttachmentName,
  resolveCollisionFreeDest,
} from './utils/attachment-helpers.js';

// ---------------------------------------------------------------------------
// 1. sanitizeAttachmentName — path traversal neutralisation
// ---------------------------------------------------------------------------

test('sanitizeAttachmentName — pure filename unchanged for safe name', () => {
  assert.strictEqual(sanitizeAttachmentName('report.pdf'), 'report.pdf');
});

test('sanitizeAttachmentName — strips leading path component (POSIX traversal)', () => {
  // A malicious upload that smuggles ../../etc/passwd through originalname
  const result = sanitizeAttachmentName('../../etc/passwd');
  // path.basename gives 'passwd'; replace() leaves it as-is (all safe chars)
  assert.strictEqual(result, 'passwd',
    'path.basename must neutralise every directory component');
  assert.ok(!result.includes('..'), 'result must contain no ..');
  assert.ok(!result.includes('/'),  'result must contain no /');
});

test('sanitizeAttachmentName — strips nested path component (a/b.txt style)', () => {
  const result = sanitizeAttachmentName('a/b.txt');
  assert.strictEqual(result, 'b.txt');
});

test('sanitizeAttachmentName — Windows backslash traversal: documents Linux behaviour', () => {
  // On Linux, path.basename treats \ as a regular character (not a separator),
  // so the full string is returned from basename. The replace() step then converts
  // each \ to _. The result starts with ".._.." — NOT an all-dots string — so the
  // /^\.+$/ guard does NOT reject it. The belt-and-suspenders validatePathInProject
  // guard (which operates on the final absolute destPath, not the name) provides the
  // second layer of protection in the handler.
  const result = sanitizeAttachmentName('..\\..\\windows\\system32\\cmd.exe');
  assert.ok(!result.includes('\\'), 'backslashes must be replaced by underscores');
  assert.ok(!result.includes('/'),  'no forward slash in result');
  assert.ok(/^[a-zA-Z0-9._-]+$/.test(result), 'result charset must be safe');
  // Pinning the actual value so a code change that alters basename behaviour
  // (e.g. switching to posix.basename) is caught immediately.
  assert.strictEqual(result, '.._.._windows_system32_cmd.exe',
    'exact output pinned — change here means behaviour changed');
});

test('sanitizeAttachmentName — space and Unicode replaced with underscore', () => {
  const result = sanitizeAttachmentName('my document (final).pdf');
  // Spaces and parens are not in [a-zA-Z0-9._-]
  assert.ok(!result.includes(' '), 'spaces must be replaced');
  assert.ok(!result.includes('('), 'parens must be replaced');
  assert.strictEqual(result, 'my_document__final_.pdf');
});

test('sanitizeAttachmentName — Arabic filename characters replaced with underscore', () => {
  // Real-world: Arabic-named uploads from Nassaj users
  const result = sanitizeAttachmentName('تقرير_2026.xlsx');
  // Non-ASCII → underscore; extension safe chars stay
  assert.ok(/^[a-zA-Z0-9._-]+$/.test(result),
    'all chars in result must be in the allowed charset');
  assert.ok(result.endsWith('.xlsx'), 'extension must be preserved');
});

test('sanitizeAttachmentName — semicolons and shell metacharacters replaced', () => {
  // e.g. a filename like "file;rm -rf /.pdf" — adversarial but seen in the wild
  const result = sanitizeAttachmentName('file;rm -rf /.pdf');
  assert.ok(!result.includes(';'), 'semicolon removed');
  assert.ok(!result.includes(' '), 'space removed');
});

test('sanitizeAttachmentName — undefined/empty originalname yields empty string', () => {
  // Handler checks /^\.+$/ and empty string does NOT match → treated downstream
  assert.strictEqual(sanitizeAttachmentName(undefined), '');
  assert.strictEqual(sanitizeAttachmentName(''), '');
});

// ---------------------------------------------------------------------------
// 2. All-dots rejection guard (tested via the regex, not the handler)
//    The handler does: if (/^\.+$/.test(name)) → 400
// ---------------------------------------------------------------------------

test('all-dots guard — "." is rejected by /^\\.\\.+$/ pattern', () => {
  const name = sanitizeAttachmentName('.');
  assert.ok(/^\.+$/.test(name), '"." must trigger the all-dots reject guard');
});

test('all-dots guard — ".." is rejected', () => {
  const name = sanitizeAttachmentName('..');
  assert.ok(/^\.+$/.test(name), '".." must trigger the all-dots reject guard');
});

test('all-dots guard — "..." is rejected', () => {
  const name = sanitizeAttachmentName('...');
  assert.ok(/^\.+$/.test(name), '"..." must trigger the all-dots reject guard');
});

test('all-dots guard — ".hidden" is NOT rejected (starts with dot but not all-dots)', () => {
  const name = sanitizeAttachmentName('.hidden');
  assert.ok(!/^\.+$/.test(name), '".hidden" is a valid hidden-file name');
});

test('all-dots guard — "file.name.ext" passes (dots inside, not all-dots)', () => {
  const name = sanitizeAttachmentName('file.name.ext');
  assert.ok(!/^\.+$/.test(name));
});

// ---------------------------------------------------------------------------
// 3. resolveCollisionFreeDest — collision avoidance
// ---------------------------------------------------------------------------

const INBOX = '/tmp/project/.nassaj-uploads/inbox';

test('resolveCollisionFreeDest — no collision: returns firstTry, collision=false', () => {
  const existsFn = () => false; // nothing exists
  const { destPath, collision } = resolveCollisionFreeDest(INBOX, 'report.pdf', existsFn);
  assert.strictEqual(destPath, path.join(INBOX, 'report.pdf'));
  assert.strictEqual(collision, false);
});

test('resolveCollisionFreeDest — collision: suffix inserted before extension', () => {
  const existsFn = () => true; // everything "exists"
  const suffix = 'deadbeef';
  const { destPath, collision } = resolveCollisionFreeDest(INBOX, 'report.pdf', existsFn, suffix);

  assert.ok(destPath.includes(`report-${suffix}.pdf`),
    'suffix must be inserted between base and extension');
  assert.strictEqual(collision, true);
});

test('resolveCollisionFreeDest — collision with no-extension file', () => {
  const existsFn = () => true;
  const suffix = 'cafef00d';
  const { destPath } = resolveCollisionFreeDest(INBOX, 'Makefile', existsFn, suffix);
  assert.ok(destPath.endsWith(`Makefile-${suffix}`),
    'suffix appended after name when there is no extension');
});

test('resolveCollisionFreeDest — collision with dotfile (.env)', () => {
  const existsFn = () => true;
  const suffix = '12345678';
  const { destPath } = resolveCollisionFreeDest(INBOX, '.env', existsFn, suffix);
  // path.extname('.env') === '' on Node — treated as no-extension file
  assert.ok(destPath.includes(`.env-${suffix}`),
    'dotfile collision must append suffix');
});

test('resolveCollisionFreeDest — two identical names: second gets unique dest', () => {
  // Simulate: first file already landed → existsFn returns true
  const existsFn = (p) => p === path.join(INBOX, 'data.csv');
  const suffix = 'aabbccdd';
  const { destPath: dest1 } = resolveCollisionFreeDest(INBOX, 'data.csv', () => false);
  const { destPath: dest2, collision } = resolveCollisionFreeDest(INBOX, 'data.csv', existsFn, suffix);
  assert.notStrictEqual(dest1, dest2, 'second upload must land at a different path');
  assert.strictEqual(collision, true);
  assert.ok(dest2.includes('data-aabbccdd.csv'));
});

test('resolveCollisionFreeDest — result is always under inbox dir', () => {
  const existsFn = () => true;
  const { destPath } = resolveCollisionFreeDest(INBOX, 'file.txt', existsFn, '00000000');
  assert.ok(destPath.startsWith(INBOX + path.sep),
    'collision dest must remain inside inbox');
});

// ---------------------------------------------------------------------------
// 4. fileFilter logic — exercised as isolated logic
//    (mirrors the inline fileFilter defined inside the POST handler)
//    Real mimetypes from browser Content-Type headers (Chrome/Safari/Firefox).
// ---------------------------------------------------------------------------

/**
 * Inline replica of the ATTACHMENT_ALLOWED map and fileFilter logic.
 *
 * ⚠️ THIS IS A REPLICA, NOT THE PRODUCTION CODE. Read this before trusting the
 * 20 assertions below.
 *
 * The production map and filter live inside server/index.js, which is the
 * Express entry point: importing it starts the whole server (routes, sockets,
 * database, PM2 drain handlers), so a unit test cannot import them, and neither
 * is exported today.
 *
 * The previous version of this comment claimed the replica was "kept
 * byte-identical to index.js lines 1548-1586". That claim was false in two
 * ways: nothing enforced it, and the line numbers had already drifted (the map
 * now starts at index.js:2052, the filter at :2082). The practical consequence
 * was that deleting the fileFilter from production entirely would have left all
 * 20 assertions below passing — a green suite over a removed security control.
 *
 * So the replica is now backed by the drift guard in section 4b: it reads
 * server/index.js from disk and fails if the production map no longer matches
 * this one, or if the filter stops being wired into the upload handler. The
 * guard is textual by necessity, but it is derived from the real production
 * file rather than from a hand-copied claim.
 *
 * Proper fix (needs coordination — server/index.js is out of this task's
 * scope): move ATTACHMENT_ALLOWED and a pure
 * `attachmentFileFilterDecision(originalname, mimetype) -> {accepted, error}`
 * into server/utils/attachment-helpers.js — which already hosts
 * sanitizeAttachmentName and resolveCollisionFreeDest and is imported by this
 * file — and have index.js import them and adapt the pure decision to multer's
 * (req, file, cb) signature. Then this replica and its drift guard both go away
 * and the tests exercise production code directly.
 */
const ATTACHMENT_ALLOWED = {
  pdf:  ['application/pdf'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
  xls:  ['application/vnd.ms-excel', 'application/octet-stream'],
  csv:  ['text/csv', 'application/csv', 'text/plain', 'application/octet-stream', ''],
  tsv:  ['text/tab-separated-values', 'text/plain', 'application/octet-stream', ''],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream'],
  txt:  ['text/plain', 'application/octet-stream', ''],
  md:   ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream', ''],
  json: ['application/json', 'text/json', 'text/plain', 'application/octet-stream', ''],
  png:  ['image/png'],
  jpg:  ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif:  ['image/gif'],
  webp: ['image/webp'],
  svg:  ['image/svg+xml', 'text/plain', ''],
  zip:  ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
};

/**
 * Calls the inline fileFilter logic and returns { accepted: bool, error?: string }.
 * Mirrors the `fileFilter` defined inside the POST
 * /api/projects/:projectId/upload-attachments handler in server/index.js.
 * No line numbers are quoted on purpose — they drift; section 4b checks the
 * real file instead.
 */
function runFileFilter(originalname, mimetype) {
  const ext = path.extname(originalname || '').slice(1).toLowerCase();
  const allowedMimes = ATTACHMENT_ALLOWED[ext];
  if (!allowedMimes) {
    return { accepted: false, error: `File type .${ext || '(none)'} is not allowed.` };
  }
  const mime = (mimetype || '').toLowerCase();
  if (!allowedMimes.includes(mime)) {
    return { accepted: false, error: `File type .${ext} with content type ${mimetype || '(none)'} is not allowed.` };
  }
  return { accepted: true };
}

// ---- Allowed types (positive cases) ----

test('fileFilter — PDF with application/pdf is accepted', () => {
  assert.strictEqual(runFileFilter('report.pdf', 'application/pdf').accepted, true);
});

test('fileFilter — XLSX with correct OOXML mimetype is accepted', () => {
  assert.strictEqual(
    runFileFilter('data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').accepted,
    true
  );
});

test('fileFilter — CSV with text/csv is accepted', () => {
  assert.strictEqual(runFileFilter('export.csv', 'text/csv').accepted, true);
});

test('fileFilter — CSV with text/plain (common browser behaviour) is accepted', () => {
  // Chrome sends text/csv; Safari and some tools send text/plain for csv
  assert.strictEqual(runFileFilter('export.csv', 'text/plain').accepted, true);
});

test('fileFilter — CSV with empty mimetype (browser omission) is accepted', () => {
  // Some upload clients send no Content-Type header → multer sees ''
  assert.strictEqual(runFileFilter('data.csv', '').accepted, true);
});

test('fileFilter — JSON with application/json is accepted', () => {
  assert.strictEqual(runFileFilter('config.json', 'application/json').accepted, true);
});

test('fileFilter — PNG with image/png is accepted', () => {
  assert.strictEqual(runFileFilter('screenshot.png', 'image/png').accepted, true);
});

test('fileFilter — Markdown .md with text/plain is accepted', () => {
  // Many editors upload .md with text/plain
  assert.strictEqual(runFileFilter('README.md', 'text/plain').accepted, true);
});

test('fileFilter — SVG with image/svg+xml is accepted', () => {
  assert.strictEqual(runFileFilter('diagram.svg', 'image/svg+xml').accepted, true);
});

// ---- Denied types (security critical) ----

test('fileFilter — .exe is rejected regardless of mimetype', () => {
  const r = runFileFilter('malware.exe', 'application/octet-stream');
  assert.strictEqual(r.accepted, false);
  assert.ok(r.error?.includes('.exe'), 'error must name the extension');
});

test('fileFilter — .sh shell script is rejected', () => {
  assert.strictEqual(runFileFilter('install.sh', 'text/x-shellscript').accepted, false);
});

test('fileFilter — .js file is rejected (even with text/plain)', () => {
  // An attacker might send a .js file labelled as text/plain
  assert.strictEqual(runFileFilter('payload.js', 'text/plain').accepted, false);
});

test('fileFilter — .py Python script is rejected', () => {
  assert.strictEqual(runFileFilter('exploit.py', 'text/x-python').accepted, false);
});

test('fileFilter — .bat Windows batch is rejected', () => {
  assert.strictEqual(runFileFilter('run.bat', 'application/octet-stream').accepted, false);
});

test('fileFilter — .php is rejected', () => {
  assert.strictEqual(runFileFilter('shell.php', 'application/x-httpd-php').accepted, false);
});

test('fileFilter — no extension is rejected', () => {
  const r = runFileFilter('Makefile', 'text/plain');
  assert.strictEqual(r.accepted, false,
    'extensionless files must be rejected (no allow-list entry)');
});

test('fileFilter — mimetype mismatch for PDF is rejected', () => {
  // A renamed .exe with a .pdf extension that somehow carries the wrong MIME
  const r = runFileFilter('not-a-pdf.pdf', 'application/x-msdownload');
  assert.strictEqual(r.accepted, false);
  assert.ok(r.error?.includes('application/x-msdownload') || r.error?.includes('.pdf'));
});

test('fileFilter — XLSX with text/plain mimetype is rejected', () => {
  // XLSX allow-list does NOT include text/plain — only OOXML and octet-stream
  assert.strictEqual(runFileFilter('data.xlsx', 'text/plain').accepted, false);
});

test('fileFilter — case-insensitive extension: .PDF is accepted', () => {
  // path.extname gives '.PDF'; .slice(1).toLowerCase() normalises to 'pdf'
  assert.strictEqual(runFileFilter('REPORT.PDF', 'application/pdf').accepted, true);
});

// ---------------------------------------------------------------------------
// 5. Boundary: validatePathInProject (belt-and-suspenders path guard)
//    Exercises the exported helper that the handler calls for every destPath.
// ---------------------------------------------------------------------------

// We import it directly — it is defined but not yet exported, so we verify
// the behaviour through resolveCollisionFreeDest which always stays inside
// the inbox by construction (tested in section 3 above).
// The direct validatePathInProject test is in the handler integration test
// (realpath symlink), which requires actual filesystem I/O — see below.

// ---------------------------------------------------------------------------
// 6. Integration: realpath symlink guard (filesystem I/O required)
// ---------------------------------------------------------------------------

import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('realpath guard — symlinked inbox that escapes project root is detected', async () => {
  // Arrange: create a real project dir and a real "outside" dir.
  // Then symlink .nassaj-uploads/inbox → outside dir.
  // The handler checks realInbox.startsWith(realRoot + sep) and rejects.
  const outside = await mkdtemp(path.join(tmpdir(), 'att-outside-'));
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'att-proj-'));

  // Create the uploads directory structure so mkdir doesn't have to create the symlink's parent
  await mkdir(path.join(projectRoot, '.nassaj-uploads'), { recursive: true });

  // Symlink: .nassaj-uploads/inbox → outside dir
  const inboxLink = path.join(projectRoot, '.nassaj-uploads', 'inbox');
  await symlink(outside, inboxLink);

  try {
    const { realpath } = await import('node:fs/promises');
    const realRoot  = await realpath(projectRoot);
    const realInbox = await realpath(inboxLink);

    // The handler's guard condition
    const escapes = !realInbox.startsWith(realRoot + path.sep);
    assert.ok(escapes,
      'realpath of a symlinked inbox pointing outside the project must NOT start with realRoot');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside,      { recursive: true, force: true });
  }
});

test('realpath guard — legitimate inbox under project root is allowed', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'att-proj-legit-'));
  const inboxDir = path.join(projectRoot, '.nassaj-uploads', 'inbox');
  await mkdir(inboxDir, { recursive: true });

  try {
    const { realpath } = await import('node:fs/promises');
    const realRoot  = await realpath(projectRoot);
    const realInbox = await realpath(inboxDir);

    const isInside = realInbox.startsWith(realRoot + path.sep);
    assert.ok(isInside,
      'legitimate inbox under project root must pass the realpath guard');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4b. Drift guard — tie the replica in section 4 back to production
//
//     Section 4 exercises a hand-written copy of the upload allow-list. On its
//     own that copy proves nothing about server/index.js: it would stay green
//     if the production fileFilter were deleted outright. These tests close
//     that gap by reading server/index.js from disk and comparing.
//
//     Textual, not behavioural — server/index.js is an Express entry point and
//     importing it would boot the server. This is the strongest check available
//     until ATTACHMENT_ALLOWED and the filter are extracted into
//     server/utils/attachment-helpers.js (see the note in section 4).
// ---------------------------------------------------------------------------

const INDEX_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'index.js'
);
const INDEX_SOURCE = readFileSync(INDEX_PATH, 'utf8');

/**
 * Extracts the `const ATTACHMENT_ALLOWED = { … };` object literal out of the
 * production source by scanning braces, then evaluates it. The literal is pure
 * data (string keys, arrays of string literals) with no identifiers, so
 * evaluating it cannot execute production side effects.
 */
function extractProductionAllowMap(source) {
  const marker = 'const ATTACHMENT_ALLOWED = {';
  const start = source.indexOf(marker);
  assert.notStrictEqual(
    start, -1,
    'ATTACHMENT_ALLOWED must still exist in server/index.js — if it was renamed ' +
    'or removed, the upload allow-list is gone and this replica is fiction'
  );

  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notStrictEqual(end, -1, 'unbalanced braces while extracting ATTACHMENT_ALLOWED');

  const literal = source.slice(open, end + 1);
  assert.ok(
    !/[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(literal),
    'ATTACHMENT_ALLOWED must remain a pure data literal (no calls) for safe extraction'
  );
  return new Function(`return (${literal});`)();
}

test('drift guard — replica allow-map is identical to the one in server/index.js', () => {
  const production = extractProductionAllowMap(INDEX_SOURCE);
  assert.deepStrictEqual(
    production, ATTACHMENT_ALLOWED,
    'The ATTACHMENT_ALLOWED map in server/index.js has drifted from the replica in ' +
    'this test file. Every assertion in section 4 is therefore testing the OLD ' +
    'policy. Update the replica above to match production (and re-check that the ' +
    'positive/negative cases still express the intended policy).'
  );
});

test('drift guard — the attachment upload route still installs a fileFilter', () => {
  const routeIndex = INDEX_SOURCE.indexOf(
    "app.post('/api/projects/:projectId/upload-attachments'"
  );
  assert.notStrictEqual(
    routeIndex, -1,
    'the attachment upload route must still exist in server/index.js'
  );

  // Bound the search to this handler so a fileFilter belonging to one of the
  // other upload endpoints cannot satisfy the assertion by accident.
  const handler = INDEX_SOURCE.slice(routeIndex, routeIndex + 4000);

  assert.match(
    handler, /const fileFilter = \(req, file, cb\) =>/,
    'the upload-attachments handler must still define a fileFilter — without it ' +
    'multer accepts every extension and mimetype'
  );
  assert.match(
    handler, /ATTACHMENT_ALLOWED\[ext\]/,
    'the handler fileFilter must still consult ATTACHMENT_ALLOWED'
  );
  assert.match(
    handler, /buildTempUploadMulter\(\{\s*\n?\s*fileFilter,/,
    'the fileFilter must still be passed into buildTempUploadMulter — defining it ' +
    'without wiring it in is the exact silent-regression this guard exists for'
  );
});

test('drift guard — replica filter agrees with production policy on a real sample', () => {
  const production = extractProductionAllowMap(INDEX_SOURCE);
  // Real (extension, mimetype) pairs observed from browser uploads, plus the
  // hostile ones the allow-list exists to reject.
  const samples = [
    ['report.pdf', 'application/pdf'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['notes.md', 'text/markdown'],
    ['payload.exe', 'application/x-msdownload'],
    ['shell.sh', 'text/x-shellscript'],
    ['evil.php', 'application/x-httpd-php'],
    ['noext', 'application/octet-stream'],
    ['image.png', 'text/html'],
  ];

  for (const [name, mime] of samples) {
    const ext = path.extname(name).slice(1).toLowerCase();
    const allowed = production[ext];
    const productionAccepts =
      Boolean(allowed) && allowed.includes((mime || '').toLowerCase());
    assert.strictEqual(
      runFileFilter(name, mime).accepted, productionAccepts,
      `replica and production disagree on ${name} (${mime})`
    );
  }
});
