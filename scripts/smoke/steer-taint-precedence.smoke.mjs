/**
 * steer-taint-precedence.smoke.mjs — T-1903 (qa M3) real-CLI guard.
 *
 * The steer taint gate (server/modules/session-steer/steer-taint.ts) relies on
 * an INTERNAL CLI behaviour: a PreToolUse hook `deny` stops the tool even in
 * bypassPermissions, and it wins over an `allow` returned by ANOTHER PreToolUse
 * hook registered earlier in the array. Unit tests mock the SDK and cannot prove
 * that. This drives the REAL bundled CLI (cheap model, temp config dir and temp
 * cwd under /var/tmp, all removed afterwards) and asserts:
 *   1. the model's Bash call reaches the taint hook and is denied;
 *   2. the marker file the Bash call would create does not exist;
 * It also records `total_cost_usd` of two `result`s in ONE streaming run, so the
 * runner knows whether the CLI reports it cumulatively.
 *
 * Outside `npm test` on purpose (consumes subscription quota). Run on every CLI
 * bump: `npm run test:smoke:steer-taint`. Exit 0 pass, 1 FAIL, 2 cannot run.
 *
 * Last verified 2026-09-28, SDK 0.3.152, haiku: PASS (earlier allow hook ran, taint
 * hook denied Bash, no marker). Costs r1=0.0351 (2 turns, cache write) then
 * r2=0.0377 (1 cached turn): r2 = r1 + that turn, i.e. total_cost_usd is cumulative.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeCodeExecutablePath } from '../../server/shared/claude-cli-path.js';
import { createSteerTaintHook, STEER_TAINT_MATCHER, steerHookTimeoutSeconds } from '../../server/modules/session-steer/steer-taint.js';

const RUN_TIMEOUT_MS = 150_000;
const log = (...args) => console.log('[steer-smoke]', ...args);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function main() {
  const sourceCreds = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  if (!fs.existsSync(sourceCreds)) {
    log('FATAL: no .credentials.json — cannot authenticate the real CLI. Skipping is NOT a pass.');
    process.exit(2);
  }
  const tmpBase = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const configDir = fs.mkdtempSync(path.join(tmpBase, 'steer-smoke-cfg-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'steer-smoke-proj-')));
  const marker = path.join(project, 'steer-marker.txt');
  fs.copyFileSync(sourceCreds, path.join(configDir, '.credentials.json'));
  fs.chmodSync(path.join(configDir, '.credentials.json'), 0o600);
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{}\n');

  // The SDK writes its own debug log under the PARENT's config dir: point it here too.
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const hookCalls = [];
  const taintHook = createSteerTaintHook({ isTainted: () => true, askStarter: async () => 'deny' });
  const firstResult = deferred();
  const secondResult = deferred();
  async function* prompt() {
    yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user',
      content: `Use the Bash tool to run exactly this command: touch ${marker}\nThen reply with one word: DONE.` } };
    await firstResult.promise;
    yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user',
      content: 'Reply with the single word: ok' } };
    await secondResult.promise;
  }

  let exitCode = 1;
  const results = [];
  const toolErrors = [];
  const run = query({
    prompt: prompt(),
    options: {
      cwd: project, env, model: 'haiku', maxTurns: 4,
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      hooks: {
        PreToolUse: [
          { matcher: '.*', hooks: [async (input) => {
            hookCalls.push(`allow-hook:${input.tool_name}`);
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
              permissionDecisionReason: 'earlier hook allows' } };
          }] },
          { matcher: STEER_TAINT_MATCHER, timeout: steerHookTimeoutSeconds(120_000), hooks: [async (input, id, ctx) => {
            const out = await taintHook(input, id, ctx);
            hookCalls.push(`taint-hook:${input.tool_name}:${out?.hookSpecificOutput?.permissionDecision ?? 'none'}`);
            return out;
          }] },
        ],
      },
    },
  });
  const timer = setTimeout(() => { run.interrupt?.().catch(() => {}); }, RUN_TIMEOUT_MS);
  try {
    for await (const m of run) {
      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const block of m.message.content) {
          if (block?.type === 'tool_result' && block.is_error) toolErrors.push(JSON.stringify(block.content).slice(0, 200));
        }
      }
      if (m.type === 'result') {
        results.push({ cost: m.total_cost_usd, usage: m.usage, modelUsage: m.modelUsage, num_turns: m.num_turns });
        if (results.length === 1) firstResult.resolve(); else { secondResult.resolve(); break; }
      }
    }
  } finally {
    clearTimeout(timer);
    firstResult.resolve(); secondResult.resolve();
    await run.interrupt?.().catch(() => {});
  }

  const created = fs.existsSync(marker);
  const denied = hookCalls.some(c => c.startsWith('taint-hook:Bash:deny'));
  log('hook calls:', JSON.stringify(hookCalls));
  log('tool errors:', JSON.stringify(toolErrors));
  log('marker created:', created);
  log('results:', JSON.stringify(results.map(r => ({ cost: r.cost, turns: r.num_turns,
    in: r.usage?.input_tokens, out: r.usage?.output_tokens }))));
  if (results.length === 2) {
    const [a, b] = results.map(r => r.cost);
    log(`cost verdict: r1=${a} r2=${b} → ${b >= a ? 'r2 ≥ r1 (consistent with cumulative)' : 'r2 < r1 (per-invocation, NOT cumulative)'}`);
  }
  if (!hookCalls.some(c => c.startsWith('taint-hook:Bash'))) {
    log('INCONCLUSIVE: the model never called Bash, the gate was not exercised.');
    exitCode = 2;
  } else if (denied && !created) {
    log('PASS: taint deny won over an earlier allow hook under bypassPermissions.');
    exitCode = 0;
  } else {
    log('FAIL: the Bash call ran despite the taint deny — the gate is breached on this CLI.');
  }
  // The CLI may still flush its session files right after interrupt().
  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  process.exit(exitCode);
}

main().catch((error) => { log('ERROR', error?.message || error); process.exit(2); });
