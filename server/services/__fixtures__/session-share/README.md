# Session share snapshot fixtures (T-1970 stage 3, ADR-196)

Minimal transcripts in the on-disk shapes of five providers, used by
`server/services/session-share-snapshot.fixtures.integration.test.ts` to run the
share snapshot builder through each live provider reader. The record shapes were
taken from real provider output on 2026-10-04; every host path and identifier
has since been replaced by synthetic values (B-1520).

| File | Provider | Where the reader expects it | Kept |
|---|---|---|---|
| `claude.jsonl` | Claude | `<CLAUDE_CONFIG_DIR>/projects/-home-operator-Project-General/<session>.jsonl` | 9 records (user prompt with image path list, thinking, tool_use, tool_result, assistant text, a second turn) + a `/compact` slash command, a `local-command-stdout` row and a sidechain `system-reminder` row |
| `codex.jsonl` | Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl` | 19 records: session meta, developer/injected context, user prompts, reasoning, exec and function calls with outputs, agent-to-agent messages, assistant answers |
| `antigravity.jsonl` | agy (Antigravity) | `~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl` | 6 steps |
| `kimi.jsonl` | Kimi | `~/.nassaj-vendor-sessions/kimi/<project hash>/<session>.jsonl` | meta + one user prompt (no assistant reply) |
| `opencode.json` | OpenCode | `~/.local/share/opencode/opencode.db` | all `message` and `part` rows of one session, as JSON (the test loads them into a fresh SQLite file) |

## Scrubbing applied

- Home paths use the generic placeholder `/home/operator` (and its encoded form
  `-home-operator-`), so path redaction still runs on real shapes.
- Session, message and request identifiers are synthetic: UUIDs keep their
  version and variant nibbles but are otherwise zero with a running counter
  (`00000000-0000-4000-8000-000000000013`), and provider ids use
  `msg_10000000-NNNN` / `req_10000000-NNNN` / `ses_10000000-NNNN`, numbered in the
  original sort order so readers that order by id still see the same sequence.
- Tool outputs replaced by `[fixture: tool output truncated]`; Codex encrypted
  reasoning replaced by `fixture-encrypted`; Claude thinking signatures by
  `fixture-signature`.
- Long texts (thinking, injected instructions, agent messages) truncated in the
  middle with `…[fixture-truncated]…`, keeping head and tail so closing tags stay.
- Dropped: Claude `usage`/`wireToolInputs`/`toolUseResult`, Codex
  `base_instructions`/`git`/`source`, OpenCode `tokens`/`cost`/tool `metadata`.
- No API keys, tokens, JWTs or email addresses.

`scripts/public-operations-boundary.test.mjs` scans this directory; any new
fixture must pass it. Do not add transcripts from other users' sessions.
