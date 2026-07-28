/**
 * T-873(2) — FORMAT-PINNING test for the `Agent` orphan reader.
 *
 * THE FIXTURES ARE REAL. Every JSONL line below was lifted verbatim from an
 * `agent-*.jsonl` file on disk under
 * `~/.nassaj-users/1/.claude/projects/-home-dev-workspace-nassaj/`.
 * The ONLY edits are size trims of non-load-bearing payloads, each marked in
 * place with «…trimmed for the fixture»: the multi-KB spawn prompt, a `thinking`
 * block's body and `signature`, and one tool_result body. Every field the
 * classifier reads — `type`, `message.role`, `message.content[].type`,
 * `message.content[].text`, `timestamp`, `agentId`, and the deliberately-ignored
 * `stop_reason` — is byte-identical to disk.
 *
 * This matters because of a documented failure in this codebase: a notification
 * parser shipped with a fully green suite built on invented fixtures and then
 * matched 6.5% of real rows. Synthetic fixtures prove nothing here.
 *
 * The four transcripts pinned:
 *   INCIDENT   `agent-ab0bf67f9ea3d0c25` — the 2026-07-26 incident. Finished its
 *              work at 09:20:12, was killed 63 s later at 09:21:15. Its final
 *              assistant text IS the report that was never delivered, and its
 *              `stop_reason` is **null** — the field that would mis-classify it.
 *   COMPLETED  `agent-af485a27dc52b445a` — a normal completion (`end_turn`).
 *   AMBIGUOUS  `agent-a4b86edd162eeebf7` — ends on a bare `tool_result`: the
 *              "leaves no transcript marker" class. Must be `unknown`.
 *   AMBIGUOUS  `agent-a34e6920efa23792f` — ends on a bare `thinking` assistant
 *              record: cut mid-turn. Must be `unknown`, never `completed`.
 *   MID-MARKER `agent-a7a5d0d829cd93943` — carries `[Request interrupted by
 *              user]` at line 95 of 106 and then finished. Position decides, not
 *              presence (41 such agents exist in the corpus).
 *
 * It locks:
 *  - the three measured constraints (no `stop_reason`, last record only, no
 *    guessed settlement);
 *  - report recovery, including recovery from an INTERRUPTED transcript (the
 *    incident shape: work done, then killed);
 *  - the bounded tail read, including the declined verdict when the window is
 *    too small to hold a record;
 *  - the meta sidecar read (`toolUseId`, the launch-time join key the server has
 *    ignored to date);
 *  - fail-safe behaviour on every anomaly (missing file, empty file, garbage).
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  agentMetaPath,
  agentTranscriptPath,
  classifyLastRecord,
  hasTornTail,
  listSessionAgentIds,
  readAgentMeta,
  readAgentOutcome,
} from '@/modules/providers/list/claude/agent-transcript.reader.js';

// ---------------------------------------------------------------------------
// REAL fixture lines (see the header for the trim policy).
// ---------------------------------------------------------------------------

/** INCIDENT line 1 — the launch record (ADR-051's start signal). */
const INCIDENT_FIRST =
  '{"parentUuid":null,"isSidechain":true,"promptId":"47827991-1991-4897-8e29-2f29a93689a2","agentId":"ab0bf67f9ea3d0c25","type":"user","message":{"role":"user","content":"«prompt trimmed for the fixture»"},"uuid":"6ff134ce-2c1e-426b-ad58-66bba65bf389","timestamp":"2026-07-26T04:11:11.027Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/**
 * INCIDENT line 437 of 448 — the final assistant text: THE LOST REPORT, verbatim.
 * Note `"stop_reason":null` on a genuinely finished turn.
 */
const INCIDENT_FINAL_ASSISTANT =
  '{"parentUuid":"22850cb0-8791-4464-a1da-38b4e7802f61","isSidechain":true,"agentId":"ab0bf67f9ea3d0c25","message":{"model":"claude-opus-5","id":"msg_011CdQRQ6VrKj2cLiJNDG4eN","type":"message","role":"assistant","content":[{"type":"text","text":"Two files from another session appeared — staging mine by name only."}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":343,"cache_read_input_tokens":242854,"output_tokens":2,"service_tier":"standard"},"diagnostics":null},"requestId":"req_011CdQRQ3Wm3Xdc7eD6Rhbwr","attributionAgent":"frontend-dev","type":"assistant","uuid":"2a9b7bdf-ecb5-4a90-8819-34bcf3ae51dd","timestamp":"2026-07-26T09:20:12.134Z","effort":"high","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/** INCIDENT line 448 (last) — the cut marker, 63 s after the report. */
const INCIDENT_LAST =
  '{"parentUuid":"e4b66b46-9f7e-4760-aced-71fa7f8922be","isSidechain":true,"promptId":"0b3986cc-791c-4748-9904-2fa361ea3643","agentId":"ab0bf67f9ea3d0c25","type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"6c911354-674a-4447-8e4d-d0448bee608f","timestamp":"2026-07-26T09:21:15.950Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/** INCIDENT `agent-ab0bf67f9ea3d0c25.meta.json` — verbatim, all 173 bytes. */
const INCIDENT_META =
  '{"agentType":"frontend-dev","description":"إصلاح تشوّه bidi في عرض رسائل RTL","toolUseId":"toolu_01SVHAGH5nqsRk11r8zwa4yT","spawnDepth":1,"model":"opus"}';

/** COMPLETED line 1 of 4. */
const COMPLETED_FIRST =
  '{"parentUuid":null,"isSidechain":true,"promptId":"0970a852-c4c9-44f9-8776-54407a645202","agentId":"af485a27dc52b445a","type":"user","message":{"role":"user","content":"«prompt trimmed for the fixture»"},"uuid":"fa89f92e-18c2-482a-af5f-9f33f0b18bff","timestamp":"2026-07-10T17:51:51.576Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"b89bac0e-1057-4207-84bf-e06587b9d823","version":"2.1.206","gitBranch":"fix/security-remediation-2026-07-09"}';

/** COMPLETED line 4 of 4 — a normal `end_turn` completion. */
const COMPLETED_LAST =
  '{"parentUuid":"cb6d3966-7a6f-42ca-864e-5cee63c61c65","isSidechain":true,"agentId":"af485a27dc52b445a","message":{"model":"claude-opus-4-8","id":"msg_011CctoUrc1rnESYkJvkrCAd","type":"message","role":"assistant","content":[{"type":"text","text":"*Please answer in the same language as the question.*"}],"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":4180,"output_tokens":16},"diagnostics":null},"requestId":"req_011CctoUqEum1ywJwpCUdXhe","attributionAgent":"general-purpose","type":"assistant","uuid":"eb82fc31-1b6a-41aa-bb8e-dabdcfeab5de","timestamp":"2026-07-10T17:51:53.618Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"b89bac0e-1057-4207-84bf-e06587b9d823","version":"2.1.206","gitBranch":"fix/security-remediation-2026-07-09"}';

/** COMPLETED `agent-af485a27dc52b445a.meta.json` — verbatim (carries parentAgentId). */
const COMPLETED_META =
  '{"agentType":"general-purpose","description":"Anthropic ToS third-party client research","toolUseId":"toolu_01QmESQChSWFCpUFzHY1dzuJ","parentAgentId":"a5a05086d3cb0b770","spawnDepth":2}';

/** AMBIGUOUS-A last record — a bare `tool_result` tail (no terminal marker). */
const AMBIGUOUS_TOOL_RESULT_LAST =
  '{"parentUuid":"07bf4c9a-f5b2-4165-b595-44c096a61e30","isSidechain":true,"promptId":"71ca9cee-fbc1-4fb8-9a2a-efab70362fb3","agentId":"a4b86edd162eeebf7","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_012aDEScfE9CbsQvM1vSknU2","type":"tool_result","content":"«tool output trimmed for the fixture»","is_error":false}]},"uuid":"73bef948-f44e-4809-be2d-dadbb00568cb","timestamp":"2026-07-26T10:23:22.943Z","sourceToolAssistantUUID":"07bf4c9a-f5b2-4165-b595-44c096a61e30","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/** AMBIGUOUS-B last record — a bare `thinking` assistant record (cut mid-turn). */
const AMBIGUOUS_THINKING_LAST =
  '{"parentUuid":"9b712e1b-7f37-4d8b-9579-254dc019a5d4","isSidechain":true,"agentId":"a34e6920efa23792f","message":{"model":"claude-opus-5","id":"msg_011CdQWFaaP3AUMqnE9vU7zx","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"«trimmed for the fixture»","signature":"«trimmed for the fixture»"}],"stop_reason":null},"type":"assistant","uuid":"c1f7a0dd-9a12-4b2a-9a6f-6c2b1d0f9a11","timestamp":"2026-07-26T10:17:29.512Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"42034af0-5a53-4b10-8ebf-82b028fc8933","version":"2.1.219","gitBranch":"fix/security-remediation-2026-07-09"}';

/** MID-MARKER — `[Request interrupted by user]` at line 95 of 106, then finished. */
const MID_MARKER =
  '{"parentUuid":"8daae084-46c7-4fe4-855e-b1344196b753","isSidechain":true,"promptId":"b135a0d0-ea84-42de-a742-da6d8b647d7e","agentId":"a7a5d0d829cd93943","type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"0c75da95-60ae-4c47-9af0-7aeba20a0043","timestamp":"2026-07-10T20:59:55.566Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/dev/workspace/nassaj","sessionId":"0278af6f-8a4b-4d5f-b36c-7250d52d5998","version":"2.1.206","gitBranch":"fix/security-remediation-2026-07-09"}';

/** The other interruption wording observed in the wild (9 occurrences). */
const INTERRUPTED_FOR_TOOL_USE = JSON.stringify({
  ...(JSON.parse(INCIDENT_LAST) as Record<string, unknown>),
  message: {
    role: 'user',
    content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
  },
});

async function withSubagentsDir(
  files: Record<string, string>,
  run: (subagentsDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-reader-'));
  const subagentsDir = path.join(root, 'session', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(subagentsDir, name), body, 'utf8');
    }
    await run(subagentsDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const jsonl = (...lines: string[]) => `${lines.join('\n')}\n`;

// ---------------------------------------------------------------------------
// (أ) The incident — the whole point of the feature
// ---------------------------------------------------------------------------

test('incident transcript: interrupted, and its lost report is recovered verbatim', async () => {
  await withSubagentsDir(
    {
      'agent-ab0bf67f9ea3d0c25.jsonl': jsonl(
        INCIDENT_FIRST,
        INCIDENT_FINAL_ASSISTANT,
        INCIDENT_LAST,
      ),
      'agent-ab0bf67f9ea3d0c25.meta.json': INCIDENT_META,
    },
    async (dir) => {
      const outcome = await readAgentOutcome(
        agentTranscriptPath(dir, 'ab0bf67f9ea3d0c25'),
        'ab0bf67f9ea3d0c25',
      );

      assert.equal(outcome.outcome, 'interrupted');
      assert.equal(outcome.unknownReason, null);
      // ADR-051 start signal, from line 1.
      assert.equal(outcome.startedAt, '2026-07-26T04:11:11.027Z');
      assert.equal(outcome.lastActivityAt, '2026-07-26T09:21:15.950Z');
      // THE RECOVERED REPORT — byte-identical to the `<result>` the harness put in
      // the killed notification that was never delivered.
      assert.equal(
        outcome.finalText,
        'Two files from another session appeared — staging mine by name only.',
      );
      assert.equal(outcome.finalTextTruncated, false);
      assert.equal(outcome.interruptionText, '[Request interrupted by user]');

      // The launch-time join key the server has ignored until now.
      const meta = await readAgentMeta(agentMetaPath(dir, 'ab0bf67f9ea3d0c25'));
      assert.equal(meta.toolUseId, 'toolu_01SVHAGH5nqsRk11r8zwa4yT');
      assert.equal(meta.agentType, 'frontend-dev');
      assert.equal(meta.description, 'إصلاح تشوّه bidi في عرض رسائل RTL');
      assert.equal(meta.model, 'opus');
      assert.equal(meta.spawnDepth, 1);
      assert.equal(meta.parentAgentId, null);
    },
  );
});

// ---------------------------------------------------------------------------
// (ب) The three measured constraints
// ---------------------------------------------------------------------------

test('constraint 1: stop_reason is never consulted (null on a real completion)', () => {
  const incidentFinal = JSON.parse(INCIDENT_FINAL_ASSISTANT) as Record<string, unknown>;
  // Guard the premise: if the fixture ever loses this property the test is moot.
  assert.equal((incidentFinal.message as Record<string, unknown>).stop_reason, null);
  assert.deepEqual(classifyLastRecord(incidentFinal), {
    outcome: 'completed',
    unknownReason: null,
  });

  // And the converse: a completion whose stop_reason says 'tool_use' is still
  // judged by its content, not by the field.
  const misleading = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'tool_use',
    },
  };
  assert.equal(classifyLastRecord(misleading).outcome, 'completed');
});

test('constraint 2: an interruption marker mid-transcript does NOT mean interrupted', async () => {
  await withSubagentsDir(
    {
      'agent-a7a5d0d829cd93943.jsonl': jsonl(COMPLETED_FIRST, MID_MARKER, COMPLETED_LAST),
    },
    async (dir) => {
      const outcome = await readAgentOutcome(
        agentTranscriptPath(dir, 'a7a5d0d829cd93943'),
        'a7a5d0d829cd93943',
      );
      assert.equal(outcome.outcome, 'completed');
      assert.equal(outcome.interruptionText, null);
    },
  );
});

test('constraint 3: ambiguous tails are `unknown` with a reason — never completed/settled', async () => {
  await withSubagentsDir(
    {
      'agent-a4b86edd162eeebf7.jsonl': jsonl(COMPLETED_FIRST, AMBIGUOUS_TOOL_RESULT_LAST),
      'agent-a34e6920efa23792f.jsonl': jsonl(COMPLETED_FIRST, AMBIGUOUS_THINKING_LAST),
    },
    async (dir) => {
      const toolResultTail = await readAgentOutcome(
        agentTranscriptPath(dir, 'a4b86edd162eeebf7'),
        'a4b86edd162eeebf7',
      );
      assert.equal(toolResultTail.outcome, 'unknown');
      assert.equal(toolResultTail.unknownReason, 'no-terminal-marker');

      const thinkingTail = await readAgentOutcome(
        agentTranscriptPath(dir, 'a34e6920efa23792f'),
        'a34e6920efa23792f',
      );
      assert.equal(thinkingTail.outcome, 'unknown');
      assert.equal(thinkingTail.unknownReason, 'in-flight-turn');

      // The word 'settled' must not be reachable from this module at all.
      for (const outcome of [toolResultTail.outcome, thinkingTail.outcome]) {
        assert.notEqual(outcome, 'completed');
        assert.notEqual(outcome as string, 'settled');
      }
    },
  );
});

test('both real interruption wordings are recognized', () => {
  assert.equal(
    classifyLastRecord(JSON.parse(INCIDENT_LAST) as Record<string, unknown>).outcome,
    'interrupted',
  );
  assert.equal(
    classifyLastRecord(JSON.parse(INTERRUPTED_FOR_TOOL_USE) as Record<string, unknown>).outcome,
    'interrupted',
  );
});

// ---------------------------------------------------------------------------
// (ج) Normal completion + listing + meta
// ---------------------------------------------------------------------------

test('a normal completion is reported completed with its report text', async () => {
  await withSubagentsDir(
    {
      'agent-af485a27dc52b445a.jsonl': jsonl(COMPLETED_FIRST, COMPLETED_LAST),
      'agent-af485a27dc52b445a.meta.json': COMPLETED_META,
    },
    async (dir) => {
      const outcome = await readAgentOutcome(
        agentTranscriptPath(dir, 'af485a27dc52b445a'),
        'af485a27dc52b445a',
      );
      assert.equal(outcome.outcome, 'completed');
      assert.equal(outcome.unknownReason, null);
      assert.equal(outcome.startedAt, '2026-07-10T17:51:51.576Z');
      assert.equal(outcome.finalText, '*Please answer in the same language as the question.*');

      const meta = await readAgentMeta(agentMetaPath(dir, 'af485a27dc52b445a'));
      assert.equal(meta.parentAgentId, 'a5a05086d3cb0b770');
      assert.equal(meta.spawnDepth, 2);
      assert.equal(meta.model, null); // absent in this real sidecar shape
    },
  );
});

test('listSessionAgentIds returns flat agent ids only and never descends into workflows/', async () => {
  await withSubagentsDir(
    {
      'agent-ab0bf67f9ea3d0c25.jsonl': jsonl(INCIDENT_LAST),
      'agent-af485a27dc52b445a.jsonl': jsonl(COMPLETED_LAST),
      'agent-ab0bf67f9ea3d0c25.meta.json': INCIDENT_META,
      'not-an-agent.jsonl': '{}',
    },
    async (dir) => {
      // A workflow subtree next door: its subagents must stay invisible here
      // (T-825 keeps the two readers on disjoint trees).
      const wfDir = path.join(dir, 'workflows', 'wf_5e55ac63-ce7');
      await mkdir(wfDir, { recursive: true });
      await writeFile(path.join(wfDir, 'agent-deadbeef.jsonl'), jsonl(COMPLETED_LAST), 'utf8');

      const ids = (await listSessionAgentIds(dir)).sort();
      assert.deepEqual(ids, ['ab0bf67f9ea3d0c25', 'af485a27dc52b445a']);
    },
  );
});

// ---------------------------------------------------------------------------
// (د) Bounded tail read
// ---------------------------------------------------------------------------

test('the tail window still classifies correctly when it cannot reach the report', async () => {
  await withSubagentsDir(
    {
      'agent-ab0bf67f9ea3d0c25.jsonl': jsonl(
        INCIDENT_FIRST,
        INCIDENT_FINAL_ASSISTANT,
        INCIDENT_LAST,
      ),
    },
    async (dir) => {
      // A window big enough for the last record but not for the assistant report.
      const outcome = await readAgentOutcome(
        agentTranscriptPath(dir, 'ab0bf67f9ea3d0c25'),
        'ab0bf67f9ea3d0c25',
        { tailBytes: INCIDENT_LAST.length + 8 },
      );
      // The verdict depends on the LAST record only, so it stays correct...
      assert.equal(outcome.outcome, 'interrupted');
      // ...but the report is honestly reported as absent, not invented.
      assert.equal(outcome.finalText, null);
    },
  );
});

test('a window too small for any complete record declines the verdict', async () => {
  await withSubagentsDir(
    {
      'agent-ab0bf67f9ea3d0c25.jsonl': jsonl(INCIDENT_FIRST, INCIDENT_LAST),
    },
    async (dir) => {
      const outcome = await readAgentOutcome(
        agentTranscriptPath(dir, 'ab0bf67f9ea3d0c25'),
        'ab0bf67f9ea3d0c25',
        { tailBytes: 32 },
      );
      assert.equal(outcome.outcome, 'unknown');
      assert.equal(outcome.unknownReason, 'window-truncated');
    },
  );
});

// ---------------------------------------------------------------------------
// (د-2) The two FALSE-COMPLETION holes — closed before they can open
// ---------------------------------------------------------------------------

/**
 * A MIXED last record: assistant text AND a `tool_use`, i.e. the model narrated,
 * called a tool, and the transcript ends before the result returned.
 *
 * Composed, not lifted — deliberately, and this is the honest note about it:
 * today's harness splits narration and tool calls into two separate records, so
 * this shape is 0/614 on the live corpus (measured). Both halves ARE verbatim:
 * the record is `INCIDENT_FINAL_ASSISTANT` with a real `tool_use` block (from
 * `agent-*.jsonl` on disk) appended to its content array. It is pinned here
 * because the failure mode of getting it wrong is SILENT and one-directional —
 * a format change would start minting false `completed` verdicts with a green
 * suite, which is exactly what this module's header forbids.
 */
const MIXED_TEXT_AND_TOOL_USE = (() => {
  const record = JSON.parse(INCIDENT_FINAL_ASSISTANT) as Record<string, unknown>;
  const message = record.message as { content: unknown[] };
  message.content = [
    ...message.content,
    JSON.parse(
      '{"type":"tool_use","id":"toolu_011td9dVrdr5NyLXbkaFzANj","name":"ToolSearch","input":{"query":"select:WebSearch,WebFetch","max_results":2},"caller":{"type":"direct"}}',
    ) as unknown,
  ];
  return JSON.stringify(record);
})();

test('an assistant record holding BOTH text and a tool_use is in-flight, not completed', async () => {
  // Pure classifier first: the unclosed turn must win over the presence of text.
  const verdict = classifyLastRecord(JSON.parse(MIXED_TEXT_AND_TOOL_USE) as Record<string, unknown>);
  assert.deepEqual(verdict, { outcome: 'unknown', unknownReason: 'in-flight-turn' });

  await withSubagentsDir(
    { 'agent-mixedtail.jsonl': jsonl(INCIDENT_FIRST, MIXED_TEXT_AND_TOOL_USE) },
    async (dir) => {
      const outcome = await readAgentOutcome(agentTranscriptPath(dir, 'mixedtail'), 'mixedtail');
      assert.equal(outcome.outcome, 'unknown', 'the tool never returned ⇒ the turn never closed');
      assert.equal(outcome.unknownReason, 'in-flight-turn');
      assert.notEqual(outcome.outcome, 'completed');
      // Declining the VERDICT never means withholding the TEXT: the narration is
      // still recovered, it is just not treated as a finished report.
      assert.equal(
        outcome.finalText,
        'Two files from another session appeared — staging mine by name only.',
      );
    },
  );
});

test('a transcript cut mid-record is `torn-tail`, never the verdict of the record before the tear', async () => {
  // The exact shape of a file killed while the harness was writing a line: a
  // complete final assistant TEXT record, then a half-written one. Before this
  // was closed, parseRecords skipped the torn line and the classifier read the
  // completed record ⇒ a false `completed` for a file still being written.
  const tornLine = INCIDENT_LAST.slice(0, 120);
  await withSubagentsDir(
    {
      'agent-torn.jsonl': `${INCIDENT_FIRST}\n${INCIDENT_FINAL_ASSISTANT}\n${tornLine}`,
      // Control: the SAME two records, intact. Must still be `completed`, which
      // is what proves the torn verdict comes from the tear and nothing else.
      'agent-intact.jsonl': jsonl(INCIDENT_FIRST, INCIDENT_FINAL_ASSISTANT),
    },
    async (dir) => {
      const torn = await readAgentOutcome(agentTranscriptPath(dir, 'torn'), 'torn');
      assert.equal(torn.outcome, 'unknown');
      assert.equal(torn.unknownReason, 'torn-tail');
      assert.notEqual(torn.outcome, 'completed');
      // Again: verdict declined, report still recovered.
      assert.equal(
        torn.finalText,
        'Two files from another session appeared — staging mine by name only.',
      );

      const intact = await readAgentOutcome(agentTranscriptPath(dir, 'intact'), 'intact');
      assert.equal(intact.outcome, 'completed', 'the control must NOT be dragged into unknown');
      assert.equal(intact.unknownReason, null);
    },
  );
});

test('healthy transcripts are never mistaken for torn: 614/614 real files end on a newline', () => {
  // Pins the measurement the torn signal rests on. A trailing fragment that
  // PARSES (no trailing newline, complete record) is healthy; only unparseable
  // trailing bytes are a tear.
  assert.equal(hasTornTail(jsonl(INCIDENT_FIRST, INCIDENT_LAST)), false);
  assert.equal(hasTornTail(`${INCIDENT_FIRST}\n${INCIDENT_LAST}`), false, 'complete final line');
  assert.equal(hasTornTail(''), false);
  assert.equal(hasTornTail('\n'), false);
  assert.equal(hasTornTail(`${INCIDENT_FIRST}\n${INCIDENT_LAST.slice(0, 90)}`), true);
});

// ---------------------------------------------------------------------------
// (هـ) Fail-safe — every anomaly degrades, nothing throws
// ---------------------------------------------------------------------------

test('missing / empty / malformed inputs degrade to unknown and never throw', async () => {
  await withSubagentsDir(
    {
      'agent-empty.jsonl': '',
      'agent-garbage.jsonl': 'not json at all\n{{{\n',
      'agent-badmeta.meta.json': '{ this is not json',
    },
    async (dir) => {
      const missing = await readAgentOutcome(agentTranscriptPath(dir, 'nope'), 'nope');
      assert.equal(missing.outcome, 'unknown');
      assert.equal(missing.unknownReason, 'unreadable');

      const empty = await readAgentOutcome(agentTranscriptPath(dir, 'empty'), 'empty');
      assert.equal(empty.outcome, 'unknown');
      assert.equal(empty.unknownReason, 'unreadable');

      const garbage = await readAgentOutcome(agentTranscriptPath(dir, 'garbage'), 'garbage');
      assert.equal(garbage.outcome, 'unknown');
      assert.equal(garbage.unknownReason, 'window-truncated');
      assert.equal(garbage.finalText, null);

      assert.deepEqual(await readAgentMeta(agentMetaPath(dir, 'badmeta')), {
        agentType: null,
        description: null,
        toolUseId: null,
        spawnDepth: null,
        model: null,
        parentAgentId: null,
      });
      assert.equal((await readAgentMeta(agentMetaPath(dir, 'absent'))).toolUseId, null);
    },
  );

  assert.deepEqual(await listSessionAgentIds('/definitely/not/a/path'), []);
  assert.deepEqual(classifyLastRecord(null), {
    outcome: 'unknown',
    unknownReason: 'window-truncated',
  });
});
