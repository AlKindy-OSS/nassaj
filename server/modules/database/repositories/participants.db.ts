/**
 * Session participants repository.
 *
 * Tracks the authenticated human users who have spawned runs inside a session
 * (table: session_participants). The earliest participant of a session is
 * flagged 'owner'; later distinct users are 'participant'. All access uses
 * prepared statements — no string interpolation of caller input.
 *
 * The agent side of participation (models / subagents parsed from the
 * transcript) lives in the transcript parser service and the
 * session_agents_cache / session_agents_meta tables, not here.
 */

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

export type ParticipantRole = 'owner' | 'participant';

/**
 * Spawn-site context used to self-heal a missing parent sessions row. The run
 * path can outrace the session synchronizer: on the FIRST spawn of a fresh
 * conversation the sessions row (created later from the transcript file) does
 * not exist yet, so the participant insert fails its FOREIGN KEY. With this
 * context we create the parent row ourselves (the synchronizer's later upsert
 * fills in the real jsonl_path / timestamps) and retry once.
 */
export type SpawnContext = {
  provider: string;
  projectPath: string;
  /**
   * Defaults to 'spawn'. Only the data-provenance callers (the opencode
   * synchronizer) pass 'provenance' — see ADR-104.
   */
  attribution?: ParticipantAttribution;
};

/**
 * Where a participant row came from (ADR-104). `'spawn'` = an authenticated
 * human started a run through this server, so the row carries their consent.
 * `'provenance'` = the server inferred the row from data provenance and it
 * grants nothing. See the schema comment on session_participants.
 */
export type ParticipantAttribution = 'spawn' | 'provenance';

/**
 * A real spawn arriving on a session whose only owner is an inferred row takes
 * the badge from it. This is the fix for the opencode race (B-477), where the
 * synchronizer sees the session in the shared data dir and claims it ~2 seconds
 * before the CLI prints the id the spawn path needs. Demoting first also keeps
 * the single-owner index satisfiable: without it the INSERT below would try to
 * add a second 'owner'.
 *
 * Scoped to OTHER users: a returning spawner's own row is handled by the upsert.
 */
const DEMOTE_INFERRED_OWNER_SQL = `UPDATE session_participants
   SET role = 'participant'
   WHERE session_id = ?
     AND user_id <> ?
     AND role = 'owner'
     AND attribution = 'provenance'`;

/**
 * Bind order: sessionId, userId, attribution, sessionId, attribution, sessionId,
 * attribution, attribution.
 *
 * Anonymous `?` placeholders with repeated values, NOT `?1`-style numbering:
 * better-sqlite3 classifies numbered parameters as NAMED and then rejects an
 * array binding outright ("Too many parameter values were provided"), which
 * recordSpawn would have swallowed into its catch — every participant row
 * silently missing. Kept as a plain list so the failure cannot recur quietly.
 *
 * Ownership goes to the first row that is not an inferred one — a session whose
 * every existing row is 'provenance' is still unowned in the consent sense, so
 * the first real human to spawn into it becomes its owner. An inferred write
 * claims ownership only when the session has no row at all, so it can name an
 * externally-created conversation without ever outranking a human.
 *
 * On conflict the counters move and attribution RATCHETS one way: provenance can
 * be promoted to spawn (the human showed up after all), never the reverse — a
 * background rescan must not be able to revoke consent already granted.
 */
const RECORD_SPAWN_SQL = `INSERT INTO session_participants (session_id, user_id, role, message_count, attribution)
   VALUES (
     ?,
     ?,
     CASE
       WHEN ? = 'spawn' AND NOT EXISTS (
              SELECT 1 FROM session_participants WHERE session_id = ? AND role = 'owner'
            )
       THEN 'owner'
       WHEN ? <> 'spawn' AND NOT EXISTS (
              SELECT 1 FROM session_participants WHERE session_id = ?
            )
       THEN 'owner'
       ELSE 'participant'
     END,
     1,
     ?
   )
   ON CONFLICT(session_id, user_id) DO UPDATE SET
     last_seen = CURRENT_TIMESTAMP,
     message_count = message_count + 1,
     attribution = CASE WHEN ? = 'spawn' THEN 'spawn' ELSE attribution END`;

export type SessionParticipantRow = {
  userId: number;
  username: string;
  role: ParticipantRole;
  first_seen: string;
  last_seen: string;
  message_count: number;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) or null. Joined
  // from the users table so the participant UI can render real avatars instead of
  // the coloured initial fallback.
  avatarUrl: string | null;
};

/**
 * Minimal owner identity for a single session, used to attribute each session
 * in the projects/sessions listing to the human who first spawned it.
 */
export type SessionOwnerRow = {
  sessionId: string;
  userId: number;
  username: string;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) or null, so
  // owner badges can render the real avatar instead of the coloured initial.
  avatarUrl: string | null;
};

/**
 * One human on one session, as returned by the batched listing lookup. Slimmer
 * than {@link SessionParticipantRow}: the sidebar avatar stack needs identity,
 * role (owner first) and recency only — not the counters.
 */
export type SessionParticipantsListRow = {
  sessionId: string;
  userId: number;
  username: string;
  avatarUrl: string | null;
  role: ParticipantRole;
  last_seen: string;
};

export const participantsDb = {
  /**
   * Records (or refreshes) a human participant on a session spawn.
   *
   * First real spawner becomes 'owner'; any subsequent distinct user is
   * 'participant'. On a repeat spawn by an existing participant the row's
   * last_seen is bumped and message_count incremented — the role is never
   * downgraded. Never throws: participation tracking must not break the run
   * path, so failures are logged and swallowed.
   *
   * A 'spawn' write also takes the owner badge off an inferred row first, so the
   * human who actually started the conversation ends up owning it even when a
   * background scan named it first (B-477). Both statements run in one
   * transaction: a demote that landed without its insert would leave the session
   * ownerless.
   */
  recordSpawn(sessionId: string, userId: number, context?: SpawnContext): void {
    if (!sessionId || !Number.isInteger(userId)) {
      return;
    }

    const attribution: ParticipantAttribution = context?.attribution ?? 'spawn';

    const write = (db: ReturnType<typeof getConnection>): void => {
      db.transaction(() => {
        if (attribution === 'spawn') {
          db.prepare(DEMOTE_INFERRED_OWNER_SQL).run(sessionId, userId);
        }
        db.prepare(RECORD_SPAWN_SQL).run(
          sessionId,
          userId,
          attribution,
          sessionId,
          attribution,
          sessionId,
          attribution,
          attribution
        );
      })();
    };

    try {
      write(getConnection());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // FK failure = the parent sessions row does not exist yet (run path beat
      // the synchronizer). Create it from the spawn context and retry once; the
      // synchronizer's upsert later replaces the stub fields with real values.
      if (context && /FOREIGN KEY/i.test(message)) {
        try {
          sessionsDb.createSession(sessionId, context.provider, context.projectPath);
          write(getConnection());
          return;
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error('Failed to record session participant after creating session row', {
            sessionId,
            userId,
            error: retryMessage,
          });
          return;
        }
      }

      console.error('Failed to record session participant', { sessionId, userId, error: message });
    }
  },

  /**
   * True when the session already has ANY human participant row (owner or
   * participant), regardless of which user. Distinct from {@link isParticipant}
   * (which asks about ONE user): this is the idempotency guard the OpenCode
   * synchronizer uses (T-857) to attribute an unowned externally-created session
   * exactly once — a session that already has an owner is never re-attributed,
   * so its message_count/last_seen are never inflated by background rescans.
   * Fail-open to "has a participant" is never done: any anomaly returns false
   * only for an empty id, and a real query failure would surface, so the caller
   * simply attempts an idempotent recordSpawn (itself ON CONFLICT-safe).
   */
  hasParticipant(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }

    const db = getConnection();
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM session_participants WHERE session_id = ? LIMIT 1`
      )
      .get(sessionId) as { ok: number } | undefined;

    return row !== undefined;
  },

  /**
   * Access predicate for a session: is `userId` a human owner/participant of
   * `sessionId`, OR the recorded author of at least one message in it?
   *
   * This is the REST authorization gate for any endpoint that discloses a
   * session's content/messages by sessionId (B-105). The access model mirrors
   * the "native session" predicate in sessions.db.ts exactly — a user belongs
   * to a session iff the server's run path recorded them as a participant
   * (session_participants) or as a message author (message_authors). Both are
   * written only on the authenticated spawn path, never by an out-of-band CLI
   * run, so this cannot be spoofed by dropping a transcript on disk.
   *
   * message_authors is included because it is half of the access model: a user
   * who sent prompts into a session is an author of its content even in the
   * (rare) window before/without a participant row, so excluding it could
   * fail-closed against a legitimate sender. Owner-only sessions still pass via
   * the participant branch.
   *
   * ADR-104 — the participant branch is restricted to attribution='spawn'. This
   * is a CONSENT predicate, and an inferred row is not consent: it says the
   * server found a conversation in a data dir it associates with someone, not
   * that they joined it. Leaving inferred rows in here is what let a boot-time
   * backfill hand the platform owner `restamp` rights — the authority to replay
   * another member's entire history to a different vendor — on 93 sessions
   * (B-476). The authorship branch is deliberately NOT filtered: writing a
   * prompt into a conversation is consent by itself, whatever wrote the row.
   *
   * Fail-closed by construction: a non-integer userId (anonymous / unresolved)
   * matches nothing and returns false. Uses prepared statements only.
   */
  isParticipant(sessionId: string, userId: number): boolean {
    if (!sessionId || !Number.isInteger(userId)) {
      return false;
    }

    const db = getConnection();
    const row = db
      .prepare(
        `SELECT 1 AS ok
         WHERE EXISTS (
                 SELECT 1 FROM session_participants sp
                 WHERE sp.session_id = ? AND sp.user_id = ?
                   AND sp.attribution = 'spawn'
               )
            OR EXISTS (
                 SELECT 1 FROM message_authors ma
                 WHERE ma.session_id = ? AND ma.user_id = ?
               )
         LIMIT 1`
      )
      .get(sessionId, userId, sessionId, userId) as { ok: number } | undefined;

    return row !== undefined;
  },

  /**
   * Lists the human participants of a session, joined to their current
   * username. Ordered owner-first then by first appearance so the UI renders a
   * stable, meaningful sequence.
   */
  listBySession(sessionId: string): SessionParticipantRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT
           sp.user_id      AS userId,
           u.username      AS username,
           u.avatar_url    AS avatarUrl,
           sp.role         AS role,
           sp.first_seen   AS first_seen,
           sp.last_seen    AS last_seen,
           sp.message_count AS message_count
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id = ?
         ORDER BY CASE sp.role WHEN 'owner' THEN 0 ELSE 1 END, datetime(sp.first_seen) ASC`
      )
      .all(sessionId) as SessionParticipantRow[];
  },

  /**
   * Aggregates human participants across many sessions (a project view).
   * Distinct users are returned once; message_count is summed and the earliest
   * first_seen / latest last_seen are kept. The 'owner' role is preserved if the
   * user owned at least one of the project's sessions.
   */
  aggregateBySessionIds(sessionIds: string[]): SessionParticipantRow[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT
           sp.user_id AS userId,
           u.username AS username,
           MAX(u.avatar_url) AS avatarUrl,
           CASE WHEN MAX(sp.role = 'owner') = 1 THEN 'owner' ELSE 'participant' END AS role,
           MIN(sp.first_seen)  AS first_seen,
           MAX(sp.last_seen)   AS last_seen,
           SUM(sp.message_count) AS message_count
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id IN (${placeholders})
         GROUP BY sp.user_id, u.username
         ORDER BY CASE WHEN MAX(sp.role = 'owner') = 1 THEN 0 ELSE 1 END, datetime(MIN(sp.first_seen)) ASC`
      )
      .all(...sessionIds) as SessionParticipantRow[];
  },

  /**
   * Batched owner lookup for a page of sessions (avoids N+1 in the listing
   * path). Returns AT MOST ONE row per session_id. Sessions without any
   * participant row (legacy / pre-multi-user) simply do not appear in the
   * result, and the caller falls back to a null owner.
   *
   * B-478 — "at most one" used to be a claim, not a property: the query had no
   * grouping, and 93 sessions on the fixture DB carried two owner rows, so the
   * caller (which writes each row into a Map inside a loop, last write winning)
   * rendered whichever row SQLite happened to return second. A unique index now
   * makes duplicates impossible going forward, and the lowest-user_id tiebreak
   * below keeps this query total even on a node whose data predates the repair —
   * stable across calls and across machines, unlike SQLite's scan order.
   *
   * Deliberately NOT filtered by attribution: this feeds the owner BADGE, and an
   * externally-created conversation should still show whose data dir it came
   * from. Naming is not consenting (ADR-104).
   */
  getOwnersBySessionIds(sessionIds: string[]): SessionOwnerRow[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT
           sp.session_id AS sessionId,
           sp.user_id    AS userId,
           u.username    AS username,
           u.avatar_url  AS avatarUrl
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.role = 'owner'
           AND sp.session_id IN (${placeholders})
           AND sp.user_id = (
             SELECT MIN(dup.user_id) FROM session_participants dup
             WHERE dup.session_id = sp.session_id AND dup.role = 'owner'
           )`
      )
      .all(...sessionIds) as SessionOwnerRow[];
  },

  /**
   * Batched participant lookup for a page of sessions: EVERY human on each
   * session, not just the owner. Same one-query shape as
   * {@link getOwnersBySessionIds} (no N+1 in the listing path), keyed by
   * session_id on the caller's side.
   *
   * Ordered owner-first then by first appearance, so a page render can slice
   * the head of each session's list without re-sorting — and the avatar stack
   * shows the same face first as the session's own participants bar.
   */
  getParticipantsBySessionIds(sessionIds: string[]): SessionParticipantsListRow[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT
           sp.session_id AS sessionId,
           sp.user_id    AS userId,
           u.username    AS username,
           u.avatar_url  AS avatarUrl,
           sp.role       AS role,
           sp.last_seen  AS last_seen
         FROM session_participants sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.session_id IN (${placeholders})
         ORDER BY sp.session_id,
                  CASE sp.role WHEN 'owner' THEN 0 ELSE 1 END,
                  datetime(sp.first_seen) ASC`
      )
      .all(...sessionIds) as SessionParticipantsListRow[];
  },

  /**
   * Distinct project paths in which the given user participates (as owner or
   * participant) in at least one session. Used by the projects listing to set a
   * per-project "current user participates" flag without filtering the list.
   * One set-based query joined through sessions — no per-project lookups.
   *
   * Counts attribution='spawn' rows only (ADR-104). This is a display flag, not
   * an access decision, but it answers "did I take part here?" — and an inferred
   * row means the server associated a conversation with someone, which is not
   * taking part. Before the repair this flag marked the platform owner as a
   * member of every project on the install.
   */
  getProjectPathsForUser(userId: number): string[] {
    if (!Number.isInteger(userId)) {
      return [];
    }

    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT DISTINCT s.project_path AS projectPath
         FROM session_participants sp
         JOIN sessions s ON s.session_id = sp.session_id
         WHERE sp.user_id = ?
           AND sp.attribution = 'spawn'
           AND s.project_path IS NOT NULL`
      )
      .all(userId) as Array<{ projectPath: string | null }>;

    return rows
      .map((row) => row.projectPath)
      .filter((projectPath): projectPath is string => typeof projectPath === 'string' && projectPath.length > 0);
  },

  /**
   * Distinct session ids the given user has access to — as a participant/owner
   * (session_participants) OR as the recorded author of at least one message
   * (message_authors). This is the per-user, set-based INVERSE of
   * {@link isParticipant}: the same two-branch access model (B-105), returned as
   * the full id set instead of a single yes/no. Used by the app-level workflow
   * status endpoint (T-53-B3) so a caller is only ever shown workflow liveness
   * for sessions it actually belongs to — an unowned session's id never leaves
   * this query.
   *
   * ADR-104 — the participant branch is restricted to attribution='spawn', for
   * the same reason as {@link isParticipant}: this set scopes agent status,
   * workflow status and per-user COST, and an inferred row would put another
   * member's conversation (and its bill) inside someone's own scope.
   *
   * Fail-closed by construction: a non-integer userId (anonymous / unresolved)
   * matches nothing and returns []. A different user only ever sees their own
   * session ids because the `user_id = ?` predicate is bound on BOTH branches —
   * there is no cross-user leakage. Uses prepared statements only; the UNION
   * de-duplicates ids that appear in both tables.
   */
  getSessionIdsForUser(userId: number): string[] {
    if (!Number.isInteger(userId)) {
      return [];
    }

    const db = getConnection();
    // ORDERING IS PART OF THE CONTRACT (B-2xx): both callers that cap the scan
    // (workflow-status.service, agent-status.service) slice the FIRST N ids, so an
    // unordered UNION — whose row order is an artifact of de-duplication on the
    // UUID text — silently decides which sessions are ever inspected. Measured on
    // the fixture DB: the owner's ACTIVE session sat at rank 201 of 278 under the bare
    // UNION, i.e. outside the 200 cap, so its workflows were never scanned at all.
    // Ordering by real activity puts live sessions first (same session measured at
    // rank 5 after this change).
    //
    // LEFT JOIN, never an inner JOIN: two of the owner's session ids have no row in
    // `sessions` at all, and an inner join would drop them from the RETURNED SET —
    // a silent membership change that would also corrupt per-user cost isolation
    // (session-cost.service consumes this same set). The set must stay identical;
    // only its order changes. NULL timestamps sort last under DESC in SQLite, and
    // the id tiebreak keeps the order total (no nondeterminism between calls).
    const rows = db
      .prepare(
        `SELECT ids.sessionId AS sessionId
         FROM (
           SELECT sp.session_id AS sessionId
           FROM session_participants sp
           WHERE sp.user_id = ?
             AND sp.attribution = 'spawn'
           UNION
           SELECT ma.session_id AS sessionId
           FROM message_authors ma
           WHERE ma.user_id = ?
         ) ids
         LEFT JOIN sessions s ON s.session_id = ids.sessionId
         ORDER BY COALESCE(s.updated_at, s.created_at) DESC, ids.sessionId ASC`
      )
      .all(userId, userId) as Array<{ sessionId: string | null }>;

    return rows
      .map((row) => row.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0);
  },

  /**
   * الخطّ الزمني لمؤلِّفي مطالبات محادثة، مرتَّباً تصاعدياً، ومعه مالكها.
   *
   * هذا **أساس نسبة الكلفة إلى مستخدم بعينه**. قبله كانت كلفة المحادثة كاملةً
   * تُنسب إلى كل مشارك فيها، فمن دخل غرفةً بعد أن أُنفق فيها المال يُحمَّل ذلك
   * المال: قِيس على الإنتاج (2026-07-31) أن مستخدماً استهلاكه من كيمي صفر
   * ظهرت بطاقته بـ$2.49، لأن آخر طلب كيمي في المحادثة وقع قبل دخوله بخمس
   * دقائق. والمحادثات متعدّدة المستخدمين ليست حالة نادرة: ‏100 من 291.
   *
   * `created_at` نصّ ISO بلاحقة Z ‏(يكتبه `recordMessageAuthor`)، والترتيب
   * النصّي عليه يطابق الترتيب الزمني ما دامت الصيغة واحدة — والمستهلك يحوّله
   * إلى ملّي ثانية بنفسه فلا يعتمد على ذلك في المقارنة.
   *
   * المالك يُعاد ولو خلا الجدول من صفوف: أدوارٌ سبقت أول مطالبة مسجَّلة (أو
   * محادثة قُيدت من الطرفية بلا مرور بواجهة نسّاج) تُنسب إليه، وهو أقرب
   * الحقائق المتاحة — لا «غير منسوب» يُسقط المبلغ من كل البطاقات.
   */
  getSessionAttribution(sessionId: string): {
    ownerUserId: number | null;
    timeline: Array<{ userId: number; atMs: number }>;
  } {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ownerUserId: null, timeline: [] };
    }

    const db = getConnection();

    const owner = db
      .prepare(
        `SELECT user_id AS userId
           FROM session_participants
          WHERE session_id = ?
          ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, first_seen ASC
          LIMIT 1`
      )
      .get(sessionId) as { userId: number } | undefined;

    const rows = db
      .prepare(
        `SELECT user_id AS userId, created_at AS createdAt
           FROM message_authors
          WHERE session_id = ?
          ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<{ userId: number; createdAt: string }>;

    const timeline: Array<{ userId: number; atMs: number }> = [];
    for (const row of rows) {
      const atMs = Date.parse(row.createdAt);
      // صفّ بطابع غير صالح لا يُقحَم في الخطّ: إقحامه بـNaN يكسر الترتيب
      // فيَنسب أدواراً إلى المؤلِّف الخطأ صامتاً.
      if (Number.isFinite(atMs) && Number.isInteger(row.userId)) {
        timeline.push({ userId: row.userId, atMs });
      }
    }
    timeline.sort((a, b) => a.atMs - b.atMs);

    return { ownerUserId: owner?.userId ?? null, timeline };
  },
};
