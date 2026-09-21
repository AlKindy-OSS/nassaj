import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { mock } from 'node:test';

let queryCalls = 0;
let queryArgs: Array<Record<string, unknown>> = [];
let profileFailure: (Error & { code?: string }) | null = null;
let profileInput: Record<string, unknown> | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: Record<string, unknown>) => {
      queryCalls += 1;
      queryArgs.push(arg);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', is_error: false, session_id: 'result-session', result: 'ok' };
        },
        interrupt: async () => undefined,
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

mock.module('./services/isolation/resolve-claude-run-profile.js', {
  namedExports: {
    resolveClaudeRunProfileOrThrow: async (input: Record<string, unknown>) => {
      profileInput = input;
      if (profileFailure) throw profileFailure;
      return {
        env: { ...((input.baseEnv as NodeJS.ProcessEnv | undefined) ?? {}) },
        effectiveEngine: null,
        engineHosts: null,
        pin: { storedEngine: input.sessionId ? 'claude' : null },
      };
    },
  },
});

const sdk = await import('./claude-sdk.js') as unknown as {
  queryClaudeSDK: (prompt: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};

function writer() {
  const sent: Record<string, unknown>[] = [];
  return { sent, userId: null, ws: { readyState: 1 }, send: (payload: Record<string, unknown>) => sent.push(payload) };
}

test('SDK resume profile refuses unknown/ambiguous/read failure before Agent SDK query', async () => {
  const configDir = fs.mkdtempSync('/var/tmp/b456-sdk-resume-');
  const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    for (const code of ['ENGINE_PIN_UNKNOWN', 'ENGINE_PIN_AMBIGUOUS', 'ENGINE_PIN_READ_FAILED']) {
      queryCalls = 0;
      queryArgs = [];
      profileInput = null;
      profileFailure = Object.assign(new Error(code), { code });
      await sdk.queryClaudeSDK('resume safely', { sessionId: 'resume-target', cwd: process.cwd() }, writer());
      const resumeQueries = queryArgs.filter((arg) =>
        (arg.options as Record<string, unknown> | undefined)?.resume === 'resume-target');
      assert.equal(resumeQueries.length, 0, `${code}: resume SDK query must not be constructed`);
      assert.equal(profileInput?.requireKnownResumePin, true);
      assert.equal(profileInput?.failOnAmbiguous, true);
      assert.equal(
        profileInput?.authoritativeStoredPin,
        undefined,
        'browser/main resume keeps the explicit enforcement opt-out meaningful',
      );
    }
  } finally {
    profileFailure = null;
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('SDK new-session launch does not require a resume pin', async () => {
  const configDir = fs.mkdtempSync('/var/tmp/b456-sdk-new-');
  const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    queryCalls = 0;
    queryArgs = [];
    profileInput = null;
    profileFailure = null;
    await sdk.queryClaudeSDK('start new', { cwd: process.cwd() }, writer());
    assert.equal(profileInput?.sessionId, null);
    assert.equal(profileInput?.requireKnownResumePin, false);
    assert.equal(profileInput?.failOnAmbiguous, false);
    assert.equal(queryCalls, 1);
  } finally {
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
