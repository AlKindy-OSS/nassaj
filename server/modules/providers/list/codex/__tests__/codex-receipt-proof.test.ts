import assert from 'node:assert/strict';
import test, { before, after, type TestContext } from 'node:test';
import { writeFile, appendFile, unlink, open, stat, truncate, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { initializeDatabase, closeConnection, sessionsDb } from '@/modules/database/index.js';

import { captureCodexReceiptWindow, readCodexReceiptWindow, resolveCodexUserProof, codexUserProofFromJsonl, codexReceiptPayloadHash, codexNativePayloadHash } from '../codex-receipt-proof.js';
import { CODEX_IMAGE_INPUT_MAX_BYTES, validateCodexImageInput } from '../../../../../../shared/codex-image-input.js';

const image = 'data:image/png;base64,YQ==';
const human = (id = 'native-user', turn = 'turn-one', withImage = false) => ({ type: 'response_item', payload: {
  type: 'message', id, role: 'user', content: [
    ...(withImage ? [{ type: 'input_text', text: '<image name=[Image #1] path="/gone.png">' }, { type: 'input_image', image_url: image }, { type: 'input_text', text: '</image>' }] : []),
    { type: 'input_text', text: 'same request' },
  ], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['user.text'] },
} });
const ending = (turn = 'turn-one') => [{ type: 'response_item', payload: { type: 'message', id: `assistant-${turn}`, role: 'assistant', phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id: turn } } }, { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } }];
const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const hash = codexReceiptPayloadHash('same request')!;
const meta = (id = 'receipt-session') => ({ type: 'session_meta', payload: { id } });
before(initializeDatabase); after(closeConnection);

test('shared Codex image boundary is canonical, ordered and exact at four MiB', () => {
  const prefix = 'data:image/png;base64,';
  const exact = prefix + 'A'.repeat(CODEX_IMAGE_INPUT_MAX_BYTES - prefix.length - 2);
  assert.equal(validateCodexImageInput('xx', [exact]).ok, true);
  assert.deepEqual(validateCodexImageInput('xxx', [exact]), { ok: false, reason: 'too_large' });
  assert.deepEqual(validateCodexImageInput('x'.repeat(CODEX_IMAGE_INPUT_MAX_BYTES + 1), []), { ok: false, reason: 'too_large' });
  assert.deepEqual(validateCodexImageInput('', ['data:image/png;base64,YR==']), { ok: false, reason: 'invalid' });
  assert.deepEqual(validateCodexImageInput('', ['data:image/svg+xml;base64,PHN2Zy8+']), { ok: false, reason: 'unsupported' });
});

test('resumed exact sole user/turn proves identity; content hash only checks completeness', () => {
  const proof = codexUserProofFromJsonl(encode([human(), ...ending()]), 'receipt-session', 'resume', hash);
  assert.equal(proof?.userMessageId, 'native-user');
  assert.equal(codexUserProofFromJsonl(encode([human(), ...ending()]), 'receipt-session', 'resume', codexReceiptPayloadHash('different')!), null);
});
const goalContext = (id = 'native-goal', turn = 'turn-one') => ({ type: 'response_item', payload: {
  type: 'message', id, role: 'user', content: [{ type: 'input_text', text: 'provider goal context' }],
  internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['goal.internal_context'] },
} });

const environmentContext = (turn = 'turn-one', id = 'native-environment') => ({ type: 'response_item', payload: {
  type: 'message', id, role: 'user',
  content: [{ type: 'input_text', text: '<environment_context>workspace</environment_context>' }],
  internal_chat_message_metadata_passthrough: {
    turn_id: turn,
    content_item_kinds: ['environments.environment_context'],
  },
} });

test('B997 native goal context preserves the exact human receipt for new and resumed turns', () => {
  for (const mode of ['new', 'resume'] as const) {
    const rows = [...(mode === 'new' ? [meta()] : []), goalContext(), human(), ...ending()];
    assert.equal(codexUserProofFromJsonl(encode(rows), 'receipt-session', mode, hash)?.userMessageId, 'native-user');
  }
  const rows = [goalContext(), human('image-user', 'turn-one', true), ...ending()];
  assert.equal(codexUserProofFromJsonl(encode(rows), 'receipt-session', 'resume',
    codexReceiptPayloadHash('same request', [image])!)?.userMessageId, 'image-user');
});

test('resumed environment singleton before human final and complete preserves the exact receipt', () => {
  const proof = codexUserProofFromJsonl(
    encode([environmentContext(), human(), ...ending()]),
    'receipt-session',
    'resume',
    hash,
  );

  assert.equal(proof?.userMessageId, 'native-user');
  assert.equal(proof?.turnId, 'turn-one');
});

test('generated bootstrap is accepted once before the human only', () => {
  assert.equal(codexUserProofFromJsonl(
    encode([meta(), environmentContext(), human(), ...ending()]),
    'receipt-session', 'new', hash,
  )?.userMessageId, 'native-user');
  assert.equal(codexUserProofFromJsonl(
    encode([environmentContext(), environmentContext('turn-one', 'native-environment-two'), human(), ...ending()]),
    'receipt-session', 'resume', hash,
  ), null);
  assert.equal(codexUserProofFromJsonl(
    encode([human(), environmentContext(), ...ending()]),
    'receipt-session', 'resume', hash,
  ), null);
});

test('B997 goal provenance never relaxes turn, duplicate ID or sole-human requirements', () => {
  const unmarked = goalContext(); unmarked.payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['user.text'];
  const malformed = goalContext(); malformed.payload.internal_chat_message_metadata_passthrough.content_item_kinds = [];
  const mixed = goalContext(); mixed.payload.content.push({ type: 'input_text', text: 'human input' });
  mixed.payload.internal_chat_message_metadata_passthrough.content_item_kinds.push('user.text');
  for (const rows of [
    [unmarked, human(), ...ending()], [malformed, human(), ...ending()], [mixed, human(), ...ending()],
    [goalContext('native-goal', 'other-turn'), human(), ...ending()],
    [goalContext('native-user'), human(), ...ending()], [goalContext(), human(), human('second'), ...ending()],
    [goalContext(), ...ending()], [goalContext(), human()],
    ...['isSidechain', 'isSynthetic', 'isReplay', 'parent_tool_use_id', 'agentId'].map(flag => {
      const goal = goalContext(); Object.assign(goal.payload, { [flag]: true });
      return [goal, human(), ...ending()];
    }),
  ]) assert.equal(codexUserProofFromJsonl(encode(rows), 'receipt-session', 'resume', hash), null);
});

test('first minted thread validates session metadata and generated bootstrap, never imported users', () => {
  const bootstrap = { type: 'response_item', payload: { type: 'message', id: 'context', role: 'user',
    content: [{ type: 'input_text', text: '<recommended_plugins>x</recommended_plugins>' }, { type: 'input_text', text: '<environment_context>x</environment_context>' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-one', content_item_kinds: ['plugins.recommendations', 'environments.environment_context'] } } };
  assert.ok(codexUserProofFromJsonl(encode([meta(), bootstrap, human(), ...ending()]), 'receipt-session', 'new', hash));
  for (const rows of [[human(), ...ending()], [meta('foreign'), human(), ...ending()], [meta(), human('older'), human(), ...ending()]]) {
    assert.equal(codexUserProofFromJsonl(encode(rows), 'receipt-session', 'new', hash), null);
  }
});
test('identical prompts, multiple turns, duplicate IDs, abort, missing completion and partial JSON fail closed', () => {
  for (const rows of [[human(), human('second'), ...ending()], [human(), ...ending('other')], [human(), ...ending(), ...ending()], [human(), ...ending(), { type: 'event_msg', payload: { type: 'turn_aborted' } }], [human()]]) {
    assert.equal(codexUserProofFromJsonl(encode(rows), 'receipt-session', 'resume', hash), null);
  }
  const full = encode([human(), ...ending()]);
  assert.equal(codexUserProofFromJsonl(full.trimEnd(), 'receipt-session', 'resume', hash), null);
  assert.equal(codexUserProofFromJsonl(full + '{broken}\n', 'receipt-session', 'resume', hash), null);
});
test('text plus image includes every original byte; absent, changed and unknown parts retain the copy', () => {
  const native = human('native-user', 'turn-one', true);
  assert.ok(codexUserProofFromJsonl(encode([native, ...ending()]), 'receipt-session', 'resume', codexReceiptPayloadHash('same request', [image])!));
  assert.equal(codexUserProofFromJsonl(encode([native, ...ending()]), 'receipt-session', 'resume', hash), null);
  const unknown = structuredClone(native); unknown.payload.content.push({ type: 'audio' } as never);
  assert.equal(codexUserProofFromJsonl(encode([unknown, ...ending()]), 'receipt-session', 'resume', hash), null);
});
test('pre-run window excludes old complete turns and rejects replacement, truncation and partial boundary', async () => {
  const file = path.join((process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR)!, 'receipt-window.jsonl');
  await writeFile(file, encode([meta(), human('old'), ...ending()]));
  sessionsDb.createSession('receipt-window', 'codex', '/fixture', undefined, undefined, undefined, file);
  const baseline = await captureCodexReceiptWindow('receipt-window', 'resume'); assert.ok(baseline);
  await appendFile(file, encode([human('new'), ...ending()]));
  assert.equal((await resolveCodexUserProof('receipt-window', baseline, false, hash))?.userMessageId, 'new');
  await writeFile(file, 'x'); assert.equal(await readCodexReceiptWindow(baseline), null);
  assert.equal(await captureCodexReceiptWindow('receipt-window', 'resume'), null);
  await unlink(file); await writeFile(file, encode([meta(), human(), ...ending()]));
  assert.equal(await readCodexReceiptWindow(baseline), null);
});
test('new-thread delayed index uses zero offset; resumed missing baseline never falls back to whole file', async () => {
  const file = path.join((process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR)!, 'late-index.jsonl');
  await writeFile(file, encode([meta('late-index'), human(), ...ending()]));
  const timer = setTimeout(() => sessionsDb.createSession('late-index', 'codex', '/fixture', undefined, undefined, undefined, file), 20);
  try {
    assert.ok(await resolveCodexUserProof('late-index', null, true, hash));
    assert.equal(await resolveCodexUserProof('late-index', null, false, hash), null);
  } finally { clearTimeout(timer); }
});


const MiB = 1024 * 1024;
let snapshotSequence = 0;
async function snapshot(rows: unknown[] = [], prefix = '') {
  const sessionId = `bounded-receipt-${++snapshotSequence}`;
  const file = path.join((process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR)!, `${sessionId}.jsonl`);
  await writeFile(file, prefix);
  sessionsDb.createSession(sessionId, 'codex', '/fixture', undefined, undefined, undefined, file);
  const window = await captureCodexReceiptWindow(sessionId, 'resume'); assert.ok(window);
  if (rows.length) await appendFile(file, encode(rows));
  return { file, sessionId, window, resolve: (expected = hash) => resolveCodexUserProof(sessionId, window, false, expected) };
}
const padding = (length: number) => ({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(length) } });
async function padFile(file: string, count: number, length = 256 * 1024) {
  const row = encode([padding(length)]);
  const handle = await open(file, 'a');
  try { for (let index = 0; index < count; index++) await handle.write(row); }
  finally { await handle.close(); }
}
async function monitorReads(t: TestContext, change?: (file: any, length: number, position: number) => Promise<void>) {
  const probe = await open(path.join((process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR)!, 'handle-probe'), 'w+');
  const prototype = Object.getPrototypeOf(probe), read = prototype.read;
  await probe.close();
  const report = { bytes: 0, reads: 0, snapshots: 0, handles: new Set<any>() };
  t.mock.method(prototype, 'read', async function (this: any, buffer: Buffer, offset: number, length: number, position: number) {
    report.bytes += length; report.reads++; report.handles.add(this);
    if (length === 65536 && position === 0) report.snapshots++;
    const result = await read.call(this, buffer, offset, length, position);
    if (change) await change(this, length, position);
    return result;
  });
  return report;
}
async function assertClosed(handles: Set<any>) {
  for (const handle of handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
}

test('bounded scanner proves an exact four-MiB input whose native envelope exceeds the legacy cap', async () => {
  const text = 'x'.repeat(4 * MiB), user = human();
  user.payload.content = [{ type: 'input_text', text }] as never;
  const f = await snapshot([user, ...ending()]);
  assert.ok((await stat(f.file)).size > 4 * MiB);
  assert.equal(await readCodexReceiptWindow(f.window), null);
  assert.equal((await f.resolve(codexReceiptPayloadHash(text)!))?.userMessageId, 'native-user');
});

test('multiple tool rows over four MiB preserve proof and read work grows linearly', async t => {
  const reads = await monitorReads(t), sizes: number[] = [], work: number[] = [];
  for (const count of [20, 40]) {
    const f = await snapshot([human()]); await padFile(f.file, count); await appendFile(f.file, encode(ending()));
    sizes.push((await stat(f.file)).size);
    const before = reads.bytes;
    assert.ok(await f.resolve()); work.push(reads.bytes - before);
  }
  assert.deepEqual(work, sizes);
  assert.ok(work[1] / work[0] > 1.99 && work[1] / work[0] < 2.01);
  await assertClosed(reads.handles);
});

for (const [label, tail] of [
  ['duplicate', encode([human()])], ['second user', encode([human('second')])],
  ['second turn', encode([{ payload: { turn_id: 'another-turn' } }])],
  ['abort', encode([{ type: 'event_msg', payload: { type: 'turn_aborted' } }])],
  ['failed', encode([{ type: 'event_msg', payload: { type: 'task_failed' } }])],
  ['malformed', '{bad}\n'], ['partial tail', '{'],
] as const) {
  test(`late ${label} after completion and four MiB invalidates the entire snapshot`, async t => {
    const f = await snapshot([human(), ...ending()]); await padFile(f.file, 17); await appendFile(f.file, tail);
    const reads = await monitorReads(t);
    assert.equal(await f.resolve(), null); assert.equal(reads.snapshots, 1);
    await assertClosed(reads.handles);
  });
}

test('raw UTF-8 and LF split across chunks are validated without replacement characters', async () => {
  const prefix = '{"payload":{"note":"';
  for (const invalidUtf8 of [false, true]) {
    const row = Buffer.from(prefix + 'a'.repeat(65535 - prefix.length) + '😀' + '"}}\n');
    if (invalidUtf8) row[65536] = 0xff;
    const f = await snapshot(); await appendFile(f.file, row); await appendFile(f.file, encode([human(), ...ending()]));
    assert.equal(Boolean(await f.resolve()), !invalidUtf8);
  }
  const line = prefix + 'a'.repeat(65536 - prefix.length - 4) + '"}}\n';
  assert.equal(Buffer.byteLength(line), 65536);
  const f = await snapshot(); await appendFile(f.file, line + encode([human(), ...ending()])); assert.ok(await f.resolve());
});

test('escaped string punctuation across chunks does not consume structural depth', async () => {
  const prefix = '{"payload":{"note":"';
  const line = prefix + 'a'.repeat(65535 - prefix.length) + '\\"' + '[]{}'.repeat(100) + '"}}\n';
  const f = await snapshot(); await appendFile(f.file, line + encode([human(), ...ending()]));
  assert.ok(await f.resolve());
});

for (const [depth, accepted] of [[62, true], [63, false]] as const) {
  test(`JSON nesting depth ${depth + 2} is guarded before parse`, async t => {
    const f = await snapshot();
    await appendFile(f.file, '{"payload":{"extra":' + '['.repeat(depth) + '0' + ']'.repeat(depth) + '}}\n' + encode([human(), ...ending()]));
    const parse = JSON.parse; let blockedRecordParsed = false;
    t.mock.method(JSON, 'parse', (text: string, ...rest: any[]) => {
      if (text.startsWith('{"payload":{"extra":')) blockedRecordParsed = true;
      return parse(text, ...rest);
    });
    assert.equal(Boolean(await f.resolve()), accepted);
    assert.equal(blockedRecordParsed, accepted);
  });
}

const tokens = (value: unknown) => (JSON.stringify(value).match(/"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?|[{}[\]:,]/gu) ?? []).length;
function tokenRow(count: number) {
  const length = Math.floor((count - 9) / 2);
  const values: unknown[] = Array(length).fill(0);
  if (count % 2 === 0) values[0] = {};
  const row = { payload: { extra: values } };
  assert.equal(tokens(row), count); return row;
}
for (const count of [65536, 65537]) {
  test(`record structural token count ${count} enforces the pre-parse bound`, async () => {
    const f = await snapshot([tokenRow(count), human(), ...ending()]);
    assert.equal(Boolean(await f.resolve()), count === 65536);
  });
}

test('aggregate structural tokens are shared across all records', async t => {
  t.mock.method(performance, 'now', () => 0);
  const required = [human(), ...ending()], overhead = required.reduce((sum, row) => sum + tokens(row), 0);
  for (const extra of [0, 1]) {
    const f = await snapshot();
    const block = encode([tokenRow(65536)]);
    for (let index = 0; index < 15; index++) await appendFile(f.file, block);
    await appendFile(f.file, encode([tokenRow(65536 - overhead + extra), ...required]));
    assert.equal(Boolean(await f.resolve()), extra === 0);
  }
});

for (const count of [65536, 65537]) {
  test(`snapshot record count ${count} preserves the shared bound`, async t => {
    t.mock.method(performance, 'now', () => 0);
    const f = await snapshot();
    await appendFile(f.file, '{"payload":{}}\n'.repeat(count - 3) + encode([human(), ...ending()]));
    assert.equal(Boolean(await f.resolve()), count === 65536);
  });
}
for (const count of [8192, 8193]) {
  test(`snapshot native message ID count ${count} is bounded independently of content`, async t => {
    t.mock.method(performance, 'now', () => 0);
    const f = await snapshot([human()]);
    const rows = Array.from({ length: count - 2 }, (_, index) => ({ type: 'response_item', payload: { type: 'message', role: 'tool', id: `id-${index}` } }));
    await appendFile(f.file, encode([...rows, ...ending()]));
    assert.equal(Boolean(await f.resolve()), count === 8192);
  });
}

test('oversize snapshot is rejected before allocating or reading its body', async t => {
  const f = await snapshot(); await truncate(f.file, 64 * MiB + 1);
  const reads = await monitorReads(t);
  assert.equal(await f.resolve(), null); assert.equal(reads.bytes, 0); assert.equal(reads.reads, 0);
});

test('record limit includes LF and an oversized tool record cannot be skipped', async t => {
  t.mock.method(performance, 'now', () => 0);
  const prefix = '{"payload":{"note":"', suffix = '"}}\n';
  for (const extra of [0, 1]) {
    const f = await snapshot([human()]);
    const handle = await open(f.file, 'a');
    try {
      await handle.write(prefix);
      let remaining = 32 * MiB + extra - prefix.length - suffix.length;
      const block = Buffer.alloc(65536, 120);
      while (remaining) { const length = Math.min(remaining, block.length); await handle.write(block.subarray(0, length)); remaining -= length; }
      await handle.write(suffix + encode(ending()));
    } finally { await handle.close(); }
    assert.equal(Boolean(await f.resolve()), extra === 0);
  }
});

test('deadline expiry after IO cannot return a proof and always closes the file', async t => {
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const f = await snapshot([human(), ...ending()]); await padFile(f.file, 1);
  const reads = await monitorReads(t, async (_file, length) => { if (length > 0) clock = 1500; });
  assert.equal(await f.resolve(), null); assert.equal(reads.snapshots, 1);
  await assertClosed(reads.handles);
});

test('incomplete snapshot retries share the 128-MiB IO budget and fresh reducer state', async t => {
  t.mock.method(performance, 'now', () => 0);
  const f = await snapshot([human()]); await padFile(f.file, 24, MiB);
  const reads = await monitorReads(t);
  assert.equal(await f.resolve(), null);
  assert.equal(reads.snapshots, 6); assert.ok(reads.bytes <= 128 * MiB && reads.bytes > 127 * MiB);
  await assertClosed(reads.handles);
});

test('stable incomplete snapshot can gain an ending on retry without duplicate-state leakage', async t => {
  const f = await snapshot([human()]);
  const probe = await open(f.file, 'r'), prototype = Object.getPrototypeOf(probe), fileStat = prototype.stat;
  await probe.close(); let checks = 0;
  t.mock.method(prototype, 'stat', async function (this: any, ...args: any[]) {
    if (++checks === 3) await appendFile(f.file, encode(ending()));
    return fileStat.apply(this, args);
  });
  assert.ok(await f.resolve());
});

for (const mutation of ['append', 'truncate', 'replace', 'rewrite', 'boundary', 'remap'] as const) {
  test(`${mutation} during a scan invalidates the entire pinned snapshot`, async t => {
    const f = await snapshot([human(), ...ending()], '{"payload":{}}\n'); await padFile(f.file, 17);
    let changed = false;
    const get = sessionsDb.getSessionById;
    if (mutation === 'remap') t.mock.method(sessionsDb, 'getSessionById', (id: string) => {
      const row = get.call(sessionsDb, id);
      return row && changed && id === f.sessionId ? { ...row, jsonl_path: `${f.file}.other` } : row;
    });
    const reads = await monitorReads(t, async (_handle, length) => {
      if (changed || length !== 65536) return; changed = true;
      if (mutation === 'append') await appendFile(f.file, '\n');
      if (mutation === 'truncate') await truncate(f.file, 0);
      if (mutation === 'replace') { await rename(f.file, `${f.file}.old`); await writeFile(f.file, encode([human(), ...ending()])); }
      if (mutation === 'rewrite' || mutation === 'boundary') {
        const writer = await open(f.file, 'r+');
        try {
          await writer.write(' ', mutation === 'boundary' ? 0 : f.window.byteOffset, 'utf8');
          // Keep metadata drift deterministic even when the filesystem clock has not ticked.
          await writer.utimes(0, 1);
        }
        finally { await writer.close(); }
      }
    });
    assert.equal(await f.resolve(), null); assert.equal(changed, true);
    await assertClosed(reads.handles); await rm(`${f.file}.old`, { force: true });
  });
}


test('short reads fail closed before parsing and release the descriptor', async t => {
  const f = await snapshot([human(), ...ending()]);
  const probe = await open(f.file, 'r'), prototype = Object.getPrototypeOf(probe), read = prototype.read;
  await probe.close(); const handles = new Set<any>();
  t.mock.method(prototype, 'read', async function (this: any, ...args: any[]) {
    const result = await read.apply(this, args); handles.add(this);
    return args[2] > 0 ? { ...result, bytesRead: result.bytesRead - 1 } : result;
  });
  assert.equal(await f.resolve(), null); await assertClosed(handles);
});

test('deadline is checked after synchronous JSON parse, not only before IO', async t => {
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const f = await snapshot([human(), ...ending()]);
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, ...rest: any[]) => {
    const value = parse(text, ...rest);
    if (value?.payload?.id === 'native-user') clock = 1500;
    return value;
  });
  assert.equal(await f.resolve(), null);
});

test('deadline includes the delay between stable incomplete attempts', async t => {
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const f = await snapshot([human()]);
  const reads = await monitorReads(t);
  const timer = setTimeout(() => { clock = 1500; }, 20);
  try { assert.equal(await f.resolve(), null); }
  finally { clearTimeout(timer); }
  assert.equal(reads.handles.size, 1); await assertClosed(reads.handles);
});

if (process.env.B996_MEMORY_WORKER) {
  test('B996 isolated memory worker', async () => {
    global.gc?.();
    const baselineRss = process.memoryUsage().rss;
    const baselinePeak = process.resourceUsage().maxRSS * 1024;
    const withImage = process.env.B996_MEMORY_WORKER === 'newline-image';
    const text = withImage ? '\n'.repeat(4 * MiB - Buffer.byteLength(image) - 1) + 'x' : '\0'.repeat(4 * MiB);
    const user = human();
    user.payload.content = [{ type: 'input_text', text }, ...(withImage ? [{ type: 'input_image', image_url: image }] : [])] as never;
    const f = await snapshot([user, ...ending()]);
    const expected = codexReceiptPayloadHash(text, withImage ? [image] : [])!;
    assert.ok(expected);
    const started = performance.now();
    assert.ok(await f.resolve(expected));
    const elapsedMs = performance.now() - started;
    const peakRss = process.resourceUsage().maxRSS * 1024;
    const evidence = { scenario: process.env.B996_MEMORY_WORKER, baselineRss, baselinePeak,
      peakRss, growth: Math.max(0, peakRss - baselineRss), elapsedMs,
      inputBytes: Buffer.byteLength(text) + (withImage ? Buffer.byteLength(image) : 0),
      jsonlBytes: (await stat(f.file)).size, accepted: true };
    process.stdout.write(`B996_MEMORY_RESULT:${JSON.stringify(evidence)}\n`);
    assert.ok(evidence.growth <= 256 * MiB, JSON.stringify(evidence));
  });
} else {
  test('isolated escaping and newline-image peaks stay within 256 MiB including native hashing', async () => {
    for (const scenario of ['escapes', 'newline-image']) {
      const root = path.join((process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR)!, `memory-${scenario}`);
      await mkdir(root, { recursive: true });
      try {
        const env = { ...process.env, B996_MEMORY_WORKER: scenario, DATABASE_PATH: path.join(root, 'auth.db'), TMPDIR: root };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--experimental-test-module-mocks',
          '--test-force-exit', '--test', '--test-name-pattern=^B996 isolated memory worker$', fileURLToPath(import.meta.url)], {
          env,
          encoding: 'utf8', timeout: 30000, maxBuffer: MiB,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const match = result.stdout.match(/B996_MEMORY_RESULT:(\{[^\n]+\})/u); assert.ok(match, result.stdout + result.stderr);
        const measured = JSON.parse(match[1]);
        assert.ok(measured.accepted); assert.ok(measured.growth <= 256 * MiB);
        process.stdout.write(`B996_MEMORY_RESULT:${JSON.stringify(measured)}\n`);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
}

test('a complete 64-MiB snapshot remains provable while the next byte is rejected', async t => {
  t.mock.method(performance, 'now', () => 0);
  const f = await snapshot([human(), ...ending()]);
  const rowBytes = Buffer.byteLength(encode([padding(256 * 1024)]));
  await padFile(f.file, Math.floor((64 * MiB - (await stat(f.file)).size) / rowBytes) - 1);
  const remainder = 64 * MiB - (await stat(f.file)).size;
  await appendFile(f.file, encode([padding(remainder - Buffer.byteLength(encode([padding(0)])))]));
  assert.equal((await stat(f.file)).size, 64 * MiB);
  assert.ok(await f.resolve());
  await appendFile(f.file, '\n');
  const reads = await monitorReads(t);
  assert.equal(await f.resolve(), null); assert.equal(reads.bytes, 0);
});

for (const length of [256, 257]) {
  test(`native identifier length ${length} keeps the existing identity boundary`, async () => {
    const f = await snapshot([human('u'.repeat(length)), ...ending()]);
    assert.equal(Boolean(await f.resolve()), length === 256);
  });
}

test('record accounting survives incomplete-snapshot retries', async t => {
  t.mock.method(performance, 'now', () => 0);
  const f = await snapshot([human()]);
  await appendFile(f.file, '{"payload":{}}\n'.repeat(40000));
  const reads = await monitorReads(t);
  assert.equal(await f.resolve(), null); assert.equal(reads.snapshots, 2);
  await assertClosed(reads.handles);
});

test('structural-token accounting survives incomplete-snapshot retries', async t => {
  t.mock.method(performance, 'now', () => 0);
  const f = await snapshot([human()]);
  for (let index = 0; index < 9; index++) await appendFile(f.file, encode([tokenRow(65536)]));
  const reads = await monitorReads(t);
  assert.equal(await f.resolve(), null); assert.equal(reads.snapshots, 2);
  await assertClosed(reads.handles);
});


test('native image delimiter filtering is byte-identical to the old split/filter/join contract', () => {
  const examples = ['', '\n', '\n\n', 'text\n', '\ntext', '\r\ntext\r\n',
    '<image>\ntext\n</image>', '<image>\n</image>', '<image>\n</image>\n',
    'a\n<image>\nb\n</image>\nc', '\n<image>\n\n</image>\n',
    ' \t<image name=example>\r\ntext\r\n\t</image> ',
    '\u00a0\u2003<image name=صورة>\u202f\nالعربية\n\u3000</image>\u00a0',
    'literal <image> text\n<imagex>\n<image name="a>b">',
    '<image />\n<image\tname=x>\n</image>\n<IMAGE>\n</Image>',
  ];
  let seed = 17;
  for (let index = 0; index < 200; index++) {
    const lines: string[] = [];
    for (let line = 0; line < 12; line++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      lines.push(examples[seed % examples.length]);
    }
    examples.push(lines.join('\n').slice(0, 8192));
  }
  for (const original of examples) for (const withImage of [false, true]) {
    const blocks = ['', original, ''];
    const joined = blocks.filter(Boolean).join('\n');
    const expectedText = withImage ? joined.split('\n')
      .filter(line => !/^<\/?image(?:\s[^>]*)?>$/u.test(line.trim())).join('\n') : joined;
    const payload = { content: [...blocks.map(text => ({ type: 'input_text', text })),
      ...(withImage ? [{ type: 'input_image', image_url: image }] : [])] };
    assert.equal(codexNativePayloadHash(payload), codexReceiptPayloadHash(expectedText, withImage ? [image] : []));
  }
});


test('deadline reached during awaited close discards a complete proof and closes the descriptor', async t => {
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const f = await snapshot([human(), ...ending()]);
  let closes = 0;
  const patched = new Set<any>();
  const reads = await monitorReads(t, async handle => {
    if (patched.has(handle)) return;
    patched.add(handle);
    const close = handle.close;
    t.mock.method(handle, 'close', async () => {
      await close.call(handle); closes++; clock = 1500;
    });
  });
  assert.equal(await f.resolve(), null); assert.equal(closes, 1);
  await assertClosed(reads.handles);
});

test('processed message IDs share the resolve budget while retry duplicate sets stay fresh', async t => {
  t.mock.method(performance, 'now', () => 0);
  const rows = Array.from({ length: 4999 }, (_, index) => ({
    type: 'response_item', payload: { type: 'message', role: 'tool', id: `retry-id-${index}` },
  }));
  const f = await snapshot([human(), ...rows]);
  const reads = await monitorReads(t), parse = JSON.parse;
  let processedIds = 0;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    const row = parse(...args);
    if (row?.type === 'response_item' && row.payload?.type === 'message' && row.payload.id) processedIds++;
    return row;
  });
  assert.equal(await f.resolve(), null);
  assert.equal(reads.snapshots, 2);
  assert.equal(processedIds, 8193); // All 5000 first-snapshot IDs, then 3193 fresh retry IDs.
  await assertClosed(reads.handles);
});
