/**
 * sessionBuckets.ts — the one list that says which providers own a session
 * bucket in the project payload, and what that bucket is called.
 *
 * WHY THIS FILE EXISTS (B-598). The project payload carries sessions grouped by
 * provider under hand-written keys — `sessions` for claude, `<provider>Sessions`
 * for everyone else. That grouping was enumerated by hand in eight places
 * (server bucketing, three payload builders, the client merge/flatten/delete
 * paths, the sidebar, the command palette), and every one of them stopped at
 * `opencode`. So every provider added after it — hermes, kimi, glm — wrote a
 * perfectly good `sessions` row, recorded its participant, passed the B-29
 * native filter, and was then dropped on the floor by a single
 * `if (!bucket) continue` in the bucketing step. The session existed everywhere
 * except on screen.
 *
 * The failure mode is what makes the list worth its own file: adding a provider
 * looked complete once it could spawn and stream, because nothing in the
 * payload path raised a type error for a missing bucket — the miss was silent,
 * and it stayed silent for three providers in a row. A provider is listed HERE
 * exactly once, and the enumeration sites iterate this list instead of
 * restating it, so "forgot to add the bucket" is no longer a reachable state.
 *
 * ORDER IS CONTRACT-ISH, not cosmetic: the payload keys are emitted in this
 * order, and the sidebar concatenates buckets in this order before sorting by
 * star/date. Sorting makes the final list order-independent, but keeping a
 * stable order keeps diffs and fixtures readable.
 */

/**
 * Every provider that can own sessions in a project payload.
 *
 * This is the same set as the client's `LLMProvider` union (`src/types/app.ts`
 * re-exports it as that alias, so the two cannot drift). Hosted vendor
 * providers (ADR-036) are included even when they rarely spawn today: an empty
 * bucket costs one key, while a missing bucket costs an invisible conversation.
 */
export const SESSION_BUCKET_PROVIDERS = [
  'claude',
  'cursor',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
  'qwen',
  // Hosted vendor providers (ADR-036). Each is its own provider over
  // server/modules/providers and can write a session row of its own.
  'kimi',
  'deepseek',
  'glm',
  'hermes',
  'sakana',
] as const;

export type SessionBucketProvider = (typeof SESSION_BUCKET_PROVIDERS)[number];

/**
 * The payload key a provider's sessions arrive under.
 *
 * Claude is `sessions` (not `claudeSessions`) because it predates the provider
 * axis and the key is baked into the public payload; renaming it would be a
 * breaking change for no gain.
 */
export type SessionBucketKey<P extends SessionBucketProvider = SessionBucketProvider> =
  P extends 'claude' ? 'sessions' : `${P}Sessions`;

export function sessionBucketKey<P extends SessionBucketProvider>(provider: P): SessionBucketKey<P> {
  return (provider === 'claude' ? 'sessions' : `${provider}Sessions`) as SessionBucketKey<P>;
}

/** Payload keys in provider order — for `Pick<>`-style reads and iteration. */
export const SESSION_BUCKET_KEYS = SESSION_BUCKET_PROVIDERS.map(sessionBucketKey) as ReadonlyArray<SessionBucketKey>;

/**
 * The bucket half of a project payload: `{ sessions, cursorSessions, … }` with
 * one key per provider, all carrying the same element type.
 */
export type SessionBuckets<T> = { [P in SessionBucketProvider as SessionBucketKey<P>]: T[] };

/** An empty bucket record — the starting point for grouping rows by provider. */
export function emptySessionBuckets<T>(): SessionBuckets<T> {
  const buckets = {} as SessionBuckets<T>;
  for (const provider of SESSION_BUCKET_PROVIDERS) {
    (buckets as Record<string, T[]>)[sessionBucketKey(provider)] = [];
  }
  return buckets;
}

/** True when `value` names a provider that owns a session bucket. */
export function isSessionBucketProvider(value: unknown): value is SessionBucketProvider {
  return typeof value === 'string' && (SESSION_BUCKET_PROVIDERS as readonly string[]).includes(value);
}
