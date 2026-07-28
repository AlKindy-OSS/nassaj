Frontend analysis is in too, and it lines up cleanly with the backend findings — no contradictions between the two agents. Two concrete frontend bugs found, both in the refresh button's guard logic (not state/render, not caching):

1. **Primary cause**: `ChatInterface.tsx:146-168` — the auth-status half of "refresh" is gated by a 30-second TTL with no bypass. Since the same function also fires on page mount and on dialog-open, a user who opens the picker and clicks refresh within 30 seconds (very common) gets a silent no-op for that half — while the model-catalog half quietly does refresh in the background but doesn't visibly change anything, since the visible list is filtered by auth status, not just the catalog.
2. **Secondary, worse on a slower/loaded node like traventure**: `ProviderSelectionEmptyState.tsx:182-194` — a race between the dialog-open effect and the button click; clicking refresh while the dialog-open's own auth check is still in flight silently no-ops, and the button's spinner/disabled state doesn't reflect this, so it looks idle rather than busy.

وأخبرني إن أردت شرح أي جزء بتفصيل أكثر.

Both bugs were introduced in the same commit that added the refresh button (`8da495d7`, 2026-06-13) — guards meant to stop passive duplicate calls never got an exception for explicit user-triggered clicks. Combined with the backend findings (Hermes has no live query at all; kimi/deepseek/glm circuit breaker isn't reset by the cache-bypass), this gives a full picture. Still waiting on the tabs-toggle agent's confirmation before I close this out.
