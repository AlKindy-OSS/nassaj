/**
 * kimi-agent-response-handler — parses the Kimi native agent CLI
 * (`@moonshot-ai/kimi-code`, KG-1) headless `--output-format stream-json`
 * output (NDJSON, one JSON object per line) into nassaj's unified
 * NormalizedMessage envelope, and drives the per-session callbacks the launcher
 * (KM-1, kimi-agent-cli.js) uses to track session id / transcript.
 *
 * WHY A DEDICATED HANDLER (not the chat-path vendor-runtime): the toolless chat
 * path (`server/kimi-cli.js` → vendor-runtime) speaks the hosted `/v1` HTTP wire
 * and never emits tool_use / session events. The native agent CLI streams an
 * agentic NDJSON transcript (session init, assistant text deltas, tool calls +
 * results, usage, terminal result) — a different shape that needs its own
 * line-buffered parser, modeled on GeminiResponseHandler.
 *
 * SCHEMA ASSUMPTION (flagged for G-KIMI-LIVE, §4.5): kimi is NOT installed on
 * this node, so the exact stream-json field names are taken from the KG-1
 * research gate and the gemini/claude stream-json precedent. The normalizer is
 * therefore DEFENSIVE — it recognizes several plausible field spellings for each
 * event and silently ignores anything it cannot classify (never throws on a line
 * it does not understand, exactly like GeminiResponseHandler). When the live CLI
 * output is captured at G-KIMI-LIVE, the recognized-shape tables below are the
 * single place to refine; the launcher contract does not change.
 *
 * RATE LIMIT (KG-1): quota exhaustion surfaces as a `429` / `rate_limit` error.
 * `detectKimiRateLimit` recognizes it so the launcher can emit a graceful,
 * user-facing message instead of a raw exit-code error (the exact wording is an
 * owner product decision — plan §5.2/§7.3 — so it lives as a single overridable
 * constant here).
 */

import { createNormalizedMessage, stampCoordinatorId } from './shared/utils.js';

/**
 * Default graceful message shown when a kimi agent turn hits the Moonshot quota
 * (`429`/`rate_limit`). Wording is an owner product decision (plan §7.3) — kept
 * as one constant so it can be tuned in a single place without touching parsing.
 * @type {string}
 */
export const KIMI_RATE_LIMIT_MESSAGE =
  'تم بلوغ حدّ استخدام Kimi (rate limit). انتظر تجدّد الحصة لدى Moonshot ثم أعد المحاولة.';

/**
 * The first non-empty string among the provided candidates, else null. Lets the
 * defensive normalizer accept several plausible field spellings per event.
 * @param {...unknown} candidates
 * @returns {string|null}
 */
function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c;
    }
  }
  return null;
}

/**
 * True when a parsed kimi event represents a quota / rate-limit refusal
 * (`429` status or a `rate_limit`-flavored code/message). Case-insensitive.
 * @param {any} event a parsed stream-json object
 * @returns {boolean}
 */
export function detectKimiRateLimit(event) {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const status = Number(event.status ?? event.status_code ?? event.http_status ?? event.code);
  if (status === 429) {
    return true;
  }
  const haystack = [
    event.code,
    event.error_code,
    event.type,
    event.subtype,
    event.error,
    event.message,
    typeof event.error === 'object' ? event.error?.type : null,
    typeof event.error === 'object' ? event.error?.message : null,
  ]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return /rate[_\s-]?limit|too many requests|quota/.test(haystack);
}

/**
 * Extracts a session/thread id from an init-style event, tolerating the several
 * field names the CLI may use.
 * @param {any} event
 * @returns {string|null}
 */
export function extractKimiSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  return firstString(
    event.session_id,
    event.sessionId,
    event.thread_id,
    event.threadId,
    event.conversation_id,
    event.id,
  );
}

/**
 * Normalizes a single parsed kimi stream-json event into a list of intent
 * descriptors the handler acts on. Pure and defensive: unknown shapes yield [].
 * Exported so the launcher's static tests can assert the mapping without a spawn.
 *
 * Descriptor kinds:
 *  - { intent:'init', sessionId }
 *  - { intent:'text', content }
 *  - { intent:'tool_use', toolId, toolName, input }
 *  - { intent:'tool_result', toolId, output, isError }
 *  - { intent:'usage', tokenBudget }
 *  - { intent:'rate_limit', message }
 *  - { intent:'error', content }
 *
 * @param {any} event a parsed stream-json object
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeKimiEvent(event) {
  if (!event || typeof event !== 'object') {
    return [];
  }

  // Rate limit takes priority — a 429 error must never be misread as prose.
  if (detectKimiRateLimit(event)) {
    return [{ intent: 'rate_limit', message: KIMI_RATE_LIMIT_MESSAGE }];
  }

  const type = firstString(event.type, event.event, event.kind);

  // Session init / system announce.
  if (type === 'init' || type === 'system' || type === 'session' || type === 'thread.started') {
    const sessionId = extractKimiSessionId(event);
    return sessionId ? [{ intent: 'init', sessionId }] : [];
  }

  // Tool call.
  if (type === 'tool_use' || type === 'tool_call' || type === 'tool') {
    return [
      {
        intent: 'tool_use',
        toolId: firstString(event.tool_id, event.id, event.tool_use_id),
        toolName: firstString(event.tool_name, event.name),
        input: event.parameters ?? event.input ?? event.arguments ?? {},
      },
    ];
  }

  // Tool result.
  if (type === 'tool_result' || type === 'tool_output') {
    return [
      {
        intent: 'tool_result',
        toolId: firstString(event.tool_id, event.tool_use_id, event.id),
        output: event.output === undefined ? (event.result ?? event.content ?? null) : event.output,
        isError: event.status === 'error' || event.is_error === true || event.isError === true,
      },
    ];
  }

  const descriptors = [];

  // Assistant text: either a typed message event or a bare content/delta field.
  const isAssistant =
    (type === 'message' && (event.role === 'assistant' || event.role === undefined)) ||
    type === 'assistant' ||
    type === 'content' ||
    type === 'text' ||
    type === 'delta';
  if (isAssistant) {
    const content = firstString(
      typeof event.content === 'string' ? event.content : null,
      typeof event.text === 'string' ? event.text : null,
      typeof event.delta === 'string' ? event.delta : null,
    );
    if (content) {
      descriptors.push({ intent: 'text', content });
    }
  }

  // Explicit error line (non-rate-limit).
  if (type === 'error' || event.error) {
    const content = firstString(
      typeof event.error === 'string' ? event.error : null,
      typeof event.error === 'object' ? event.error?.message : null,
      event.message,
    );
    if (content) {
      descriptors.push({ intent: 'error', content });
    }
  }

  // Usage / token accounting.
  const tokenBudget = buildKimiTokenBudget(event.usage ?? event.tokens);
  if (tokenBudget) {
    descriptors.push({ intent: 'usage', tokenBudget });
  }

  return descriptors;
}

/**
 * Builds a token-budget status payload from a kimi usage/tokens object, tolerant
 * of the input/output/total field spellings. Returns null when nothing usable.
 * @param {any} tokens
 * @returns {{ used:number, inputTokens:number, outputTokens:number,
 *            breakdown:{ input:number, output:number } }|null}
 */
export function buildKimiTokenBudget(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return null;
  }
  const input = Number(tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens);
  const output = Number(tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens);
  const inputTokens = Number.isFinite(input) ? input : 0;
  const outputTokens = Number.isFinite(output) ? output : 0;
  const totalRaw = Number(tokens.total ?? tokens.total_tokens);
  const used = Number.isFinite(totalRaw) ? totalRaw : inputTokens + outputTokens;
  if (!Number.isFinite(used) || used <= 0) {
    return null;
  }
  return {
    used,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/**
 * Line-buffered NDJSON parser + emitter for a kimi agent stream. Mirrors
 * GeminiResponseHandler: buffer raw stdout chunks, split on newlines, keep the
 * trailing partial line, JSON.parse each complete line and dispatch. A line that
 * is not valid JSON (CLI banner / debug noise) is ignored, never fatal.
 */
export class KimiAgentResponseHandler {
  /**
   * @param {{ send: (msg: unknown) => void, userId?: number|null,
   *           getSessionId?: () => string|null }} ws
   * @param {{ onContentFragment?: (content: string) => void,
   *           onInit?: (sessionId: string) => void,
   *           onToolUse?: (event: Record<string, unknown>) => void,
   *           onToolResult?: (event: Record<string, unknown>) => void,
   *           onRateLimit?: (message: string) => void }} [callbacks]
   */
  constructor(ws, callbacks = {}) {
    this.ws = ws;
    this.buffer = '';
    this.onContentFragment = callbacks.onContentFragment || null;
    this.onInit = callbacks.onInit || null;
    this.onToolUse = callbacks.onToolUse || null;
    this.onToolResult = callbacks.onToolResult || null;
    this.onRateLimit = callbacks.onRateLimit || null;
  }

  /** @returns {string|null} */
  currentSessionId() {
    return typeof this.ws?.getSessionId === 'function' ? this.ws.getSessionId() : null;
  }

  /**
   * Feed a raw stdout chunk. Splits on newlines, keeping the last partial line.
   * @param {string} data
   */
  processData(data) {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Not JSON — CLI banner / debug output. Ignore (GeminiResponseHandler parity).
        continue;
      }
      this.dispatch(event);
    }
  }

  /**
   * Convert one parsed event into normalized WS messages + session callbacks.
   * @param {any} event
   */
  dispatch(event) {
    const sid = this.currentSessionId();
    for (const d of normalizeKimiEvent(event)) {
      switch (d.intent) {
        case 'init':
          if (this.onInit && typeof d.sessionId === 'string') {
            this.onInit(d.sessionId);
          }
          break;
        case 'text':
          if (this.onContentFragment && typeof d.content === 'string') {
            this.onContentFragment(d.content);
          }
          this.send({ kind: 'stream_delta', content: d.content, sessionId: sid });
          break;
        case 'tool_use':
          if (this.onToolUse) {
            this.onToolUse(d);
          }
          this.send({
            kind: 'tool_use',
            id: d.toolId,
            name: d.toolName,
            input: d.input,
            sessionId: sid,
          });
          break;
        case 'tool_result':
          if (this.onToolResult) {
            this.onToolResult(d);
          }
          this.send({
            kind: 'tool_result',
            tool_use_id: d.toolId,
            content: d.output,
            is_error: d.isError === true,
            sessionId: sid,
          });
          break;
        case 'usage':
          this.send({ kind: 'status', text: 'token_budget', tokenBudget: d.tokenBudget, sessionId: sid });
          break;
        case 'rate_limit':
          if (this.onRateLimit && typeof d.message === 'string') {
            this.onRateLimit(d.message);
          }
          this.send({ kind: 'error', code: 'rate_limit', content: d.message, sessionId: sid });
          break;
        case 'error':
          this.send({ kind: 'error', content: d.content, sessionId: sid });
          break;
        default:
          break;
      }
    }
  }

  /**
   * Emit a normalized message stamped with the spawning coordinator (multi-user
   * attribution parity with the other providers).
   * @param {Record<string, unknown>} fields
   */
  send(fields) {
    if (!this.ws || typeof this.ws.send !== 'function') {
      return;
    }
    const msg = createNormalizedMessage({ provider: 'kimi', ...fields });
    stampCoordinatorId(msg, this.ws?.userId);
    this.ws.send(msg);
  }

  /** Parse any trailing buffered line at process close. */
  forceFlush() {
    if (this.buffer.trim()) {
      try {
        this.dispatch(JSON.parse(this.buffer));
      } catch {
        // trailing partial / non-JSON — drop it.
      }
    }
    this.buffer = '';
  }

  destroy() {
    this.buffer = '';
  }
}

export default KimiAgentResponseHandler;
