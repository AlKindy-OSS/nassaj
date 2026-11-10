import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { FAKE_OPENCODE_PARITY_PRELUDE, installManagedClaudePlugins } from './shared/__tests__/fake-opencode-parity.ts';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
  userDb,
} from './modules/database/index.js';
import { spawnOpenCode } from './opencode-cli.js';

// B-1761 (ADR-226): every OpenCode spawn attests governance, so the neutral source it copies
// into the member's opencode config home must exist.
mkdirSync(path.join(process.env.HOME, '.claude'), { recursive: true });
writeFileSync(path.join(process.env.HOME, '.claude', 'AGENTS.md'), '# neutral governance\n');

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeOpenCodeExecutable(binDir) {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, `${FAKE_OPENCODE_PARITY_PRELUDE}
const events = [
  { type: 'text', sessionID: 'open-live-1', text: 'assistant response' },
  { type: 'step_finish', sessionID: 'open-live-1' },
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
`, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'opencode.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

async function withIsolatedDatabase(runTest) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp('/var/tmp/opencode-cli-db-');
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('spawnOpenCode records the spawning user so the web session is native (T-857 part أ)', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp('/var/tmp/opencode-cli-native-');
  const previousOpenCodePath = process.env.OPENCODE_PATH;
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPathExt = process.env[pathExtKey];

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env.OPENCODE_PATH = path.join(
      tempRoot,
      process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
    );
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await withIsolatedDatabase(async () => {
      const userId = userDb.createUser(`u_oc_${Date.now()}`, 'hash', 'user').id;
      installManagedClaudePlugins(process.env.HOME, userId);
      const messages = [];
      const writer = {
        userId,
        sessionId: null,
        send(message) {
          messages.push(message);
        },
        setSessionId(sessionId) {
          this.sessionId = sessionId;
        },
      };

      // New session: id 'open-live-1' is captured from the process output.
      await spawnOpenCode('Build it', { cwd: tempRoot }, writer);

      // recordSpawn ran on the web path: a participant row now exists, so the
      // session passes the native predicate and is listed for its project.
      assert.equal(participantsDb.hasParticipant('open-live-1'), true);
      assert.equal(participantsDb.isParticipant('open-live-1', userId), true);
      assert.equal(sessionsDb.countSessionsByProjectPath(tempRoot), 1);
      assert.deepEqual(
        sessionsDb.getSessionsByProjectPathPage(tempRoot, 50, 0).map((row) => row.session_id),
        ['open-live-1'],
      );
      const complete = messages.find((message) => message.kind === 'complete');
      assert.notEqual(complete?.responseTurnMetric?.durationMs, null,
        'a normalized live stream_delta must produce a measured terminal turn');
      assert.equal(typeof complete?.responseTurnMetric?.durationMs, 'number');
      assert.equal(typeof complete?.responseTurnDurationTotalMs, 'number');
    });
  } finally {
    if (previousOpenCodePath === undefined) {
      delete process.env.OPENCODE_PATH;
    } else {
      process.env.OPENCODE_PATH = previousOpenCodePath;
    }
    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('spawnOpenCode emits session_created before normalized live messages for new sessions', async () => {
  const tempRoot = await mkdtemp('/var/tmp/opencode-cli-live-');
  // OC-06: the binary is now resolved via resolveOpenCodeBinaryPath(), which
  // prefers OPENCODE_PATH → ~/.opencode/bin/opencode → PATH. On a host where the
  // real CLI is installed the old PATH-injection would be bypassed, so pin the
  // fake executable through the OPENCODE_PATH override (the intended knob).
  const previousOpenCodePath = process.env.OPENCODE_PATH;
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPathExt = process.env[pathExtKey];
  const messages = [];
  // ADR-152 A1 §3.4: a run needs a signed-in member, recorded on a real schema.
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  const writer = {
    userId: userDb.createUser(`u_oc_new_${Date.now()}`, 'hash', 'user').id,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };
  installManagedClaudePlugins(process.env.HOME, writer.userId);

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env.OPENCODE_PATH = path.join(
      tempRoot,
      process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
    );
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await spawnOpenCode('Hi', { cwd: tempRoot, clientMsgId: 'cmid-oc-1666' }, writer);

    const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
    const assistantDeltaIndex = messages.findIndex((message) =>
      message.kind === 'stream_delta' && message.content === 'assistant response',
    );
    const streamEnd = messages.find((message) => message.kind === 'stream_end');
    const complete = messages.find((message) => message.kind === 'complete');

    assert.notEqual(sessionCreatedIndex, -1);
    assert.notEqual(assistantDeltaIndex, -1);
    assert.ok(sessionCreatedIndex < assistantDeltaIndex);
    assert.equal(messages[sessionCreatedIndex].newSessionId, 'open-live-1');
    // B-1666: a new conversation, never a stale resume of the viewed one.
    assert.equal(messages[sessionCreatedIndex].parentSessionId, null);
    assert.equal(messages[sessionCreatedIndex].clientMsgId, 'cmid-oc-1666');
    assert.equal(writer.sessionId, 'open-live-1');
    assert.equal(streamEnd?.sessionId, 'open-live-1');
    assert.equal(complete?.sessionId, 'open-live-1');
    assert.equal(messages.some((message) => message.kind === 'error'), false);
  } finally {
    if (previousOpenCodePath === undefined) {
      delete process.env.OPENCODE_PATH;
    } else {
      process.env.OPENCODE_PATH = previousOpenCodePath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});
