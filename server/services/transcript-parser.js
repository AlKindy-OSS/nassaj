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
 *       * the model of the first `assistant` entry → one 'model' agent
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

const AGENT_ID_RE = /agentId:\s*([a-f0-9]+)/;

import { sessionAgentsDb } from '../modules/database/index.js';

const SYNTHETIC_MODEL = '<synthetic>';

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
async function parseClaudeStyleTranscript(transcriptPath) {
  let model = null;
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

    // First real assistant model wins. Skip the synthetic placeholder model the
    // SDK emits for tool-only / interrupted turns.
    if (
      model === null &&
      entry.type === 'assistant' &&
      typeof message.model === 'string' &&
      message.model.length > 0 &&
      message.model !== SYNTHETIC_MODEL
    ) {
      model = message.model;
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
  if (model) {
    agents.push({ agent_name: model, agent_kind: 'model', invocation_count: 1, agent_model: model });
  }
  for (const [name, count] of subagentCounts) {
    agents.push({
      agent_name: name,
      agent_kind: 'subagent',
      invocation_count: count,
      agent_model: subagentModels.get(name) ?? null,
    });
  }
  return agents;
}

/**
 * Resolves the agents for an antigravity session. agy transcripts carry no
 * model/subagent metadata, so the actor set is the single base model 'agy'.
 * @returns {Array<{agent_name: string, agent_kind: 'model', invocation_count: number, agent_model: null}>}
 */
function parseAgySession() {
  return [{ agent_name: 'agy', agent_kind: 'model', invocation_count: 1, agent_model: null }];
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
    const cachedMeta = sessionAgentsDb.getMeta(sessionId);
    if (cachedMeta !== null && cachedMeta === mtime) {
      return sessionAgentsDb.listBySession(sessionId);
    }
    const agents = parseAgySession();
    sessionAgentsDb.replaceForSession(sessionId, agents, mtime);
    return agents;
  }

  if (!transcriptPath) {
    // Without a transcript file we can still serve a previously parsed cache.
    return sessionAgentsDb.listBySession(sessionId);
  }

  let mtime;
  try {
    mtime = Math.floor(fs.statSync(transcriptPath).mtimeMs);
  } catch {
    // Missing/unreadable transcript: fall back to whatever was cached before.
    return sessionAgentsDb.listBySession(sessionId);
  }

  const cachedMeta = sessionAgentsDb.getMeta(sessionId);
  if (cachedMeta !== null && cachedMeta === mtime) {
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

  sessionAgentsDb.replaceForSession(sessionId, agents, mtime);
  return agents;
}
