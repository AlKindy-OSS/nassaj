/**
 * dsh-transcript — Nassaj's own record of a dsh conversation (T-2086 S3, ADR-224).
 *
 * dsh has no `session/load`, so history is never read back from dsh: every turn
 * is appended to the nassaj-owned vendor transcript
 * (`~/.nassaj-vendor-sessions/dsh/<projectHash>/<sessionId>.jsonl`) and read by
 * the shared VendorSessionsProvider. Order is preserved: assistant text is
 * flushed before each tool call. Writes are serialized per recorder and never
 * throw (a transcript records the conversation; it is not the conversation).
 */

import fs from 'node:fs/promises';

import {
  appendVendorTranscript,
  appendVendorTranscriptTurn,
  resolveVendorTranscriptForRead,
  writeVendorTranscriptMeta,
} from '../../shared/vendor/vendor-transcript.js';

const PROVIDER = 'dsh';
/** Transcript event naming the member whose dsh home holds the session. */
const OWNER_EVENT = 'dsh_owner';

/**
 * The session's owner event: the member whose dsh home holds `sessionId`, and
 * (ADR-227 / T-2108) the qualified local model id a local chat was created on —
 * the server's own record of a local chat's model. Null when there is no readable
 * record; `model` is null for a cloud chat.
 * @param {string} sessionId
 * @param {string} projectPath
 * @returns {Promise<{ ownerUserId: string, model: string|null }|null>}
 */
export async function readDshSessionRecord(sessionId, projectPath) {
  try {
    const file = await resolveVendorTranscriptForRead(PROVIDER, sessionId, projectPath);
    if (!file) return null;
    for (const line of (await fs.readFile(file, 'utf8')).split('\n').slice(0, 8)) {
      try {
        const event = JSON.parse(line);
        if (event?.type === OWNER_EVENT && event.ownerUserId !== undefined) {
          return { ownerUserId: String(event.ownerUserId), model: typeof event.model === 'string' ? event.model : null };
        }
      } catch {
        // not JSON
      }
    }
  } catch {
    // unreadable = no record
  }
  return null;
}

export class DshTranscriptRecorder {
  /** @param {{ projectPath: string, model?: string|null }} input */
  constructor({ projectPath, model = null }) {
    this.projectPath = projectPath;
    this.model = model;
    this.sessionId = null;
    this.text = '';
    this.chain = Promise.resolve();
  }

  /**
   * Binds the session; a new session also gets the transcript header and its owner
   * (with `localModel`, the qualified local model id a local chat runs on, T-2108).
   */
  start(sessionId, { isNew, command, ownerUserId, localModel = null }) {
    this.sessionId = sessionId;
    if (isNew) {
      this.enqueue(() => writeVendorTranscriptMeta(PROVIDER, sessionId, this.projectPath, command));
      this.enqueue(() => appendVendorTranscript(PROVIDER, sessionId, this.projectPath, {
        type: OWNER_EVENT, ownerUserId: String(ownerUserId), ...(localModel ? { model: localModel } : {}),
      }));
    }
    this.enqueue(() => appendVendorTranscriptTurn(PROVIDER, sessionId, this.projectPath, 'user', String(command ?? '')));
  }

  /** Accumulates streamed assistant text. */
  addText(text) {
    if (this.sessionId) this.text += text;
  }

  /** Records a tool call (after the text streamed before it). */
  toolUse(id, name, input) {
    this.flushText();
    this.event({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: input ?? {} }] });
  }

  /** Records a tool result. */
  toolResult(id, content, isError) {
    this.event({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] });
  }

  /** Flushes the final text and waits for every pending write. */
  async finish() {
    this.flushText(true);
    await this.chain;
  }

  /** @private */
  flushText(finalAnswer = false) {
    const text = this.text;
    this.text = '';
    if (!this.sessionId || !text.trim()) return;
    const sessionId = this.sessionId;
    this.enqueue(() => appendVendorTranscriptTurn(PROVIDER, sessionId, this.projectPath, 'assistant', text, {
      model: this.model ?? undefined, finalAnswer,
    }));
  }

  /** @private */
  event(message) {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.enqueue(() => appendVendorTranscript(PROVIDER, sessionId, this.projectPath, {
      type: 'message', timestamp: new Date().toISOString(), message,
    }));
  }

  /** @private */
  enqueue(write) {
    this.chain = this.chain.then(write).catch(() => {});
  }
}
