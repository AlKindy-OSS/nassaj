# Live session read link fixtures (T-2013 stage 2, ADR-205)

Transcripts for the five providers that `../session-share/` does not cover,
used by `server/services/session-share-live.fixtures.integration.test.ts`. The
same test reuses the five `../session-share/` fixtures (Claude, Codex,
Antigravity, Kimi, OpenCode) and appends live-only records to them at placement
time (a files-note prompt, an image fence reply, an embedded image, a secret),
cloned from records already in those files.

| File | Provider | Record shape | Where the test lays it |
|---|---|---|---|
| `qwen.jsonl` | Qwen | CLI turn writer (`appendVendorTranscriptTurn`): `meta`, then `message` events with `id`, `timestamp`, `eventId`, a receipt on the user turn, and one duplicated event id (the reader de-duplicates it) | `~/.nassaj-vendor-sessions/qwen/<project hash>/<session>.jsonl` |
| `hermes.jsonl` | Hermes | Same writer, rows without timestamps or ids (the reader falls back to parse-time values) and a repeated identical prompt | `~/.nassaj-vendor-sessions/hermes/<project hash>/<session>.jsonl` |
| `glm.jsonl`, `deepseek.jsonl` | GLM, DeepSeek | Hosted runtime (`vendor-runtime.js`): the user turn, then the raw Anthropic-compatible SSE events of the reply (thinking delta, tool_use block, text deltas, stop) and a tool_result turn | `~/.nassaj-vendor-sessions/<provider>/<project hash>/<session>.jsonl` |
| `cursor.json` | Cursor | The JSON message blobs of `store.db` (system, user with `<user_info>` and `<user_query>`, assistant reasoning and tool-call, tool result, assistant text), in insertion order | the test writes them into a `blobs` table in `~/.cursor/chats/<md5(project)>/<session>/store.db` |

Qwen and Hermes record only conversational turns, so their files carry no
tool, thinking or subagent rows. No provider here writes an attachment note,
so none of these files carries attachments (ADR-205 D9).

## Scrubbing

- `__SECRET__` marks where a known secret pattern goes; the test fills it at
  runtime so no token literal sits in the tree.
- Home paths use `/home/operator`; identifiers are synthetic (zero UUIDs with a
  running counter, `msg_20000000-NNNN`, `toolu_20000000-NNNN`).
- Message text is neutral demo content written for these fixtures.

`scripts/public-operations-boundary.test.mjs` scans this directory; any new
fixture must pass it.
