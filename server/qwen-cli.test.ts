import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQwenProcessSpec,
  parseQwenEvent,
  resolveQwenApprovalMode,
  resolveQwenRuntime,
} from './qwen-cli.js';

test('builds a bounded stream-json launch and keeps the Coding Plan key out of argv', () => {
  const key = 'sk-sp-private-test-key';
  const { args, env } = buildQwenProcessSpec({
    command: 'Review this repository',
    options: { permissionMode: 'auto_edit' },
    isNewSession: true,
    sessionId: '00000001-0000-4000-8000-000000000001',
    model: 'qwen3-coder-plus',
    credential: { version: 1, plan: 'coding_plan', region: 'international', key },
    baseEnv: {
      HOME: '/isolated/member',
      OPENAI_API_KEY: 'SYNTHETIC_ONLY_OPENAI_KEY',
      DASHSCOPE_API_KEY: 'operator-dashscope-key',
      BAILIAN_TOKEN_PLAN_API_KEY: 'operator-token-plan-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'operator-subscription-token',
      NASSAJ_SESSION_SECRET: 'host-secret',
    },
  });

  assert.equal(args.includes('--output-format'), true);
  assert.equal(args.includes('stream-json'), true);
  assert.equal(args.includes('--include-partial-messages'), true);
  assert.match(args[args.indexOf('--exclude-tools') + 1], /cron_create/);
  assert.match(args[args.indexOf('--disabled-slash-commands') + 1], /goal/);
  assert.deepEqual(args.slice(args.indexOf('--approval-mode'), args.indexOf('--approval-mode') + 2), [
    '--approval-mode', 'auto-edit',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2), [
    '--session-id', '00000001-0000-4000-8000-000000000001',
  ]);
  assert.doesNotMatch(JSON.stringify(args), /sk-sp-private-test-key|operator-openai-key|operator-dashscope-key/);
  assert.equal(env.BAILIAN_CODING_PLAN_API_KEY, key);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DASHSCOPE_API_KEY, undefined);
  assert.equal(env.BAILIAN_TOKEN_PLAN_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.NASSAJ_SESSION_SECRET, undefined);
  assert.equal(env.OPENAI_BASE_URL, 'https://coding-intl.dashscope.aliyuncs.com/v1');
});

test('maps only supported permission modes and resumes by the authoritative session id', () => {
  assert.equal(resolveQwenApprovalMode({ permissionMode: 'plan' }), 'plan');
  assert.equal(resolveQwenApprovalMode({ permissionMode: 'yolo' }), 'yolo');
  assert.equal(resolveQwenApprovalMode({ permissionMode: 'unknown' }), 'auto');

  const spec = buildQwenProcessSpec({
    command: 'continue',
    options: {},
    isNewSession: false,
    sessionId: '00000002-0000-4000-8000-000000000002',
    model: '',
    credential: {
      version: 1, plan: 'coding_plan', region: 'international', key: 'sk-sp-resume-key',
    },
    baseEnv: {},
  });
  assert.deepEqual(spec.args.slice(spec.args.indexOf('--resume'), spec.args.indexOf('--resume') + 2), [
    '--resume', '00000002-0000-4000-8000-000000000002',
  ]);
  assert.equal(spec.args.includes('--session-id'), false);
});

test('maps each plan and region to the fixed Qwen runtime contract', () => {
  assert.deepEqual(resolveQwenRuntime('coding_plan', 'china'), {
    envKey: 'BAILIAN_CODING_PLAN_API_KEY', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
  });
  assert.deepEqual(resolveQwenRuntime('coding_plan', 'international'), {
    envKey: 'BAILIAN_CODING_PLAN_API_KEY', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  });
  assert.deepEqual(resolveQwenRuntime('token_plan', 'china'), {
    envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  });
  assert.deepEqual(resolveQwenRuntime('token_plan', 'international'), {
    envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  });
});

test('injects exactly one actor credential for all plan and region combinations', () => {
  const cases = [
    ['coding_plan', 'china', 'BAILIAN_CODING_PLAN_API_KEY', 'https://coding.dashscope.aliyuncs.com/v1'],
    ['coding_plan', 'international', 'BAILIAN_CODING_PLAN_API_KEY', 'https://coding-intl.dashscope.aliyuncs.com/v1'],
    ['token_plan', 'china', 'BAILIAN_TOKEN_PLAN_API_KEY', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'],
    ['token_plan', 'international', 'BAILIAN_TOKEN_PLAN_API_KEY', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'],
  ];

  for (const [plan, region, envKey, baseUrl] of cases) {
    const key = `${plan}-${region}-private-key`;
    const { args, env } = buildQwenProcessSpec({
      command: 'Review', options: {}, isNewSession: true,
      sessionId: '00000003-0000-4000-8000-000000000003', model: 'qwen3.7-plus',
      credential: { version: 1, plan, region, key },
      baseEnv: {
        BAILIAN_CODING_PLAN_API_KEY: 'SYNTHETIC_ONLY_CODING_KEY',
        BAILIAN_TOKEN_PLAN_API_KEY: 'SYNTHETIC_ONLY_TOKEN_KEY',
        DASHSCOPE_API_KEY: 'SYNTHETIC_ONLY_STANDARD_KEY',
        OPENAI_API_KEY: 'SYNTHETIC_ONLY_OPENAI_KEY',
        OPENAI_BASE_URL: 'https://attacker.example/v1',
      },
    });
    assert.equal(env[envKey], key);
    const codingEnvKey = ['BAILIAN', 'CODING', 'PLAN', 'API', 'KEY'].join('_');
    const tokenEnvKey = ['BAILIAN', 'TOKEN', 'PLAN', 'API', 'KEY'].join('_');
    const otherEnvKey = envKey === codingEnvKey ? tokenEnvKey : codingEnvKey;
    assert.equal(env[otherEnvKey], undefined);
    assert.equal(env.DASHSCOPE_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENAI_BASE_URL, baseUrl);
    assert.doesNotMatch(JSON.stringify(args), /private-key|operator-/);
  }
});

test('normalizes partial text and tool events without replaying the full assistant text', () => {
  const sent: Array<Record<string, unknown>> = [];
  const ws = { userId: 7, send: (payload: unknown) => sent.push(payload as Record<string, unknown>) };
  const state = {
    assistantText: '', assistantFallback: '', resultSeen: false,
    resultError: false, error: '', stderr: '', buffer: '', finalized: false,
  };

  parseQwenEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'مرحبا' } },
  }, state, ws, 'session-1');
  parseQwenEvent({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'مرحبا' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
    ] },
  }, state, ws, 'session-1');
  parseQwenEvent({ type: 'result', subtype: 'success', is_error: false, result: 'مرحبا' }, state, ws, 'session-1');

  assert.equal(state.assistantText, 'مرحبا');
  assert.equal(state.assistantFallback, '');
  assert.deepEqual(sent.map((payload) => payload.kind), ['stream_delta', 'tool_use']);
  assert.equal(state.resultSeen, true);
  assert.equal(state.resultError, false);
});

test('classifies an upstream API failure the CLI reports as a success', () => {
  // Measured 2026-09-07 against qwen-code 0.23.0 with an invalid key: the CLI
  // exits 0 with subtype "success", is_error false and num_turns 1, and puts the
  // failure only in the result text under its own API_ERROR_PREFIX. Taken at
  // face value the turn is recorded as completed with the error as the answer.
  const sent: Array<Record<string, unknown>> = [];
  const ws = { userId: 7, send: (payload: unknown) => sent.push(payload as Record<string, unknown>) };
  const state = {
    assistantText: '', assistantFallback: '', resultSeen: false,
    resultError: false, error: '', stderr: '', buffer: '', finalized: false,
  };

  parseQwenEvent({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: '[API Error: 401 Invalid API-key provided. For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#apikey-error]',
    usage: { input_tokens: 0, output_tokens: 0 },
  }, state, ws, 'session-1');

  assert.equal(state.resultError, true);
  assert.match(state.error, /^\[API Error: 401 Invalid API-key provided/);
  assert.equal(state.assistantFallback, state.error, 'the failure is what the member is shown');
});

test('keeps the reason from a result whose error is an object, not a string', () => {
  // The launch refusal arrives as error: { message } — reading only the string
  // form discarded it and left the member with a bare "exited with code 1".
  const sent: Array<Record<string, unknown>> = [];
  const ws = { userId: 7, send: (payload: unknown) => sent.push(payload as Record<string, unknown>) };
  const state = {
    assistantText: '', assistantFallback: '', resultSeen: false,
    resultError: false, error: '', stderr: '', buffer: '', finalized: false,
  };

  parseQwenEvent({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    error: { message: 'No auth type is selected. Please configure an auth type before running in non-interactive mode.' },
  }, state, ws, 'session-1');

  assert.equal(state.resultError, true);
  assert.match(state.error, /^No auth type is selected\./);
  assert.equal(state.error.includes('Qwen Code reported a failed result.'), false);
});

test('a real answer is still a success', () => {
  const sent: Array<Record<string, unknown>> = [];
  const ws = { userId: 7, send: (payload: unknown) => sent.push(payload as Record<string, unknown>) };
  const state = {
    assistantText: '', assistantFallback: '', resultSeen: false,
    resultError: false, error: '', stderr: '', buffer: '', finalized: false,
  };

  parseQwenEvent({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '[مهم] الجواب يبدأ بقوس مربع ولا يزال نجاحاً',
  }, state, ws, 'session-1');

  assert.equal(state.resultError, false);
  assert.equal(state.error, '');
});
