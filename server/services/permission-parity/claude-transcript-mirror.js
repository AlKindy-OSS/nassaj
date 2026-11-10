/**
 * claude-transcript-mirror — a Claude Code-format transcript (JSONL) of a non-Claude turn,
 * so Claude hooks that read `transcript_path` see what they would see under Claude
 * (T-2089 S5, ADR-225). Lines: `{ type: 'user'|'assistant', uuid, parentUuid, sessionId,
 * cwd, timestamp, message: { role, content } }`; tool calls are assistant `tool_use` blocks
 * and their outcomes user `tool_result` blocks. Best effort: a write failure never stops
 * the turn (a hook then reads a shorter transcript). The file is the member's own (0600).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Where a member's mirror for one session lives (inside his dsh tree). */
export function claudeTranscriptMirrorPath(home, sessionId) {
  return path.join(home, '.nassaj', 'claude-transcripts', `${String(sessionId).replace(/[^A-Za-z0-9-]/g, '_')}.jsonl`);
}

export class ClaudeTranscriptMirror {
  /** @param {{ file: string, sessionId: string, cwd: string }} input */
  constructor({ file, sessionId, cwd }) {
    this.file = file;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.parent = null;
    this.text = '';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
    } catch { /* best effort */ }
  }

  /** Re-keys the mirror to the session id dsh assigned: lines so far are rewritten to it. */
  rename(sessionId, file) {
    this.flushText();
    try {
      const rows = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.stringify({ ...JSON.parse(line), sessionId }));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, rows.map((row) => `${row}\n`).join(''), { mode: 0o600 });
      fs.rmSync(this.file, { force: true });
    } catch { /* best effort */ }
    this.sessionId = sessionId;
    this.file = file;
  }

  line(type, content) {
    const uuid = crypto.randomUUID();
    const row = { type, uuid, parentUuid: this.parent, sessionId: this.sessionId, cwd: this.cwd,
      timestamp: new Date().toISOString(), message: { role: type, content } };
    this.parent = uuid;
    try { fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 }); } catch { /* best effort */ }
  }

  user(text) { this.flushText(); this.line('user', [{ type: 'text', text: String(text) }]); }
  addText(text) { this.text += text; }
  flushText() {
    if (!this.text) return;
    const text = this.text;
    this.text = '';
    this.line('assistant', [{ type: 'text', text }]);
  }
  toolUse(id, name, input) { this.flushText(); this.line('assistant', [{ type: 'tool_use', id, name, input: input ?? {} }]); }
  toolResult(id, text, isError) {
    this.flushText();
    this.line('user', [{ type: 'tool_result', tool_use_id: id, content: String(text ?? ''), is_error: !!isError }]);
  }
}
