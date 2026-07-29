/**
 * claude-transcript-fork.test.ts — T-1090 (the `/btw` fork).
 *
 * Locks the branch rules that make a forked transcript RESUMABLE rather than
 * merely present on disk. Each assertion maps to a way a fork silently breaks:
 *
 *   - a kept `sessionId` ⇒ nassaj's own reader (which filters lines by
 *     `entry.sessionId === sessionId`) opens the branch EMPTY;
 *   - a kept uuid ⇒ two sessions share message ids;
 *   - a `parentUuid` pointing at a dropped `progress` row ⇒ a broken chain;
 *   - sidechain (subagent) rows carried over ⇒ foreign traffic in the branch;
 *   - a missing appended pair ⇒ the fork does not actually continue the side
 *     thread, which is the whole point of the feature.
 *
 * The last test forks a REAL transcript from this host when one exists (the
 * 2026-06-28 lesson: green tests over synthetic fixtures proved nothing about
 * production data). It asserts structure only — never content — and skips
 * cleanly on a machine with no Claude transcripts.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

import {
  forkClaudeTranscript,
  TranscriptForkError,
} from '../claude-transcript-fork.js';

const SOURCE_SESSION = '11111111-1111-4111-8111-111111111111';

type AnyEntry = Record<string, unknown>;

/** Deterministic id generator so assertions can name the forked uuids. */
function makeIdGen(prefix = 'gen') {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

function entry(overrides: AnyEntry): AnyEntry {
  return {
    sessionId: SOURCE_SESSION,
    cwd: '/workspace/demo',
    version: '2.1.219',
    gitBranch: 'main',
    userType: 'external',
    isSidechain: false,
    timestamp: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function userEntry(uuid: string, parentUuid: string | null, text: string): AnyEntry {
  return entry({
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function assistantEntry(uuid: string, parentUuid: string | null, text: string): AnyEntry {
  return entry({
    type: 'assistant',
    uuid,
    parentUuid,
    message: {
      id: 'msg_original',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text }],
    },
  });
}

async function writeTranscript(dir: string, sessionId: string, entries: AnyEntry[]): Promise<string> {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(filePath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  return filePath;
}

async function readEntries(filePath: string): Promise<AnyEntry[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AnyEntry);
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'btw-fork-'));
}

describe('forkClaudeTranscript', () => {
  test('rewrites every id and sessionId, and appends the /btw exchange', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [
      userEntry('u1', null, 'first question'),
      assistantEntry('a1', 'u1', 'first answer'),
      // Sidecar metadata: describes the session, is not part of the conversation.
      { type: 'ai-title', sessionId: SOURCE_SESSION, aiTitle: 'Original title' },
    ]);

    const result = await forkClaudeTranscript({
      sourceFilePath: source,
      sourceSessionId: SOURCE_SESSION,
      extraMessages: [
        { role: 'user', content: 'why is the build slow?' },
        { role: 'assistant', content: 'because vite re-bundles the docs symlink' },
      ],
      title: 'btw: why is the build slow?',
      generateId: makeIdGen(),
      now: () => '2026-07-29T12:00:00.000Z',
    });

    assert.equal(result.forkedSessionId, 'gen-3'); // 2 uuids scanned, then the session id
    assert.equal(result.filePath, path.join(dir, 'gen-3.jsonl'));
    assert.equal(result.entryCount, 4); // 2 carried + the appended pair
    assert.equal(result.cwd, '/workspace/demo');

    const written = await readEntries(result.filePath);
    assert.equal(written.length, 5); // + the trailing custom-title row

    // (1) Every row is stamped with the NEW session id — the reader filters on it.
    for (const row of written) {
      assert.equal(row.sessionId, 'gen-3', `row ${String(row.type)} kept the old sessionId`);
    }

    // (2) No original uuid survives, and provenance is recorded.
    const [carriedUser, carriedAssistant, forkedUser, forkedAssistant, titleRow] = written;
    assert.equal(carriedUser.uuid, 'gen-1');
    assert.equal(carriedUser.parentUuid, null);
    assert.deepEqual(carriedUser.forkedFrom, { sessionId: SOURCE_SESSION, messageUuid: 'u1' });
    assert.equal(carriedAssistant.uuid, 'gen-2');
    assert.equal(carriedAssistant.parentUuid, 'gen-1');
    assert.deepEqual(carriedAssistant.forkedFrom, { sessionId: SOURCE_SESSION, messageUuid: 'a1' });

    // (3) The sidecar metadata row is NOT part of the branch.
    assert.equal(
      written.some((row) => row.type === 'ai-title'),
      false,
      'sidecar metadata must not be carried into the branch',
    );

    // (4) The /btw exchange continues the branch, chained to its tip.
    assert.equal(forkedUser.type, 'user');
    assert.equal(forkedUser.parentUuid, 'gen-2');
    assert.deepEqual(forkedUser.message, {
      role: 'user',
      content: [{ type: 'text', text: 'why is the build slow?' }],
    });
    assert.equal(forkedAssistant.type, 'assistant');
    assert.equal(forkedAssistant.parentUuid, forkedUser.uuid);
    const answer = forkedAssistant.message as { content: Array<{ text: string }>; model?: string };
    assert.equal(answer.content[0].text, 'because vite re-bundles the docs symlink');
    // The appended reply inherits the conversation's own model/cwd/version.
    assert.equal(answer.model, 'claude-opus-5');
    assert.equal(forkedAssistant.cwd, '/workspace/demo');
    assert.equal(forkedAssistant.version, '2.1.219');

    // (5) The title row is last, so the synchronizer's end-scan finds it first.
    assert.equal(titleRow.type, 'custom-title');
    assert.equal(titleRow.customTitle, 'btw: why is the build slow?');
    assert.equal(titleRow.sessionId, 'gen-3');

    // (6) The branch tip carries the fork time so it sorts as new; older rows keep
    //     their original timestamps.
    assert.equal(carriedUser.timestamp, '2026-07-01T00:00:00.000Z');
    assert.equal(carriedAssistant.timestamp, '2026-07-29T12:00:00.000Z');
  });

  test('drops progress rows and re-links their children to the nearest kept parent', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [
      userEntry('u1', null, 'question'),
      entry({ type: 'progress', uuid: 'p1', parentUuid: 'u1' }),
      entry({ type: 'progress', uuid: 'p2', parentUuid: 'p1' }),
      assistantEntry('a1', 'p2', 'answer'),
    ]);

    const result = await forkClaudeTranscript({
      sourceFilePath: source,
      sourceSessionId: SOURCE_SESSION,
      generateId: makeIdGen(),
      now: () => '2026-07-29T12:00:00.000Z',
    });

    const written = await readEntries(result.filePath);
    const carried = written.filter((row) => row.type !== 'custom-title');
    assert.equal(carried.length, 2);
    assert.equal(
      carried.some((row) => row.type === 'progress'),
      false,
      'progress rows must not be written into the branch',
    );
    // u1 → gen-1, p1 → gen-2, p2 → gen-3, a1 → gen-4: the assistant must skip the
    // two dropped progress rows and point at the user message.
    assert.equal(carried[1].uuid, 'gen-4');
    assert.equal(carried[1].parentUuid, 'gen-1');
  });

  test('excludes sidechain (subagent) rows', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [
      userEntry('u1', null, 'question'),
      { ...assistantEntry('side1', 'u1', 'subagent chatter'), isSidechain: true },
      assistantEntry('a1', 'u1', 'answer'),
    ]);

    const result = await forkClaudeTranscript({
      sourceFilePath: source,
      sourceSessionId: SOURCE_SESSION,
      generateId: makeIdGen(),
    });

    const written = await readEntries(result.filePath);
    const carried = written.filter((row) => row.type !== 'custom-title');
    assert.equal(carried.length, 2);
    for (const row of carried) {
      assert.notEqual(
        (row.forkedFrom as { messageUuid?: string } | undefined)?.messageUuid,
        'side1',
      );
      assert.equal(row.isSidechain, false);
    }
  });

  test('truncates the branch at upToMessageId, and refuses an unknown pin', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [
      userEntry('u1', null, 'first'),
      assistantEntry('a1', 'u1', 'first answer'),
      userEntry('u2', 'a1', 'second'),
      assistantEntry('a2', 'u2', 'second answer'),
    ]);

    const truncated = await forkClaudeTranscript({
      sourceFilePath: source,
      sourceSessionId: SOURCE_SESSION,
      upToMessageId: 'a1',
      generateId: makeIdGen(),
    });
    const written = await readEntries(truncated.filePath);
    const carried = written.filter((row) => row.type !== 'custom-title');
    assert.equal(carried.length, 2);
    assert.deepEqual(
      carried.map((row) => (row.forkedFrom as { messageUuid: string }).messageUuid),
      ['u1', 'a1'],
    );

    await assert.rejects(
      () =>
        forkClaudeTranscript({
          sourceFilePath: source,
          sourceSessionId: SOURCE_SESSION,
          upToMessageId: 'does-not-exist',
          generateId: makeIdGen('x'),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptForkError);
        assert.equal(error.code, 'message_not_found');
        return true;
      },
    );
  });

  test('refuses a transcript with no conversation rows and leaves no partial file', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [
      { type: 'ai-title', sessionId: SOURCE_SESSION, aiTitle: 'Only metadata' },
    ]);

    await assert.rejects(
      () =>
        forkClaudeTranscript({
          sourceFilePath: source,
          sourceSessionId: SOURCE_SESSION,
          generateId: makeIdGen(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptForkError);
        assert.equal(error.code, 'source_empty');
        return true;
      },
    );

    const files = await readdir(dir);
    assert.deepEqual(files, [`${SOURCE_SESSION}.jsonl`], 'no branch or .tmp file may be left behind');
  });

  test('reports a missing transcript as source_unreadable', async () => {
    const dir = await tempDir();
    await assert.rejects(
      () =>
        forkClaudeTranscript({
          sourceFilePath: path.join(dir, 'nope.jsonl'),
          sourceSessionId: SOURCE_SESSION,
        }),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptForkError);
        assert.equal(error.code, 'source_unreadable');
        return true;
      },
    );
  });

  test('skips malformed lines instead of aborting the fork', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, `${SOURCE_SESSION}.jsonl`);
    await writeFile(
      filePath,
      [
        JSON.stringify(userEntry('u1', null, 'question')),
        '{ this is not json',
        '',
        JSON.stringify(assistantEntry('a1', 'u1', 'answer')),
      ].join('\n'),
      'utf8',
    );

    const result = await forkClaudeTranscript({
      sourceFilePath: filePath,
      sourceSessionId: SOURCE_SESSION,
      generateId: makeIdGen(),
    });
    const written = await readEntries(result.filePath);
    assert.equal(written.filter((row) => row.type !== 'custom-title').length, 2);
  });

  // ── T-1091: fresh-thread mode (includeHistory:false) ──────────────────────

  test('fresh mode writes ONLY the exchange, seeded from the source head', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [
      userEntry('u1', null, 'a long prior conversation'),
      assistantEntry('a1', 'u1', 'with plenty of history'),
      userEntry('u2', 'a1', 'and more'),
      assistantEntry('a2', 'u2', 'and more still'),
    ]);

    const result = await forkClaudeTranscript({
      sourceFilePath: source,
      sourceSessionId: SOURCE_SESSION,
      includeHistory: false,
      extraMessages: [
        { role: 'user', content: 'side question' },
        { role: 'assistant', content: 'side answer' },
      ],
      title: 'btw: side question',
      generateId: makeIdGen(),
      now: () => '2026-07-29T12:00:00.000Z',
    });

    const written = await readEntries(result.filePath);
    assert.equal(written.length, 3, 'the pair plus the title row — nothing inherited');
    assert.equal(result.entryCount, 2);

    // Nothing from the source conversation came along.
    assert.equal(
      written.some((row) => 'forkedFrom' in row),
      false,
      'a fresh thread carries no inherited entry',
    );
    const [question, answer, title] = written;
    assert.equal(question.type, 'user');
    assert.equal(question.parentUuid, null, 'the question is the thread root');
    assert.equal(answer.parentUuid, question.uuid);
    assert.equal(title.type, 'custom-title');
    assert.equal(title.customTitle, 'btw: side question');

    // Still a valid transcript IN THIS PROJECT: cwd is what the synchronizer
    // reads to place the session, so it must be inherited from the source head.
    assert.equal(question.cwd, '/workspace/demo');
    assert.equal(question.version, '2.1.219');
    assert.equal(result.cwd, '/workspace/demo');
    for (const row of written) {
      assert.equal(row.sessionId, result.forkedSessionId);
    }
  });

  test('fresh mode refuses a source with no usable cwd (the branch would belong nowhere)', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [
      { type: 'ai-title', sessionId: SOURCE_SESSION, aiTitle: 'metadata only' },
    ]);

    await assert.rejects(
      () =>
        forkClaudeTranscript({
          sourceFilePath: source,
          sourceSessionId: SOURCE_SESSION,
          includeHistory: false,
          extraMessages: [{ role: 'user', content: 'q' }],
          generateId: makeIdGen(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptForkError);
        assert.equal(error.code, 'source_empty');
        return true;
      },
    );
  });

  test('fresh mode refuses an empty exchange (there would be no thread at all)', async () => {
    const dir = await tempDir();
    const source = await writeTranscript(dir, SOURCE_SESSION, [userEntry('u1', null, 'hi')]);

    await assert.rejects(
      () =>
        forkClaudeTranscript({
          sourceFilePath: source,
          sourceSessionId: SOURCE_SESSION,
          includeHistory: false,
          extraMessages: [],
          generateId: makeIdGen(),
        }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'source_empty');
        return true;
      },
    );
  });

  // Real production data (2026-06-28 lesson). Structure only — no content is read
  // into assertions, printed, or copied outside the temp dir.
  test('forks a REAL transcript from this host into a well-formed branch', async (t) => {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    let sourceFile: string | null = null;
    let sourceSessionId = '';

    try {
      const projectDirs = await readdir(projectsRoot);
      for (const projectDir of projectDirs) {
        const dirPath = path.join(projectsRoot, projectDir);
        let files: string[];
        try {
          files = await readdir(dirPath);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith('.jsonl')) {
            continue;
          }
          const candidate = path.join(dirPath, file);
          const stats = await stat(candidate).catch(() => null);
          // Small enough to fork fast, big enough to be a real conversation.
          if (!stats?.isFile() || stats.size < 4_000 || stats.size > 400_000) {
            continue;
          }
          sourceFile = candidate;
          sourceSessionId = path.basename(file, '.jsonl');
          break;
        }
        if (sourceFile) {
          break;
        }
      }
    } catch {
      sourceFile = null;
    }

    if (!sourceFile) {
      t.skip('no Claude transcript available on this host');
      return;
    }

    const dir = await tempDir();
    const workDir = path.join(dir, 'projects');
    await mkdir(workDir, { recursive: true });
    const copy = path.join(workDir, `${sourceSessionId}.jsonl`);
    await writeFile(copy, await readFile(sourceFile), { flag: 'wx' });

    const result = await forkClaudeTranscript({
      sourceFilePath: copy,
      sourceSessionId,
      extraMessages: [
        { role: 'user', content: 'side question' },
        { role: 'assistant', content: 'side answer' },
      ],
      title: 'btw: side question',
    });

    let rows = 0;
    let lastType = '';
    let sawUser = false;
    let sawAssistant = false;
    const seenUuids = new Set<string>();
    const stream = createReadStream(result.filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      // Every written line must be valid JSON — a resume reads them all.
      const row = JSON.parse(line) as AnyEntry;
      rows += 1;
      lastType = String(row.type ?? '');
      assert.equal(row.sessionId, result.forkedSessionId);
      if (row.type === 'user') sawUser = true;
      if (row.type === 'assistant') sawAssistant = true;
      if (typeof row.uuid === 'string') {
        assert.equal(seenUuids.has(row.uuid), false, 'branch uuids must be unique');
        seenUuids.add(row.uuid);
      }
      assert.notEqual(row.isSidechain, true, 'no sidechain row may reach the branch');
    }
    rl.close();
    stream.destroy();

    assert.ok(rows > 2, 'a real transcript must yield a non-trivial branch');
    assert.equal(lastType, 'custom-title', 'the title row must be written last');
    assert.ok(sawUser && sawAssistant, 'the branch must contain both roles');
    assert.equal(result.entryCount, rows - 1);
    assert.ok(result.cwd, 'the branch must carry the project cwd for the synchronizer');
  });
});
