/**
 * transcript-block-repair.test.ts — B-421.
 *
 * A malformed content block poisons a Claude transcript PERMANENTLY: a resume
 * replays the whole history every turn, so the same 400 returns forever.
 *
 * The fixture is NOT synthetic. `__fixtures__/b421-poisoned-transcript.jsonl`
 * is lines 71-74 synthetically preserved from the session that actually died,
 * 00000001-0000-4000-8000-000000000001, captured before the manual repair —
 * `server_tool_use` id `call_0670a…` written by glm-5.2 running as a Claude
 * engine. Green tests on invented shapes have lied here before (the reconcile
 * regex matched 6.5% of real traffic behind 33 passing tests), so every
 * assertion below runs on the bytes the CLI really wrote.
 *
 * Runner: node:test via tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  encodeProjectDir,
  repairRecord,
  repairResumeTranscript,
  repairTranscriptFile,
  resolveTranscriptPath,
} from './transcript-block-repair.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '__fixtures__', 'b421-poisoned-transcript.jsonl');
const POISON_ID = 'call_0670a475d8a3443bb3ef9d9e';

/** Temp dir per test, always removed (B-419: tests clean up after themselves). */
function withTmp<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b421-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyFixture(dir: string, name = 'session.jsonl'): string {
  const file = path.join(dir, name);
  fs.copyFileSync(FIXTURE, file);
  return file;
}

function records(file: string): any[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function blocks(file: string): any[] {
  return records(file).flatMap((r) => r.message?.content ?? []);
}

// ── the real poisoned session ────────────────────────────────────────────────

test('B-421: rewrites both malformed blocks and leaves no rejectable id', () => {
  withTmp((dir) => {
    const file = copyFixture(dir);

    const result = repairTranscriptFile(file);

    // Line 72 (server_tool_use) and line 74 (orphan assistant tool_result),
    // i.e. lines 2 and 4 of the extracted fixture.
    assert.equal(result.blocks, 2);
    assert.deepEqual(result.lines, [2, 4]);

    assert.ok(!fs.readFileSync(file, 'utf8').includes(POISON_ID));
    for (const block of blocks(file)) {
      if (block.type === 'server_tool_use') assert.match(block.id, /^srvtoolu_/);
    }
  });
});

test('B-421: preserves the tool output as readable text instead of dropping it', () => {
  withTmp((dir) => {
    const file = copyFixture(dir);
    repairTranscriptFile(file);

    const text = blocks(file)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Both halves of the real analyze_image round-trip survive.
    assert.ok(text.includes('analyze_image'));
    assert.ok(text.includes('Antigravity'));
  });
});

test('B-421: downgrades the now-dangling stop_reason', () => {
  withTmp((dir) => {
    const file = copyFixture(dir);
    repairTranscriptFile(file);
    assert.equal(records(file)[1].message.stop_reason, 'end_turn');
  });
});

test('B-421: repair is idempotent', () => {
  withTmp((dir) => {
    const file = copyFixture(dir);
    repairTranscriptFile(file);
    const once = fs.readFileSync(file, 'utf8');

    const second = repairTranscriptFile(file);
    assert.equal(second.blocks, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), once);
  });
});

test('B-421: repair never deletes a record', () => {
  withTmp((dir) => {
    const file = copyFixture(dir);
    const before = records(FIXTURE).length;
    repairTranscriptFile(file);
    assert.equal(records(file).length, before);
  });
});

test('B-421: reports WHAT it repaired so the audit row is diagnostic', () => {
  withTmp((dir) => {
    const file = copyFixture(dir);
    const result = repairTranscriptFile(file);

    // The engine + these kinds are what turn a silent repair into a signal:
    // a second occurrence under a different field must be greppable on day one.
    const kinds = new Set(result.seen.map((s: any) => `${s.type}:${s.name ?? '-'}`));
    assert.ok(kinds.has('server_tool_use:analyze_image'));
    assert.equal(result.seen.length, result.blocks);
    // No ids, inputs or results leak into what the caller will persist.
    assert.deepEqual(Object.keys(result.seen[0]).sort(), ['name', 'type']);
  });
});

test('B-421: an untouched file still reports a stable empty shape', () => {
  withTmp((dir) => {
    const file = path.join(dir, 'ok.jsonl');
    fs.writeFileSync(file, JSON.stringify({ message: { content: [] } }) + '\n');
    assert.deepEqual(repairTranscriptFile(file).seen, []);
    assert.deepEqual(repairResumeTranscript({ sessionId: null, cwd: null, configDir: null }).seen, []);
  });
});

// ── files it must not touch ──────────────────────────────────────────────────

test('B-421: a healthy transcript stays byte-identical', () => {
  withTmp((dir) => {
    const file = path.join(dir, 'ok.jsonl');
    const healthy =
      JSON.stringify({
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      }) + '\n';
    fs.writeFileSync(file, healthy);

    assert.equal(repairTranscriptFile(file).reason, 'clean');
    assert.equal(fs.readFileSync(file, 'utf8'), healthy);
  });
});

test('B-421: a normal client tool_result in a USER message is left alone', () => {
  // `call_…` ids are CORRECT there — that is the ordinary tool round-trip.
  // Rewriting it would strip tool history from every vendor session.
  withTmp((dir) => {
    const file = path.join(dir, 'user-tool.jsonl');
    const raw =
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'ok' }],
        },
      }) +
      '\n' +
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'server_tool_use', id: 'srvtoolu_valid', name: 'web_search' }],
        },
      }) +
      '\n';
    fs.writeFileSync(file, raw);

    assert.equal(repairTranscriptFile(file).blocks, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  });
});

test('B-421: a torn line abandons the repair instead of rewriting the file', () => {
  withTmp((dir) => {
    const file = path.join(dir, 'torn.jsonl');
    const raw =
      JSON.stringify({
        message: { role: 'assistant', content: [{ type: 'server_tool_use', id: 'call_x' }] },
      }) + '\n{"message":{"content":[{"type":"server_tool_us';
    fs.writeFileSync(file, raw);

    assert.equal(repairTranscriptFile(file).reason, 'unparsable');
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  });
});

test('B-421: an absent file reports rather than throws', () => {
  withTmp((dir) => {
    assert.equal(repairTranscriptFile(path.join(dir, 'nope.jsonl')).reason, 'absent');
  });
});

// ── repairRecord ─────────────────────────────────────────────────────────────

test('B-421: repairRecord ignores records whose content is not an array', () => {
  assert.equal(repairRecord({ message: { role: 'assistant', content: 'plain' } }), 0);
  assert.equal(repairRecord({}), 0);
  assert.equal(repairRecord(null), 0);
});

test('B-421: repairRecord renders name and input when there is no result', () => {
  const record: any = {
    message: {
      role: 'assistant',
      content: [{ type: 'server_tool_use', id: 'call_x', name: 'analyze_image', input: { a: 1 } }],
    },
  };
  assert.equal(repairRecord(record), 1);
  assert.equal(record.message.content[0].type, 'text');
  assert.ok(record.message.content[0].text.includes('analyze_image'));
  assert.ok(record.message.content[0].text.includes('"a":1'));
});

// ── path resolution ──────────────────────────────────────────────────────────

test('B-421: mirrors the CLI project-directory encoding', () => {
  assert.equal(
    encodeProjectDir('/home/example/Project/nassaj-dev'),
    '-home-example-Project-nassaj-dev',
  );
});

test('B-421: builds <configDir>/projects/<encoded>/<id>.jsonl', () => {
  assert.equal(
    resolveTranscriptPath({
      sessionId: '00000001-0000-4000-8000-000000000001',
      cwd: '/home/example/Project/nassaj-dev',
      configDir: '/cfg',
    }),
    '/cfg/projects/-home-example-Project-nassaj-dev/00000001-0000-4000-8000-000000000001.jsonl',
  );
});

test('B-421: refuses a traversal-shaped session id', () => {
  assert.equal(
    resolveTranscriptPath({ sessionId: '../../etc/passwd', cwd: '/x', configDir: '/cfg' }),
    null,
  );
  assert.equal(resolveTranscriptPath({ sessionId: 'a/b', cwd: '/x', configDir: '/cfg' }), null);
});

test('B-421: returns null when inputs are missing', () => {
  assert.equal(resolveTranscriptPath({ sessionId: null, cwd: '/x', configDir: '/cfg' }), null);
  assert.equal(resolveTranscriptPath({ sessionId: 'ok', cwd: null, configDir: '/cfg' }), null);
});

// ── the spawn seam ───────────────────────────────────────────────────────────

test('B-421: repairs through the path a resume actually resolves', () => {
  withTmp((dir) => {
    const sessionId = '00000001-0000-4000-8000-000000000001';
    const cwd = '/home/example/Project/nassaj-dev';
    const projectDir = path.join(dir, 'projects', encodeProjectDir(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    fs.copyFileSync(FIXTURE, file);

    const result = repairResumeTranscript({ sessionId, cwd, configDir: dir });

    assert.equal(result.blocks, 2);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(POISON_ID));
  });
});

test('B-421: the spawn seam fails open on unusable input', () => {
  withTmp((dir) => {
    assert.equal(
      repairResumeTranscript({ sessionId: null, cwd: null, configDir: null }).reason,
      'unresolved',
    );
    assert.equal(
      repairResumeTranscript({ sessionId: 'missing-session', cwd: '/x', configDir: dir }).repaired,
      0,
    );
  });
});

// ── ADR-099/T-1237: the cross-engine mode ────────────────────────────────────
//
// Second fixture, same discipline as the first: three lines lifted synthetically preserved from
// session 406fec0e — a `tool_use` with a z.ai `call_…` id, its matching
// `tool_result`, and a `thinking` block carrying an EMPTY signature. That last
// shape is why the fixture is real: the obvious guard (`typeof !== 'string'`)
// matches none of the 21 unsigned blocks in that session, because the vendor
// writes `"signature":""` rather than omitting the key.

const CROSS_FIXTURE = path.join(here, '__fixtures__', 'adr099-cross-engine-transcript.jsonl');

test('ADR-099: default mode leaves a vendor transcript with no server_tool_use untouched', () => {
  withTmp((dir) => {
    const file = path.join(dir, 't.jsonl');
    fs.copyFileSync(CROSS_FIXTURE, file);
    const before = fs.readFileSync(file, 'utf8');

    const result = repairTranscriptFile(file);

    assert.equal(result.reason, 'clean', 'the pre-filter still short-circuits');
    assert.equal(result.blocks, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'byte-for-byte unchanged');
  });
});

test('ADR-099: cross-engine mode rewrites what the default mode cannot even see', () => {
  withTmp((dir) => {
    const file = path.join(dir, 't.jsonl');
    fs.copyFileSync(CROSS_FIXTURE, file);

    const result = repairTranscriptFile(file, 'cross-engine');

    assert.ok(result.blocks >= 3, `expected the 3 real blocks, got ${result.blocks}`);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(!after.includes('"type":"tool_use"'), 'the call_… tool_use is gone');
    assert.ok(!after.includes('"type":"thinking"'), 'the empty-signature thinking is gone');
    // Both halves of the pair move together: an orphan tool_result would trade
    // one 400 for another.
    assert.ok(!after.includes('"type":"tool_result"'), 'the matching tool_result is gone too');
  });
});

test('ADR-099: cross-engine repair preserves the content it converts', () => {
  withTmp((dir) => {
    const file = path.join(dir, 't.jsonl');
    fs.copyFileSync(CROSS_FIXTURE, file);
    const originalToolName = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0])
      .message.content.find((b: { type: string }) => b.type === 'tool_use').name;

    repairTranscriptFile(file, 'cross-engine');

    const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    const text = first.message.content.map((b: { text?: string }) => b.text ?? '').join('\n');
    assert.ok(text.includes(originalToolName), 'the tool name survives as text');
  });
});

test('ADR-099: cross-engine keeps a pre-crossing backup, and refuses to write without one', () => {
  withTmp((dir) => {
    const file = path.join(dir, 't.jsonl');
    fs.copyFileSync(CROSS_FIXTURE, file);
    const original = fs.readFileSync(file, 'utf8');

    repairTranscriptFile(file, 'cross-engine');

    const backup = `${file}.nassaj-precross.bak`;
    assert.ok(fs.existsSync(backup), 'backup written before the destructive rewrite');
    assert.equal(fs.readFileSync(backup, 'utf8'), original, 'backup is the untouched original');
  });
});

test('ADR-099: a signed thinking block is NOT touched', () => {
  const record = {
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'real reasoning', signature: 'sig_abc123' },
        { type: 'text', text: 'hello' },
      ],
    },
  };

  assert.equal(repairRecord(record, [], 'cross-engine'), 0);
  assert.equal(record.message.content[0].type, 'thinking');
});
