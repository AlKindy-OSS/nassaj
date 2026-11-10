# context-guard fixtures (T-2087, ADR-223)

Derived from real records on the Alkindy host on 2026-11-07, then anonymized:
message text, paths, ids and uuids are replaced; field names, nesting and the
token numbers are kept as recorded.

- `claude-tail.jsonl` — last main-chain assistant row of a live Opus 5.5
  transcript (usage 2 + 984 + 237908 input tokens).
- `claude-compacted-tail.jsonl` — the same row followed by a real manual
  `compact_boundary` record and its compact-summary user row.
- `codex-rollout-tail.jsonl` — a gpt-6-luna rollout: token_count
  (171686 of 258400), `compacted`, the next turn_context and the fresh
  token_count (22023).
- `opencode-models.json` — four entries copied from a member's
  `~/.cache/opencode/models.json` (`limit` blocks unchanged).
- `opencode-assistant-message.json` — one assistant `message.data` row from a
  member's opencode.db; tests vary only `tokens`, `providerID` and `modelID`.
- `claude-catalog.json` — the live Claude picker catalog (value, label,
  description) from the server's provider-models cache.
