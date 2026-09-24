import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { TextDecoder } from 'node:util';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// The generic-home-user allow-list is the single source in
// scripts/operator-gate/export-allow.mjs — a LEAK-CLEAN module (no forbidden
// operator token) that ships in the public tree via a narrow allow exception, so
// this SHIPPED test imports it directly instead of copying the set. The forbidden
// half stays in the excluded leak-rules.mjs and is not needed here.
import { genericHomeUsers } from './operator-gate/export-allow.mjs';
// The SINGLE SOURCE of which tracked paths the public export ships (shared with
// scripts/export-public.sh). This gate scans only those paths, so it matches what
// actually publishes instead of the whole private tree (qa finding 3a).
import { isPublicExportPath } from './operator-gate/export-allow-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = 'scripts/public-operations-boundary.test.mjs';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PATHS = 4096;
const UNTRACKED_EPHEMERAL_ROOTS = new Set(['.git', 'node_modules', 'dist', 'dist-server']);
const EPHEMERAL_SCRATCH_PREFIXES = ['.release-test-scratch', '.test-scripts-scratch.'];
const execFileAsync = promisify(execFile);

const joined = (...parts) => parts.join('');

// The home regex first char is non-dot ([A-Za-z0-9_-]) so a temp-root subdir
// literally named `home` (e.g. `<tmproot>/home/.pm2`) is not read as an operator
// home directory, while a real `/home/<user>` still is.
const homePattern = new RegExp(joined('\\/ho', 'me\\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)'), 'g');
const workflowIdPattern = new RegExp(joined('\\bwf_', '[0-9a-f]{8,}(?:[-:][A-Za-z0-9-]+)?\\b'), 'gi');
const providerIdPattern = /\b(?:ses|msg|req)_[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/gi;
const incidentIdPattern = new RegExp(
  joined('\\bincident_', '(?=[a-z0-9_-]*[0-9-])[a-z0-9][a-z0-9_-]{7,}\\b'),
  'g',
);
const sessionUrlPattern = new RegExp(
  joined('(?:\\/session\\/|\\bsession(?:Id)?["\'`:=\\s]+)',
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b'),
  'gi',
);
const uuidV7Pattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const signedUrlPattern = new RegExp(
  joined('(?:[?&]|&amp;|%26)(?:X-Amz-|X-Goog-)?', '(?:Signature|SecurityToken)(?:=|%3[dD])'),
  'i',
);
const operationalNarrativePatterns = [
  new RegExp(joined('\\b(?:the\\s+)?live\\s+(?:production\\s+)?', '(?:db|database|db\\.sqlite)\\b'), 'i'),
  new RegExp(joined('\\breal\\s+transcript', '(?:s|\\s+rows?)?\\b'), 'i'),
  new RegExp(joined('\\bverbatim\\s+', '(?:capture|dump|snapshot|rows?|records?|transcripts?)\\b'), 'i'),
  new RegExp(joined('\\b(?:rows?|records?)\\s+from\\s+(?:the\\s+)?', '(?:live|production)\\s+(?:db|database)\\b'), 'i'),
  new RegExp(joined('\\bverified\\s+against\\s+', '(?:the\\s+)?real\\b'), 'i'),
];
const arabicOperationalNarrativePatterns = [
  new RegExp(joined(
    '(?:بيانات|تفريغ|سجلات?|صفوف)',
    '[^\\n]{0,40}(?:منسوخ(?:ة)?|مأخوذ(?:ة)?|مستخرج(?:ة)?|حرفي(?:اً|ا))',
    '[^\\n]{0,40}(?:الإنتاج|الخادم|خادم الإنتاج|قاعدة البيانات)',
  )),
  new RegExp(joined(
    '(?:الإنتاج|الخادم|خادم الإنتاج|قاعدة البيانات)',
    '[^\\n]{0,40}(?:منسوخ(?:ة)?|مأخوذ(?:ة)?|مستخرج(?:ة)?|حرفي(?:اً|ا))',
    '[^\\n]{0,40}(?:بيانات|تفريغ|سجلات?|صفوف)',
  )),
  new RegExp(joined(
    '(?:واقعة|حادثة)\\s+(?:فعلية|حقيقية)',
    '[^\\n]{0,30}(?:على|في)\\s+خادمنا',
  )),
];
const hardSecretPatterns = [
  new RegExp(joined('AK', 'IA[0-9A-Z]{16}')),
  new RegExp(joined('-----BEGIN ', '(?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----')),
  new RegExp(joined('github_', 'pat_[A-Za-z0-9_]{20,}\\b')),
  new RegExp(joined('\\bgh', '[pousr]_[A-Za-z0-9]{20,}\\b')),
  new RegExp(joined('\\beyJ[A-Za-z0-9_-]{8,}\\.', '[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b')),
  new RegExp(joined('\\bsk-(?:live|test|proj)-', '[A-Za-z0-9_-]{16,}\\b')),
  new RegExp(joined('\\bsk_(?:live|test)_', '[A-Za-z0-9]{16,}\\b')),
  new RegExp(joined('\\bxox[baprs]-', '[A-Za-z0-9-]{16,}\\b')),
  new RegExp(joined('\\bAIza', '[A-Za-z0-9_-]{20,}\\b')),
];
const assignmentPattern = new RegExp(
  joined('["\']([A-Za-z][A-Za-z0-9_]*(?:secret|token|password|api[_-]?key|private[_-]?key)',
    '|apiKey|accessToken|clientSecret)["\']\\s*[:=]\\s*["\']([^"\'\\r\\n]{12,})["\']'),
  'gim',
);
const envAssignmentPattern = new RegExp(
  joined('^[ \\t]*(?:#|\\/\\/|;)?[ \\t]*([A-Z][A-Z0-9_]*',
    '(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY))\\s*=\\s*(.+)$'),
  'gm',
);

function safeFixture(value) {
  return /^SYNTHETIC_ONLY_[A-Z0-9_]{1,64}$/.test(value)
    || /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value)
    || /^<[A-Z][A-Z0-9_-]*>$/.test(value);
}

function highEntropyAscii(value) {
  if (value.length < 16 || !/^[\x21-\x7e]+$/.test(value)) return false;
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.5;
}

function hardSecretIsExplicitPlaceholder(value) {
  const githubPayload = value.match(/^gh[pousr]_([A-Za-z0-9])\1{19,}$/)?.[1];
  return githubPayload !== undefined;
}

function lineNumber(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

function snippet(text, index, length = 72) {
  return text.slice(index, index + length).replace(/[\r\n\t]+/g, ' ').slice(0, 96);
}

function addMatch(violations, relative, text, rule, match) {
  violations.push({
    relative,
    line: lineNumber(text, match.index),
    rule,
    sample: snippet(text, match.index, match[0].length),
  });
}

function eachMatch(pattern, text, callback) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const instance = new RegExp(pattern.source, flags);
  for (let match; (match = instance.exec(text));) {
    callback(match);
    if (match[0].length === 0) instance.lastIndex += 1;
  }
}

function arabicClaimIsNegated(text, index) {
  const before = text.slice(Math.max(0, index - 48), index);
  return /(?:^|[\s،؛.!؟"'`])(?:لا|ليس(?:ت)?|لن|لم|دون)\s+(?:[ء-ي]+\s+){0,4}$/.test(before);
}


function syntheticIdentifierIsExplicit(_relative, _text, match) {
  if (/(?:synthetic|demo|fixture)/i.test(match[0])) return true;
  if (repeatedSyntheticUuid(match[0])) return true;
  if (/\bwf_/i.test(match[0]) && workflowIdentifierLooksSynthetic(match[0])) return true;
  if (/\b(?:ses|msg|req)_/i.test(match[0]) && providerIdentifierLooksSynthetic(match[0])) return true;
  return false;
}

function workflowIdentifierLooksSynthetic(value) {
  if (/(?:synthetic|demo|fixture)/i.test(value)) return true;
  const prefix = value.match(/\bwf_([0-9a-f]{8})/i)?.[1];
  return prefix !== undefined
    && (/^([0-9a-f])\1{3}([0-9a-f])\2{3}$/i.test(prefix) || /^[1-9]0{7}$/.test(prefix));
}

function providerIdentifierLooksSynthetic(value) {
  const payload = value.match(/\b(?:ses|msg|req)_([A-Za-z0-9-]+)/i)?.[1];
  if (!payload) return false;
  const first = payload.split('-')[0];
  return /^([A-Za-z0-9])\1{7,}$/i.test(first)
    || /^([A-Za-z0-9])\1{3}([A-Za-z0-9])\2{3}$/i.test(first)
    || /^[1-9]0{7,}$/.test(first);
}

function repeatedSyntheticUuid(value) {
  const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
  if (!uuid) return false;
  if (/^([0-9a-f])\1{7}-([0-9a-f])\2{3}-[1-57]([0-9a-f])\3{2}-[89ab]([0-9a-f])\4{2}-([0-9a-f])\5{11}$/i.test(uuid)) return true;
  const normalized = uuid.replaceAll('-', '').split('');
  normalized[12] = '0';
  normalized[16] = '0';
  return normalized.filter(character => character !== '0').length <= 6;
}

function scanText(relative, text) {
  const violations = [];
  eachMatch(homePattern, text, match => {
    if (!safeFixture(match[1]) && !genericHomeUsers.has(match[1])) {
      addMatch(violations, relative, text, 'operator_home_path', match);
    }
  });
  for (const [rule, pattern] of [
    ['workflow_id', workflowIdPattern],
    ['provider_id', providerIdPattern],
    ['incident_id', incidentIdPattern],
    ['session_id', sessionUrlPattern],
    ['uuid_v7', uuidV7Pattern],
  ]) {
    eachMatch(pattern, text, match => {
      if (!syntheticIdentifierIsExplicit(relative, text, match)) addMatch(violations, relative, text, rule, match);
    });
  }
  eachMatch(signedUrlPattern, text, match => addMatch(violations, relative, text, 'signed_url', match));
  for (const pattern of operationalNarrativePatterns) {
    eachMatch(pattern, text, match => addMatch(violations, relative, text, 'private_operational_narrative', match));
  }
  for (const pattern of arabicOperationalNarrativePatterns) {
    eachMatch(pattern, text, match => {
      if (!arabicClaimIsNegated(text, match.index)) {
        addMatch(violations, relative, text, 'private_operational_narrative', match);
      }
    });
  }
  for (const pattern of hardSecretPatterns) {
    eachMatch(pattern, text, match => {
      if (!hardSecretIsExplicitPlaceholder(match[0])) addMatch(violations, relative, text, 'hard_secret', match);
    });
  }
  eachMatch(assignmentPattern, text, match => {
    if (!safeFixture(match[2]) && highEntropyAscii(match[2])) {
      addMatch(violations, relative, text, 'assigned_secret', match);
    }
  });
  eachMatch(envAssignmentPattern, text, match => {
    const value = match[2].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (!safeFixture(value) && highEntropyAscii(value)) {
      addMatch(violations, relative, text, 'assigned_secret', match);
    }
  });
  return violations;
}

function decodeText(data) {
  if (data.includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    let controls = 0;
    for (const character of text) {
      const code = character.codePointAt(0);
      if (code < 32 && character !== '\n' && character !== '\r' && character !== '\t') controls += 1;
    }
    return text.length === 0 || controls / text.length <= 0.01 ? text : null;
  } catch {
    return null;
  }
}

function isEphemeralUntracked(relative) {
  const rootEntry = relative.split('/')[0];
  return UNTRACKED_EPHEMERAL_ROOTS.has(rootEntry)
    || EPHEMERAL_SCRATCH_PREFIXES.some(prefix => rootEntry.startsWith(prefix));
}

function classifyPublicPaths(tracked, untracked) {
  return [
    ...tracked.map(relative => ({ relative, tracked: true })),
    ...untracked.filter(relative => !isEphemeralUntracked(relative))
      .map(relative => ({ relative, tracked: false })),
  ];
}

async function gitPaths(...args) {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z', ...args], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (stdout.length === 0) return [];
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  return decoded.split('\0').filter(Boolean);
}

function validateRepositoryPath(relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
    || path.posix.normalize(relative) !== relative
    || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('git reported an unsafe public path');
  }
}

async function publicTreeFiles() {
  const files = [];
  const unsafe = [];
  const tracked = await gitPaths('--cached');
  const deleted = new Set(await gitPaths('--deleted'));
  const untracked = await gitPaths('--others', '--exclude-standard');
  // Scan ONLY the paths the export actually ships. Everything else (alkindy/*,
  // docs/plans, the operator-gate rules, the release orchestrator, …) is excluded
  // from the public tree, so a marker there never publishes and must not fail here.
  const candidates = classifyPublicPaths(tracked.filter(relative => !deleted.has(relative)), untracked)
    .filter(({ relative }) => isPublicExportPath(relative));
  for (const { relative, tracked: isTracked } of candidates) {
    validateRepositoryPath(relative);
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute).catch(error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!stat) unsafe.push(`${relative}: ${isTracked ? 'tracked file missing' : 'untracked file vanished'}`);
    else if (stat.isSymbolicLink()) unsafe.push(`${relative}: symlink`);
    else if (stat.isFile()) files.push({ absolute, relative, size: stat.size, tracked: isTracked });
    // A tracked directory entry can only be a gitlink, and submodules are excluded
    // from this repository by ADR-156 G1 (see scripts/no-gitlinks.test.mjs). The
    // former tolerance is gone: a gitlink is an unsupported path here as well.
    else unsafe.push(`${relative}: unsupported file type`);
    if (files.length + unsafe.length > MAX_PATHS) throw new Error(`public tree exceeds ${MAX_PATHS} paths`);
  }
  return {
    files: files.sort((a, b) => a.relative.localeCompare(b.relative)),
    unsafe,
    tracked: tracked.length,
    deleted: deleted.size,
    untracked: untracked.length,
  };
}

async function scanPublicTree() {
  const { files, unsafe, tracked, deleted, untracked } = await publicTreeFiles();
  const violations = unsafe.map(sample => ({ relative: sample.split(': ')[0], line: 0, rule: 'unsafe_path', sample }));
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (file.size > MAX_FILE_BYTES) {
      violations.push({ relative: file.relative, line: 0, rule: 'file_too_large', sample: String(file.size) });
      continue;
    }
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`public tree exceeds ${MAX_TOTAL_BYTES} bytes`);
    const handle = await fs.open(file.absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let data;
    try { data = await handle.readFile(); } finally { await handle.close(); }
    const text = decodeText(data);
    if (text !== null) violations.push(...scanText(file.relative, text));
    else {
      const compactAscii = data.toString('latin1').replaceAll('\0', '');
      for (const pattern of [...hardSecretPatterns, signedUrlPattern]) {
        eachMatch(pattern, compactAscii, match => addMatch(violations, file.relative, compactAscii, 'binary_sensitive_text', match));
      }
    }
  }
  return { files: files.length, tracked, deleted, untracked, totalBytes, violations };
}

function formattedViolations(violations) {
  return violations
    .map(({ relative, line, rule, sample }) => `${relative}:${line} [${rule}] ${sample}`)
    .join('\n');
}

test('whole public working tree contains no private operational material', async () => {
  const result = await scanPublicTree();
  assert.ok(result.tracked > 100, 'the gate must scan every tracked path, not a small allowlist');
  assert.equal(
    result.violations.length,
    0,
    `scanned ${result.files} files / ${result.totalBytes} bytes\n${formattedViolations(result.violations)}`,
  );
});

test('adversarial private material is rejected without a self-file bypass', () => {
  const samples = [
    joined('/ho', 'me/actual-operator/project'),
    joined('workflow=', 'wf_', '93cc5269-deadbeef'),
    joined('source=', 'the live ', 'database'),
    joined('evidence=', 'real trans', 'cript rows'),
    joined(
      'هذه بيانات منسوخة ',
      'حرفياً من قاعدة البيانات',
    ),
    joined(
      'هذه حادثة فعلية ',
      'على خادمنا',
    ),
    joined('https://example.test/file?', 'Signature=', 'abcdef0123456789'),
    joined('token=', '"sk-', 'live-abcdefghijklmnop"'),
    ...['p', 'o', 'u', 's', 'r'].map(kind => joined('gh', `${kind}_`, 'AbCdEf0123456789AbCdEf0123456789AbCd')),
  ];
  for (const sample of samples) {
    assert.notEqual(scanText(selfPath, sample).length, 0, sample);
  }
  for (const identifier of [
    joined('ses_', '05aab10c'),
    joined('msg_', 'a1b2c3d4'),
    joined('req_', '9f8e7d6c'),
    joined('01918f0a-', '3b2c-7d4e-8f90-a1b2c3d4e5f6'),
  ]) {
    assert.notEqual(scanText('tests/provider.synthetic.test.ts', identifier).length, 0, identifier);
  }
});

test('home-path detection still catches a real operator home but not a temp-root subdir', () => {
  // Real detection preserved: /home/<realuser> is operator material and must fail.
  assert.equal(scanText('docs/notes.md', joined('/ho', 'me/actualop/project')).length, 1);
  assert.equal(scanText('docs/notes.md', joined('/ho', 'me/actualop/project'))[0].rule, 'operator_home_path');
  // Non-dot-first alignment with leak-rules: a temp-root subdir literally named
  // `home` holding a dotfile is NOT an operator home and must not false-positive.
  assert.deepEqual(scanText('scripts/fixture.mjs', joined('/ho', 'me/.pm2')), []);
  assert.deepEqual(scanText('scripts/fixture.mjs', joined('/var/tmp/x/ho', 'me/.pm2')), []);
  // Generic placeholder owners still pass.
  assert.deepEqual(scanText('docs/example.md', joined('/ho', 'me/example/project')), []);
});

test('tracked generated and scratch paths are scanned while ephemeral untracked paths stay separate', () => {
  const classified = classifyPublicPaths(
    ['dist/tracked.js', 'dist-server/tracked.js', '.release-test-scratch-evidence/tracked.txt'],
    ['dist/ephemeral.js', '.release-test-scratch-run/ephemeral.txt', 'src/new-file.ts'],
  );
  assert.deepEqual(classified, [
    { relative: 'dist/tracked.js', tracked: true },
    { relative: 'dist-server/tracked.js', tracked: true },
    { relative: '.release-test-scratch-evidence/tracked.txt', tracked: true },
    { relative: 'src/new-file.ts', tracked: false },
  ]);
});

test('the gate scans only paths the public export ships', () => {
  // Shipped product paths are scanned.
  for (const shipped of [
    'src/app.tsx', 'server/index.js', 'shared/util.ts', 'scripts/build.mjs',
    'scripts/operator-gate/export-allow.mjs', 'scripts/operator-gate/export-allow-paths.mjs',
    'docs/team-wiki/guide.md', 'README.md', 'package.json',
  ]) assert.equal(isPublicExportPath(shipped), true, shipped);
  // Never-exported operator paths are excluded, so a marker there cannot fail here.
  for (const excluded of [
    'scripts/operator-gate/leak-rules.mjs', 'scripts/release.mjs',
    'scripts/release-orchestrator-phases.test.mjs', 'docs/plans/roadmap.md',
    'automation/ai-news-daily/run.mjs', '.github/workflows/release.yml',
    'server/modules/database/deletion-writer-inventory.test.ts',
  ]) assert.equal(isPublicExportPath(excluded), false, excluded);
});

test('only explicit synthetic values are admitted', () => {
  assert.deepEqual(scanText('tests/example.synthetic.ts', 'workflow=wf_synthetic_partial'), []);
  assert.deepEqual(scanText('tests/example.test.ts', 'workflow=wf_10000000-demo'), []);
  for (const identifier of [
    'ses_synthetic_actor',
    'msg_demo_message',
    'req_fixture_request',
    'ses_aaaaaaaa',
    '11111111-2222-7333-8444-555555555555',
  ]) assert.deepEqual(scanText('tests/example.test.ts', identifier), []);
  assert.deepEqual(scanText('tests/example.test.ts', 'workspace=/home/example/project'), []);
  assert.deepEqual(scanText('tests/example.ts', 'API_TOKEN=SYNTHETIC_ONLY_API_TOKEN'), []);
  assert.deepEqual(scanText('docs/token-help.md', joined('gh', 'p_', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')), []);
  for (const generic of [
    'هذه محادثة حقيقية',
    'هذه جلسة حية',
    'لا تصف حادثة فعلية على خادمنا',
    'لا تنسخ بيانات إنتاجية',
  ]) assert.deepEqual(scanText('docs/safety.md', generic), []);
});

test('private digest corpora and membership oracles are not committed in the public gate', async () => {
  const source = await fs.readFile(path.join(root, selfPath), 'utf8');
  const forbiddenMarkers = [
    joined('node:', 'crypto'),
    joined('create', 'Hash'),
    joined('TOKEN_', 'DIGESTS'),
    joined('OCCURRENCE_', 'DIGESTS'),
    joined('scan', 'HashedIdentifiers'),
  ];
  for (const marker of forbiddenMarkers) assert.equal(source.includes(marker), false, marker);
  assert.deepEqual(source.match(/\b[0-9a-f]{64}\b/gi) ?? [], []);
});

test('every workflow action is immutable and release credentials are step scoped', async () => {
  const workflow = await fs.readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v6/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v6\b/);
  assert.match(workflow, /concurrency:\s*\n\s*group: release-/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*write/);
  assert.match(workflow, /persist-credentials:\s*false/);
  const bindStart = workflow.indexOf('- name: Bind dispatch to the exact reviewed main commit');
  const setupStart = workflow.indexOf('- uses: actions/setup-node@');
  const prepareStart = workflow.indexOf('- name: Prepare exact reviewed tag with scoped verification credential');
  const pushStart = workflow.indexOf('- name: Push only the exact reviewed main and tag');
  const reverifyStart = workflow.indexOf('- name: Reverify reviewed main before release publication');
  const publishStart = workflow.indexOf('- name: Publish GitHub release');
  const verificationCredentialRanges = [[bindStart, setupStart], [prepareStart, pushStart], [reverifyStart, publishStart]];
  for (const match of workflow.matchAll(/(?:secrets\.RELEASE_(?:READ_)?PAT|github\.token|GH_TOKEN:|GITHUB_TOKEN:)/g)) {
    assert.ok(
      verificationCredentialRanges.some(([start, end]) => match.index >= start && match.index < end)
        || (match.index >= pushStart && match.index < reverifyStart) || match.index >= publishStart,
      `release credential escaped final push/release steps at byte ${match.index}`,
    );
  }
  assert.equal(workflow.match(/secrets\.RELEASE_READ_PAT/g)?.length, 3);
  assert.equal(workflow.match(/secrets\.RELEASE_READ_PAT \|\| github\.token/g)?.length, 3);
  assert.equal(workflow.match(/secrets\.RELEASE_PAT \|\| github\.token/g)?.length, 3);
  const installAndTest = workflow.slice(setupStart, prepareStart);
  assert.doesNotMatch(installAndTest, /(?:RELEASE_READ_PAT|GH_TOKEN|GITHUB_TOKEN|NASSAJ_RELEASE_GIT_AUTH)/);

  const workflowDir = path.join(root, '.github/workflows');
  for (const name of await fs.readdir(workflowDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const source = await fs.readFile(path.join(workflowDir, name), 'utf8');
    for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
      assert.match(match[1], /^(?:\.\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40})$/, `${name}: ${match[1]}`);
    }
    for (const match of source.matchAll(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n([\s\S]{0,160})/g)) {
      assert.match(match[1], /persist-credentials:\s*false/, `${name}: checkout credentials`);
    }
  }

  const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(packageMetadata, 'nassajTestIsolation'), false);
  assert.equal(Object.hasOwn(packageMetadata, 'nassajLintBudget'), false);
});

test('public defaults stay host-neutral and monitors use the governed restart gate', async () => {
  const ecosystem = await fs.readFile(path.join(root, 'ecosystem.config.example.cjs'), 'utf8');
  const safeRestart = await fs.readFile(path.join(root, 'scripts/safe-restart.sh'), 'utf8');
  const memoryGuard = await fs.readFile(path.join(root, 'scripts/memory-guard.sh'), 'utf8');
  const monitor = await fs.readFile(path.join(root, 'scripts/monitor-rss.sh'), 'utf8');
  const liveness = await fs.readFile(path.join(root, 'scripts/liveness-watch.sh'), 'utf8');
  const databaseBackup = await fs.readFile(path.join(root, 'scripts/backup-db.sh'), 'utf8');
  const unit = await fs.readFile(path.join(root, 'scripts/systemd/nassaj-liveness.service'), 'utf8');

  assert.match(ecosystem, /PROC_NAME \|\| process\.env\.NASSAJ_PROCESS_NAME \|\| 'nassaj-dev'/);
  for (const source of [safeRestart, memoryGuard, monitor, liveness]) {
    assert.match(source, /NASSAJ_PROCESS_NAME:-nassaj-dev/);
  }
  assert.match(databaseBackup, /XDG_DATA_HOME/);
  assert.match(databaseBackup, /NASSAJ_DATA_DIR/);
  assert.doesNotMatch(unit, /\/Project\//);
  assert.match(unit, /%h\/\.local\/share\/nassaj\/current\/scripts\/liveness-watch\.sh/);

  for (const relative of [
    'scripts/memory-guard.sh', 'scripts/monitor-rss.sh', 'scripts/b103-loss-meter.js',
    'scripts/liveness-watch.sh', 'scripts/backup-db.sh',
  ]) {
    const text = await fs.readFile(path.join(root, relative), 'utf8');
    const executable = text.split('\n').filter(line => !/^\s*(?:#|\/\/)/.test(line)).join('\n');
    assert.doesNotMatch(executable, /\bpm2\s+(?:restart|reload|stop|delete)\b/, relative);
  }
  assert.match(memoryGuard, /bash scripts\/safe-restart\.sh --exec/);
  assert.doesNotMatch(liveness, /\bkill\s+-|\bpm2\s+(?:restart|reload|stop|delete)\b/);
  assert.doesNotMatch(liveness, /\bpm2\s+(?:pid|jlist)\b/, 'liveness reads must not spawn a PM2 daemon');
});
