/**
 * Transcript parser — extracts the non-human actors (the base model and any
 * spawned subagents) from a session transcript, parse-on-demand with an
 * mtime-keyed cache.
 *
 * Design:
 *   - The cache (session_agents_cache + session_agents_meta) is keyed on the
 *     transcript file's mtime. A read first stats the file; if the stored mtime
 *     matches, the cached rows are returned without touching the file.
 *   - On a miss the transcript is streamed line by line (transcripts can be
 *     large) and:
 *       * every distinct model seen on an `assistant` entry → one 'model' agent
 *         each, counted by turns (a session may change model mid-conversation)
 *       * every `tool_use` block named 'Agent' (or 'Task') → a 'subagent' agent
 *         named by its `subagent_type`, counted by occurrence
 *       * subagent models: each Agent tool_use generates a `tool_result` whose
 *         text content embeds `agentId: <hex>`. The hex ID maps to a sidecar
 *         JSONL file `<sessionDir>/subagents/agent-<agentId>.jsonl` whose first
 *         assistant message carries the resolved model string. We read those
 *         files lazily (one per unique subagent_type encountered) and record the
 *         model on the cache row so the UI can show per-agent model badges.
 *   - For antigravity (`agy`) sessions there is no structured model/subagent
 *     metadata in the transcript, so we record a single 'model' agent named
 *     'agy' per the tracking spec.
 *
 * The parser never throws on bad input: unreadable files yield an empty result,
 * malformed lines are skipped.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { sessionAgentsDb } from '../modules/database/index.js';
import { resolveCodexLinkedRollouts } from '../modules/providers/list/codex/codex-rollout-links.js';

import { fingerprintResponseProvider } from './provider-fingerprint.js';

const AGENT_ID_RE = /agentId:\s*([a-f0-9]+)/;
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Cache epoch — bump whenever the SHAPE of the parsed rows changes.
 *
 * The cache is keyed on the transcript's mtime alone, which answers "has the
 * file changed?" but not "does the cached shape still match what this code
 * produces?". B-352 changed a session's rows from one model to all of them; a
 * conversation that had gone quiet would have kept serving its single stale
 * model row forever, because its mtime never moves again. Folding an epoch into
 * the key invalidates every cached row exactly once per shape change.
 *
 * Epoch 1: one 'model' row per distinct model, real turn counts (B-352).
 * Epoch 2: model rows carry agent_provider — the ANSWERING provider's wire
 *   fingerprint (T-1144: msg_/req_ ⇒ anthropic, chatcmpl- ⇒ vendor named via
 *   the model catalog). Rows cached under epoch 1 have no provider and must
 *   be re-parsed.
 * Epoch 3: a model row's count is CONVERSATIONAL TURNS, not assistant entries.
 *   Epochs 1–2 counted every `assistant` entry, and the SDK writes one entry per
 *   tool call — so a two-question conversation reported "×100". The number was
 *   arithmetically true and read as a lie: the user sees two replies. Rows
 *   cached under epochs 1–2 hold the inflated figure and must be re-parsed.
 * Epoch 4: Codex rollouts retain every distinct root model in first-seen order,
 * rather than only the final `payload.model` observed in the file.
 * Epoch 6: Codex rosters recognize `multi_agent_v1` and orchestrated `exec`
 * spawn records that do not emit the legacy `sub_agent_activity` event.
 */
const AGENTS_CACHE_EPOCH = 6;
const EPOCH_STRIDE = 1e15;

/** The mtime-plus-shape cache key. See AGENTS_CACHE_EPOCH. */
function cacheKeyFor(mtime) {
  return mtime + AGENTS_CACHE_EPOCH * EPOCH_STRIDE;
}

/**
 * Minimum wall-clock gap between two full re-parses of the SAME session (ms).
 *
 * The mtime key is correct but far too sharp for a live conversation: every
 * appended line changes it, so a streaming turn invalidated the cache on each
 * token batch and each caller paid a full JSONL re-stream, one sidecar open per
 * subagent, and a cache rewrite — multiplied by every viewer of that session
 * (B-418).
 *
 * A floor is sound here because of WHAT is cached: a roster of models and
 * subagent types. It changes when a new actor first appears, which is a
 * human-scale event; it cannot change faster than the floor in any way a reader
 * would notice. Staleness is bounded by the floor and self-heals on the next
 * call — nothing is dropped, only deferred.
 *
 * Deliberately in-process (not a DB column): it is a rate limit, not state. It
 * must reset on restart, and a restart is exactly when re-reading is cheapest.
 */
const MIN_REPARSE_INTERVAL_MS = 5_000;

/** sessionId → epoch ms of the last completed parse. */
const lastParseAt = new Map();

/**
 * Ceiling on the throttle map. It holds one small entry per session touched
 * since boot, and a long-lived process browsing thousands of sessions would
 * otherwise grow it without bound. Dropping the whole map is safe by design:
 * the only cost of forgetting is one extra parse per session, which is what the
 * code did before this guard existed.
 */
const LAST_PARSE_MAX_ENTRIES = 4_000;

/**
 * True when this session was re-parsed too recently to do it again.
 * A session never seen in this process is never throttled — a cold cache must
 * always be allowed to fill, or a fresh restart would serve empty rosters.
 */
function reparsedTooRecently(sessionId, now = Date.now()) {
  const last = lastParseAt.get(sessionId);
  return last !== undefined && now - last < MIN_REPARSE_INTERVAL_MS;
}

/**
 * Reads the first real assistant `model` value from a subagent JSONL sidecar file.
 * Returns null on any error or if no model is found.
 * @param {string} subagentFilePath
 * @returns {Promise<string|null>}
 */
async function readSubagentModel(subagentFilePath) {
  try {
    const fileStream = fs.createReadStream(subagentFilePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const rawLine of lineReader) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      const msg = entry.message;
      if (!msg || typeof msg !== 'object') continue;
      if (
        msg.role === 'assistant' &&
        typeof msg.model === 'string' &&
        msg.model.length > 0 &&
        msg.model !== SYNTHETIC_MODEL
      ) {
        lineReader.close();
        fileStream.destroy();
        return msg.model;
      }
    }
  } catch {
    // unreadable / missing file
  }
  return null;
}

/**
 * Given a transcriptPath, resolves the sibling `subagents/` directory.
 * Returns null if the transcript lives at the top level (no session UUID dir).
 * @param {string} transcriptPath
 * @returns {string|null}
 */
function resolveSubagentsDir(transcriptPath) {
  // Layout: <projectDir>/<sessionId>.jsonl
  // Subagent files live at: <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl
  const basename = path.basename(transcriptPath, '.jsonl');
  const projectDir = path.dirname(transcriptPath);
  const candidate = path.join(projectDir, basename, 'subagents');
  try {
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) return candidate;
  } catch {
    // no subagents dir for this session — normal for sessions with no agents
  }
  return null;
}

/**
 * Streams a Claude/Codex-style JSONL transcript and tallies model + subagents.
 * Also resolves per-subagent model strings from sidecar JSONL files when available.
 * @param {string} transcriptPath
 * @returns {Promise<Array<{agent_name: string, agent_kind: 'model'|'subagent', invocation_count: number, agent_model: string|null}>>}
 */
export async function parseClaudeStyleTranscript(transcriptPath) {
  /**
   * EVERY model that answered in this transcript → the number of CONVERSATIONAL
   * TURNS it opened, in first-seen order (Map preserves insertion order).
   *
   * B-352: this used to keep only the FIRST assistant model, so a conversation
   * that changed model mid-way (the engine axis is re-stampable per turn — the
   * same session id can hold kimi-k3, then kimi-k2.6, then claude-opus-5 turns)
   * showed a single chip naming a model that had stopped answering hours
   * earlier. The participants bar claims to list the session's actors; listing
   * one of three is not a smaller truth, it is a wrong one.
   *
   * A "turn" is one reply to one human message — the unit the reader counts by
   * eye. It is NOT the assistant-entry count: the SDK writes a separate
   * `assistant` entry per tool call, so this conversation's two exchanges left
   * 100 entries behind and the chip read "×100". Entry counts still rank the
   * models against each other, which is all B-352 needed, so moving to turns
   * keeps that signal and drops a number nobody could reconcile with the page
   * in front of them.
   * @type {Map<string, number>}
   */
  const modelTurns = new Map();
  /** Legacy/minimal transcripts may omit user rows entirely. */
  const assistantEntries = new Map();
  let sawHumanTurn = false;
  /**
   * Every model seen answering, in first-seen order — including one that only
   * ever spoke *mid*-turn (a model switch inside a single reply) and therefore
   * opened zero turns. Such a model still participated, and B-352's whole point
   * is that a participant missing from this row is a wrong answer, not a terse
   * one. Its chip renders with no count.
   * @type {Set<string>}
   */
  const modelsSeen = new Set();
  /**
   * True once a real human message has been read and before the reply to it has
   * been attributed. `false` while the model is mid-turn (tool calls and their
   * results), which is exactly what stops tool traffic from inflating counts.
   */
  let awaitingReply = false;
  /**
   * T-1144: model → the wire fingerprint of the provider that answered with it
   * (first-seen wins). The model id alone can be ambiguous (a vendor serving
   * aliased ids); the response envelope (msg_/req_ vs chatcmpl-) is the
   * evidence the chip's provider label is built from.
   * @type {Map<string, string>}
   */
  const modelProviders = new Map();
  /** @type {Map<string, number>} subagent_type → invocation count */
  const subagentCounts = new Map();
  /**
   * Maps tool_use_id → subagent_type so we can correlate tool_result text back
   * to the spawning call.
   * @type {Map<string, string>}
   */
  const pendingToolUseIds = new Map();
  /**
   * Maps subagent_type → agentId hex string (first occurrence wins; same type
   * may be invoked multiple times with different agentIds but they typically
   * run the same model).
   * @type {Map<string, string>}
   */
  const subagentToAgentId = new Map();

  const fileStream = fs.createReadStream(transcriptPath);
  const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const rawLine of lineReader) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const message = entry.message;
    if (!message || typeof message !== 'object') continue;

    // A human message opens a turn. Tool results arrive as `user` entries too —
    // they are the model talking to itself and must not open one. `isMeta`
    // entries (injected reminders, hooks) are not the user speaking either.
    if (entry.type === 'user' && !entry.isMeta) {
      const userContent = message.content;
      const isToolResultOnly =
        Array.isArray(userContent) &&
        userContent.length > 0 &&
        userContent.every((b) => b && typeof b === 'object' && b.type === 'tool_result');
      if (!isToolResultOnly) {
        sawHumanTurn = true;
        awaitingReply = true;
      }
    }

    // Tally every real assistant model. Skip the synthetic placeholder model the
    // SDK emits for tool-only / interrupted turns.
    if (
      entry.type === 'assistant' &&
      typeof message.model === 'string' &&
      message.model.length > 0 &&
      message.model !== SYNTHETIC_MODEL
    ) {
      modelsSeen.add(message.model);
      assistantEntries.set(message.model, (assistantEntries.get(message.model) || 0) + 1);
      if (awaitingReply) {
        modelTurns.set(message.model, (modelTurns.get(message.model) || 0) + 1);
        awaitingReply = false;
      }
      if (!modelProviders.has(message.model)) {
        modelProviders.set(
          message.model,
          fingerprintResponseProvider({
            messageId: message.id,
            requestId: entry.requestId,
            modelId: message.model,
          }),
        );
      }
    }

    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use') {
        // Subagent spawns surface as the 'Agent' tool (legacy: 'Task').
        if (block.name !== 'Agent' && block.name !== 'Task') continue;

        const subagentType = block.input && typeof block.input === 'object'
          ? block.input.subagent_type
          : null;
        if (typeof subagentType !== 'string' || subagentType.length === 0) continue;

        subagentCounts.set(subagentType, (subagentCounts.get(subagentType) || 0) + 1);

        // Remember the tool_use_id so we can match the result back to the type.
        const toolUseId = block.id;
        if (typeof toolUseId === 'string' && toolUseId.length > 0) {
          pendingToolUseIds.set(toolUseId, subagentType);
        }

      } else if (block.type === 'tool_result') {
        // Match result back to the Agent tool_use call; extract agentId from the
        // embedded text ("agentId: <hex>  (use SendMessage …)").
        const toolUseId = block.tool_use_id;
        if (typeof toolUseId !== 'string') continue;
        const subagentType = pendingToolUseIds.get(toolUseId);
        if (!subagentType) continue;
        if (subagentToAgentId.has(subagentType)) continue; // first occurrence is enough

        let resultText = '';
        const rc = block.content;
        if (typeof rc === 'string') {
          resultText = rc;
        } else if (Array.isArray(rc)) {
          resultText = rc
            .filter((b) => b && typeof b === 'object' && b.type === 'text')
            .map((b) => b.text || '')
            .join(' ');
        }

        const match = AGENT_ID_RE.exec(resultText);
        if (match) {
          subagentToAgentId.set(subagentType, match[1]);
        }
      }
    }
  }

  // Resolve per-subagent models from sidecar JSONL files (best-effort).
  const subagentsDir = resolveSubagentsDir(transcriptPath);
  /** @type {Map<string, string|null>} subagent_type → model */
  const subagentModels = new Map();

  if (subagentsDir) {
    await Promise.all(
      [...subagentToAgentId.entries()].map(async ([subagentType, agentId]) => {
        const subagentFile = path.join(subagentsDir, `agent-${agentId}.jsonl`);
        const resolvedModel = await readSubagentModel(subagentFile);
        subagentModels.set(subagentType, resolvedModel);
      })
    );
  }

  const agents = [];
  // One row per model that actually answered, in first-seen order, carrying its
  // turn count (B-352) — so the UI can both list them all and show which one
  // carried the conversation.
  for (const name of modelsSeen) {
    agents.push({
      agent_name: name,
      agent_kind: 'model',
      invocation_count: sawHumanTurn
        ? (modelTurns.get(name) ?? 0)
        : (assistantEntries.get(name) ?? 0),
      agent_model: name,
      agent_provider: modelProviders.get(name) ?? null,
    });
  }
  for (const [name, count] of subagentCounts) {
    agents.push({
      agent_name: name,
      agent_kind: 'subagent',
      invocation_count: count,
      agent_model: subagentModels.get(name) ?? null,
      agent_provider: null,
    });
  }
  return agents;
}

/** Parses Codex-native rollout actors and explicit parent→child thread links. */
export async function parseCodexRolloutTranscript(transcriptPath) {
  const tree = await resolveCodexLinkedRollouts(transcriptPath);
  const agents = [];
  // The last Codex model is still retained for resumption, but the roster is
  // conversational history and must expose every main-thread model used.
  for (const model of tree.root.models) {
    agents.push({
      agent_name: model,
      agent_kind: 'model',
      invocation_count: 1,
      agent_model: model,
      agent_provider: 'openai',
    });
  }

  const linkedByThread = new Map(
    tree.linked.map((child) => [child.spawn.agentThreadId, child]),
  );
  const workers = new Map();
  // Match Claude's header semantics: show only agents started directly by the
  // coordinator. Recursive descendants still belong in conversation cost.
  for (const spawn of tree.root.spawns) {
    const name = spawn.taskName || path.basename(spawn.agentPath || '') || 'subagent';
    const linked = spawn.agentThreadId ? linkedByThread.get(spawn.agentThreadId) : null;
    const existing = workers.get(name);
    workers.set(name, {
      agent_name: name,
      agent_kind: 'subagent',
      invocation_count: (existing?.invocation_count || 0) + 1,
      agent_model: existing?.agent_model || linked?.model || null,
      agent_provider: linked?.model ? 'openai' : existing?.agent_provider || null,
    });
  }
  agents.push(...workers.values());
  return agents;
}

/** Integer cache fingerprint including every explicitly linked child rollout. */
async function codexRosterCacheKey(transcriptPath) {
  const tree = await resolveCodexLinkedRollouts(transcriptPath);
  const paths = [transcriptPath, ...tree.linked.map((child) => child.rolloutPath)].sort();
  let hash = 1469598103934665603n;
  for (const rolloutPath of paths) {
    let signature = rolloutPath;
    try {
      const info = fs.statSync(rolloutPath);
      signature += `:${Math.floor(info.mtimeMs)}:${info.size}`;
    } catch {
      signature += ':missing';
    }
    for (const char of signature) {
      hash ^= BigInt(char.codePointAt(0));
      hash = BigInt.asUintN(64, hash * 1099511628211n);
    }
  }
  return cacheKeyFor(Number(hash % 999999999999983n));
}

/** آخر نموذج اختاره المستخدم في نصّ agy، مثل «Gemini 3.5 Flash (High)». */
const AGY_MODEL_RE = /Model Selection` from .*? to (.+?)\.(?:\\n)? *No need to comment/g;

/** استدعاء وكيل فرعي في نصّ agy (الأداة الوحيدة للتفويض عنده). */
const AGY_SUBAGENT_RE = /"name"\s*:\s*"invoke_subagent"/g;

/**
 * وكلاء جلسة antigravity من نصّها الفعلي.
 *
 * تصحيح 2026-08-01 (B-393): كانت الدالة تكتب `agy` ثابتاً بحجّة أن نصوص agy
 * «لا تحمل بيانات نموذج» — وهو وصفٌ لم يعد صحيحاً ولم يُراجَع: كل نصّ فحصتُه من
 * الإنتاج (35 دماغاً) يحمل سطر `Model Selection ... to <اسم النموذج>`، فكانت
 * الواجهة تعرض اسم المزوّد مكان النموذج في كل جلسة. ويحمل النصّ كذلك استدعاءات
 * `invoke_subagent` منذ وصل طاقم نسّاج إلى agy (B-392) — فصار للتفويض أثرٌ
 * يُعدّ. الفشل آمن: إن غاب السطر يعود الاسم إلى `agy` كما كان.
 *
 * @param {string|null|undefined} transcriptPath مسار نصّ الجلسة
 * @returns {Array<{agent_name: string, agent_kind: 'model'|'subagent', invocation_count: number, agent_model: string|null, agent_provider: string|null}>}
 */
function parseAgySession(transcriptPath) {
  let text = '';
  if (transcriptPath) {
    try {
      text = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
      text = '';
    }
  }

  let model = null;
  for (const m of text.matchAll(AGY_MODEL_RE)) {
    model = m[1].trim() || model; // الأخير هو المفعول: المستخدم قد يبدّل مراراً
  }

  const agents = [
    {
      agent_name: model || 'agy',
      agent_kind: 'model',
      invocation_count: 1,
      agent_model: model,
      agent_provider: model ? 'antigravity' : null,
    },
  ];

  const dispatches = (text.match(AGY_SUBAGENT_RE) || []).length;
  if (dispatches > 0) {
    // اسم الوكيل المفوَّض إليه غير مسجَّل في نصّ الأب (يعيش في دماغ الابن)، فيُعدّ
    // التفويض إجمالاً بدل اختلاق اسم — الشارة تقول «فُوِّض N مرة» بصدق.
    agents.push({
      agent_name: 'subagent',
      agent_kind: 'subagent',
      invocation_count: dispatches,
      agent_model: null,
      agent_provider: 'antigravity',
    });
  }

  return agents;
}

/**
 * Returns the agents (model + subagents) for a session, using the mtime-keyed
 * cache and re-parsing only when the transcript has changed.
 *
 * @param {string} sessionId
 * @param {string|null|undefined} transcriptPath  Absolute path to the .jsonl transcript.
 * @param {{ provider?: string }} [options]
 * @returns {Promise<Array<{agent_name: string, agent_kind: 'model'|'subagent', invocation_count: number}>>}
 */
export async function getSessionAgents(sessionId, transcriptPath, options = {}) {
  if (!sessionId) {
    return [];
  }

  const provider = (options.provider || '').toLowerCase();

  // antigravity has no on-disk model/subagent structure; record 'agy' once and
  // key the cache on the transcript mtime when available, else on 0.
  if (provider === 'antigravity') {
    let mtime = 0;
    if (transcriptPath) {
      try {
        mtime = Math.floor(fs.statSync(transcriptPath).mtimeMs);
      } catch {
        mtime = 0;
      }
    }
    const key = cacheKeyFor(mtime);
    const cachedMeta = sessionAgentsDb.getMeta(sessionId);
    if (cachedMeta !== null && cachedMeta === key) {
      return sessionAgentsDb.listBySession(sessionId);
    }
    const agents = parseAgySession(transcriptPath);
    sessionAgentsDb.replaceForSession(sessionId, agents, key);
    return agents;
  }

  // Other harnesses do not share Claude's transcript contract. Until a
  // harness-specific parser exists, an empty roster is more truthful than
  // interpreting unrelated JSON as Claude tool_use blocks.
  if (provider && provider !== 'claude' && provider !== 'codex') {
    return [];
  }

  if (!transcriptPath) {
    // Without a transcript file we can still serve a previously parsed cache.
    return sessionAgentsDb.listBySession(sessionId);
  }

  if (provider === 'codex') {
    let key;
    try {
      key = await codexRosterCacheKey(transcriptPath);
    } catch {
      return sessionAgentsDb.listBySession(sessionId);
    }
    const cachedMeta = sessionAgentsDb.getMeta(sessionId);
    if (cachedMeta !== null && cachedMeta === key) {
      return sessionAgentsDb.listBySession(sessionId);
    }
    if (cachedMeta !== null && reparsedTooRecently(sessionId)) {
      return sessionAgentsDb.listBySession(sessionId);
    }
    try {
      const agents = await parseCodexRolloutTranscript(transcriptPath);
      sessionAgentsDb.replaceForSession(sessionId, agents, key);
      if (lastParseAt.size >= LAST_PARSE_MAX_ENTRIES) lastParseAt.clear();
      lastParseAt.set(sessionId, Date.now());
      return agents;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to parse Codex rollout for agents', { sessionId, error: message });
      return sessionAgentsDb.listBySession(sessionId);
    }
  }

  let mtime;
  try {
    mtime = Math.floor(fs.statSync(transcriptPath).mtimeMs);
  } catch {
    // Missing/unreadable transcript: fall back to whatever was cached before.
    return sessionAgentsDb.listBySession(sessionId);
  }

  const key = cacheKeyFor(mtime);
  const cachedMeta = sessionAgentsDb.getMeta(sessionId);
  if (cachedMeta !== null && cachedMeta === key) {
    return sessionAgentsDb.listBySession(sessionId);
  }

  // The transcript DID change — but on a streaming session it changes on every
  // append, and re-reading it whole per append is the cost B-418 names. Serve
  // the previous roster until the floor elapses. Guarded on `cachedMeta`: with
  // nothing cached there is nothing to serve, so a first parse always runs.
  if (cachedMeta !== null && reparsedTooRecently(sessionId)) {
    return sessionAgentsDb.listBySession(sessionId);
  }

  let agents;
  try {
    agents = await parseClaudeStyleTranscript(transcriptPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to parse transcript for agents', { sessionId, error: message });
    return sessionAgentsDb.listBySession(sessionId);
  }

  sessionAgentsDb.replaceForSession(sessionId, agents, key);
  // Stamped AFTER the parse, not before: a slow parse must not shorten the next
  // window, and a parse that threw (returned above) must not start one at all.
  if (lastParseAt.size >= LAST_PARSE_MAX_ENTRIES) lastParseAt.clear();
  lastParseAt.set(sessionId, Date.now());
  return agents;
}
