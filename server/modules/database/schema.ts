export { USAGE_STATISTICS_V3_TABLES_SCHEMA_SQL } from './usage-statistics-v3.migration.js';

const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
`;

/**
 * audit_log — append-only record of security-relevant auth events.
 * Never stores passwords, tokens, or raw PII; metadata is sanitized JSON.
 */
export const AUDIT_LOG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    metadata TEXT,
    ip_address TEXT,
    user_agent TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
`;

/**
 * invites — invite-only registration tokens. Only the SHA-256 hash of the
 * token is stored (token_hash); the plaintext token is shown once at creation.
 * status: pending | accepted | revoked. Expiry enforced at acceptance time.
 */
export const INVITES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    invited_by INTEGER NOT NULL,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at DATETIME NOT NULL,
    accepted_by INTEGER,
    accepted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    key_digest TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * user_ui_preferences — per-user UI preferences synced across devices (replaces
 * localStorage-only storage). Stored as a single JSON blob (preferences_json)
 * for forward-compatibility: the frontend owns the schema/contract, so new
 * preference keys can be added without a server migration. Mirrors
 * user_notification_preferences in shape and lifecycle.
 */
export const USER_UI_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_ui_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Durable user-owned messages dispatched into an existing conversation later.
 * Prompt content belongs here (the feature's primary data), but must never be
 * copied into audit_log. Runtime paths and credentials are deliberately absent:
 * both are resolved again from authoritative state when the message is due.
 */
export const SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '{}',
    scheduled_for TEXT NOT NULL,
    available_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'sent', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    lease_token TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
)
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    detected_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'public',
    created_by INTEGER,
    logo_url TEXT,
    dir_exists INTEGER,
    dir_checked_at TEXT
);
`;

/**
 * project_members — explicit membership of a project (B-PRIV).
 *
 * Backs the "private project" feature: a private project is only visible to its
 * creator (projects.created_by), users explicitly listed here, and users
 * derived from session_participants. There is NO platform-owner override on
 * visibility — by owner decision, privacy is absolute and even the platform
 * owner cannot see a private project's content unless they are a member.
 *
 * role: 'owner' (can manage visibility + members) | 'member' (read access only).
 * added_by records who granted the membership (nullable; users.id).
 *
 * NOTE: created via migration (migrateProjectMembers), NOT in INIT_SCHEMA_SQL.
 * Its index likewise lives only in the migration (see the 502 lesson where
 * indexing migration-added structures at init broke fresh boots).
 */
export const PROJECT_MEMBERS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    added_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    custom_name TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    -- ADR-088 (B-258/B-262): the engine axis of a Claude-body session, written
    -- from the RESOLVED spawn verdict only (never from the client's request).
    -- Three states: 'anthropic' (official), an engine id ('kimi'/'glm'), or
    -- NULL = UNKNOWN. NULL never means official — legacy rows predate the
    -- column and some are vendor sessions. Sole writer: sessionsDb.setSessionEnginePin.
    engine_provider TEXT DEFAULT NULL,
    -- 'server_verdict' (authoritative, never downgraded) or 'inferred'
    -- (transcript backfill, upgradable by a later server_verdict).
    engine_provider_source TEXT DEFAULT NULL,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

/**
 * Upgrade compatibility ledger for session workspace isolation. This table is
 * migration-created on purpose: the migration takes one immutable snapshot of
 * sessions that predate the overlay cutover. Absence from the ledger therefore
 * means "created after cutover", never an invitation to infer legacy status.
 */
export const SESSION_WORKSPACE_MODES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_workspace_modes (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('legacy_shared', 'overlay')),
    project_path TEXT NOT NULL,
    provider TEXT NOT NULL,
    classified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * session_participants — records every authenticated human user who has
 * spawned a run inside a session. The first participant is flagged 'owner';
 * subsequent users are 'participant'. message_count is a coarse activity
 * counter incremented on each spawn.
 *
 * `attribution` answers a SEPARATE question from `role` (ADR-104):
 *
 *   role        — where does this human stand in the conversation? (owner /
 *                 participant). Drives display order and the owner badge.
 *   attribution — where did this ROW come from? 'spawn' means an authenticated
 *                 human started a run through this server, so the row carries
 *                 their CONSENT. 'provenance' means the server inferred the row
 *                 from data provenance (an externally-created session found in
 *                 a data dir, or the historical backfill) — it attributes, and
 *                 grants nothing.
 *
 * The two are orthogonal on purpose: "owner inferred from provenance" is a real,
 * necessary state (an externally-created session must show a name and must carry
 * a cost bucket) that a third `role` value could not express without also
 * granting consent. Collapsing them is what let a display-only backfill hand out
 * `restamp` rights on 93 sessions — see B-476.
 *
 * Consent readers (isParticipant, isProjectWritableByUser, getSessionIdsForUser)
 * MUST filter to 'spawn'. Attribution readers (the native-session predicate, the
 * cost owner lookup, the participants bar) MUST NOT — they need the row counted.
 *
 * NOTE: created via migration (migrateParticipantsAndAgents), NOT included in
 * INIT_SCHEMA_SQL. Its indexes likewise live only in the migration.
 */
export const SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_participants (
    session_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'participant',
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    attribution TEXT NOT NULL DEFAULT 'spawn',
    PRIMARY KEY (session_id, user_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * message_authors — per-message sender attribution for multi-user sessions
 * (B-MU-UX-FIX-MSG-AUTHOR). One row is written on the run path for every user
 * prompt an authenticated user sends; history loads join user-authored text
 * messages back to their author by (session_id, content_hash) plus timestamp
 * proximity. The transcript .jsonl itself is written by the provider CLI/SDK
 * (not by this server), so authorship cannot be embedded in the transcript
 * line without breaking format compatibility — this table is the sidecar.
 *
 * No FK on session_id on purpose: the run path can outrace the session
 * synchronizer (the sessions row may not exist yet at spawn time) and stale
 * rows for deleted sessions are harmless (matched by session_id only).
 * Messages recorded before this table existed simply have no row — the
 * frontend treats a missing userId as "unknown author" and falls back.
 *
 * NOTE: created via migration (migrateMessageAuthors), NOT in INIT_SCHEMA_SQL.
 */
export const MESSAGE_AUTHORS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS message_authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Immutable per-turn coordination metadata. Kept outside provider transcripts
 * so the user's recorded text remains byte-identical. The authenticated user
 * and browser-generated correlation id make the row an auditable sidecar; the
 * canonical content permits exact, non-pattern-based history repair; user id,
 * provider, accepted order, and timestamp constrain attachment when prompts repeat.
 */
export const MESSAGE_COORDINATION_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS message_coordination_ingress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    client_msg_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    canonical_content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    coordination_level TEXT NOT NULL CHECK (coordination_level IN ('direct', 'delegate', 'delegate_review')),
    lifecycle_status TEXT NOT NULL DEFAULT 'claimed'
      CHECK (lifecycle_status IN ('claimed', 'started', 'not_started', 'terminal')),
    verdict_json TEXT,
    accepted_at TEXT,
    claude_user_uuid TEXT CHECK (claude_user_uuid IS NULL OR (provider = 'claude' AND length(claude_user_uuid) = 36)),
    claude_payload_sha256 TEXT CHECK (claude_payload_sha256 IS NULL OR (length(claude_payload_sha256) = 64 AND claude_payload_sha256 NOT GLOB '*[^0-9a-f]*')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Durable identity and fencing records for the provider-neutral turn
 * supervisor.  The tables intentionally live beside (rather than inside)
 * message_coordination_ingress while the legacy dispatch paths are migrated:
 * ingress remains the immutable UI metadata sidecar, whereas these rows own
 * execution identity and compare-and-swap epochs.
 */
export const TURN_SUPERVISOR_TABLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turn_supervisor_turns (
    turn_id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    client_msg_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    session_id TEXT,
    state TEXT NOT NULL DEFAULT 'accepted'
      CHECK (state IN ('accepted', 'running', 'terminal')),
    epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    terminal_outcome TEXT
      CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('succeeded', 'failed', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, client_msg_id),
    CHECK ((state = 'terminal') = (terminal_outcome IS NOT NULL)),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS turn_supervisor_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    turn_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    state TEXT NOT NULL DEFAULT 'claimed'
      CHECK (state IN ('claimed', 'dispatching', 'running', 'terminal')),
    epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    terminal_outcome TEXT
      CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('succeeded', 'failed', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (turn_id, attempt),
    CHECK ((state = 'terminal') = (terminal_outcome IS NOT NULL)),
    FOREIGN KEY (turn_id) REFERENCES turn_supervisor_turns(turn_id) ON DELETE CASCADE
);
`;

/**
 * response_turn_metrics — durable, server-attested timing for a completed
 * assistant reply.  Transcript formats belong to their providers and cannot
 * safely carry Nassaj fields, so this deliberately small sidecar is keyed by
 * the provider's stable normalized assistant message id.  Browser correlation
 * ids are intentionally absent: they are live transport details, not history
 * identity.  Cancelled and failed runs never create a row.
 */
export const RESPONSE_TURN_METRICS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS response_turn_metrics (
    turn_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 2592000000),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, assistant_message_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

/**
 * Active Turn Supervisor resource reservations. A row remains active until a
 * trusted exit proof is recorded; heartbeat expiry alone never releases host
 * capacity. Millisecond integer timestamps make watchdog comparisons exact.
 * Created by migration only (indexes also live in migrations.ts).
 */
export const TURN_RESOURCE_LEASES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turn_resource_leases (
    lease_id TEXT PRIMARY KEY NOT NULL,
    turn_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
    cpu_reserved REAL NOT NULL CHECK (cpu_reserved >= 0),
    memory_reserved REAL NOT NULL CHECK (memory_reserved >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
    created_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL,
    exit_proof_at_ms INTEGER,
    exit_proof_kind TEXT CHECK (exit_proof_kind IN ('process_exit', 'process_dead', 'adapter_terminal', 'dispatch_not_started')),
    released_at_ms INTEGER,
    CHECK (status = 'active' OR (exit_proof_at_ms IS NOT NULL AND released_at_ms IS NOT NULL))
);
`;

/**
 * session_agents_cache — parsed-on-demand inventory of the non-human actors in
 * a session transcript: the base model ('model') and any spawned subagents
 * ('subagent'). Populated by the transcript parser and keyed so repeated parses
 * upsert counts rather than duplicate rows.
 *
 * The session_id FK with ON DELETE CASCADE is declared HERE and not only in
 * migrateSessionAgentsCascade: when this constant omitted it, every fresh
 * install created the table without the constraint, so the very next boot saw a
 * missing CASCADE and ran the full DROP/RENAME rebuild — pushing every clean
 * install through the table-rebuild path for no reason. Declaring the FK up
 * front makes that migration the no-op it is supposed to be on a new database.
 *
 * NOTE: created via migration only.
 */
export const SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_agents_cache (
    session_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    invocation_count INTEGER DEFAULT 1,
    agent_model TEXT DEFAULT NULL,
    -- T-1144: the answering provider's wire fingerprint ('anthropic' |
    -- 'moonshot' | 'zai' | 'deepseek' | 'openai-compatible' | 'unknown'),
    -- derived from the response envelope at parse time — never guessed.
    agent_provider TEXT DEFAULT NULL,
    -- B-352: the parser's own ordering (for models: first-answered first), so a
    -- cache hit and a fresh parse present the same sequence.
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, agent_name, agent_kind),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

/**
 * session_agents_meta — freshness sentinel for session_agents_cache. Stores the
 * transcript file mtime at last parse so getSessionAgents can skip re-parsing
 * an unchanged transcript.
 *
 * The stored value is mtime folded with a parser EPOCH (transcript-parser.js,
 * `cacheKeyFor`), not a bare mtime: a shape change in the parsed rows must
 * invalidate cached rows even for a transcript whose mtime will never move
 * again. Treat this column as an opaque key, not a timestamp.
 *
 * Carries the same session_id FK as session_agents_cache, and for the same
 * reason: without it a fresh install is immediately eligible for the
 * migrateSessionAgentsCascade rebuild.
 *
 * NOTE: created via migration only.
 */
export const SESSION_AGENTS_META_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_agents_meta (
    session_id TEXT PRIMARY KEY,
    transcript_mtime INTEGER NOT NULL,
    parsed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

/**
 * webauthn_credentials — registered passkeys (WebAuthn credentials) per user.
 * id is the credential ID as a base64url string (what the authenticator returns
 * and what login responses are looked up by). public_key is the COSE public key
 * bytes used to verify assertion signatures; counter backs clone detection.
 * transports is a JSON array of hint strings (e.g. ["internal","hybrid"]).
 *
 * NOTE: created via migration (migrateWebAuthnCredentials), NOT included in
 * INIT_SCHEMA_SQL. Its index likewise lives only in the migration.
 */
export const WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    device_type TEXT,
    backed_up INTEGER NOT NULL DEFAULT 0,
    aaguid TEXT,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * starred_sessions — per-user "favorite/pin" flag for a session, so a user can
 * mark sessions they want to return to. Star is PER USER (composite primary key
 * user_id + session_id): the same session may be starred by some users and not
 * others. project_name records the providerless project identifier the frontend
 * already uses for the session, stored alongside so the starred list can be
 * rendered without re-joining through projects/sessions.
 *
 * No FK on session_id on purpose (mirrors message_authors): the session row may
 * be synchronized lazily and stars must survive transient absence; a star whose
 * session no longer exists is harmless and filtered at read time by the caller.
 * user_id keeps its FK with ON DELETE CASCADE so deleting a user clears stars.
 *
 * NOTE: created via migration (migrateStarredSessions), NOT in INIT_SCHEMA_SQL.
 * Its index likewise lives only in the migration (see the 502 lesson).
 */
export const STARRED_SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS starred_sessions (
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, session_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * closed_sessions — "this conversation is finished" marker. Unlike
 * starred_sessions this is GLOBAL, not per user (session_id is the whole
 * primary key): closing states something about the conversation itself, so
 * every project member sees the same closed row. `closed_by` records who closed
 * it and `closed_at` when, so the state is attributable rather than anonymous.
 *
 * Closing is presentation-only and reversible: reopening simply deletes the
 * row. Nothing in the resume/read path consults this table, so a closed
 * conversation still opens and continues normally.
 *
 * No FK on session_id (mirrors starred_sessions/message_authors): session rows
 * synchronize lazily and the marker must survive transient absence. `closed_by`
 * uses ON DELETE SET NULL so deleting a user leaves the conversation closed
 * (losing the attribution, not the state).
 *
 * NOTE: created via migration (migrateClosedSessions), NOT in INIT_SCHEMA_SQL.
 * Its index likewise lives only in the migration (see the 502 lesson).
 */
export const CLOSED_SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS closed_sessions (
    session_id TEXT PRIMARY KEY,
    closed_by INTEGER,
    closed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
);
`;

/**
 * provider_run_failures — سبب آخر تشغيلٍ فاشل لمحادثة، وموعد تجدّد الحصة إن كان
 * السبب نفادها (T-1191).
 *
 * **سبب وجوده:** مزوّدٌ كـagy يُعلن سبب فشله على stderr ثم يخرج بلا كتابة حرفٍ
 * واحد في نصّه (transcript). وسجلّ محادثة antigravity يُقرأ من القرص وحده
 * (`AntigravitySessionsProvider.fetchHistory` تقرأ `jsonl_path` لا غير) — فرسالة
 * الخطأ التي تُبَثّ لحظياً بعد B-394 **لا أثر لها بعد إعادة التحميل**، ويرى
 * المستخدم محادثة خاوية بلا سبب. مرصود حيّاً على الجلسة 06804bb2 يوم
 * 2026-08-02: ‏`Individual quota reached … Resets in 94h52m23s` ثم `exitCode=1`،
 * وشاشة فارغة. هذا الجدول هو المكان الوحيد الذي يملكه نسّاج ليُبقي ذلك السبب.
 *
 * **صفٌّ واحد لكل محادثة** (`session_id` هو المفتاح كلّه): المعروض هو *الحالة
 * الراهنة* لآخر تشغيل لا أرشيفُ الإخفاقات. وتشغيلٌ ناجح لاحقاً **يحذف الصفّ**
 * (`clearFailure` عند `exitCode === 0`) — بلا ذلك يبقى خطأٌ ميّت معلّقاً أسفل
 * محادثةٍ عادت تعمل، وهو تضليلٌ أسوأ من الصمت الذي جئنا نُصلحه.
 *
 * **`quota_resets_at` يقبل NULL** لأن أكثر الإخفاقات لا صلة لها بالحصة (انتهاء
 * مصادقة، نموذج غير متاح، تعذّر إطلاق). يُملأ وحده حين يحمل النصّ مهلةً
 * صريحة، ولا يُشتقّ تخميناً: مؤشّرٌ زمنيٌّ مُختلَق أسوأ من غيابه.
 *
 * لا FK على `session_id` (كـstarred_sessions وclosed_sessions): صفوف الجلسات
 * تُزامَن كسولاً، بل إن الحالة التي نسجّلها هنا هي بعينها الحالة التي **قد لا
 * يُولَد فيها صفُّ جلسة أصلاً** — فشلٌ قبل أن يُنشئ agy دماغه. مفتاحٌ أجنبيٌّ
 * هنا يرفض الصفّ في اللحظة التي هو ألزم ما يكون فيها.
 *
 * NOTE: يُنشأ بالترحيل (migrateProviderRunFailures) لا في INIT_SCHEMA_SQL،
 * وفهرسه كذلك (درس الـ502).
 */
export const PROVIDER_RUN_FAILURES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_run_failures (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    reason TEXT NOT NULL,
    exit_code INTEGER,
    quota_resets_at DATETIME DEFAULT NULL,
    failed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * session_run_outcomes — حكمُ آخر جولةٍ لمحادثة، حقيقةً **خادميّة مشتركة**
 * (B-577).
 *
 * **سبب وجوده:** حالة النهاية كانت تعيش في `localStorage` لكل متصفّح، تُكتب من
 * حمولةٍ تصل لحظة الانتهاء. فمن كان متصفّحه مغلقاً حينها — أو فتح من جهازٍ
 * آخر، أو كانت الجولة لعضوٍ آخر — **لا يرى شارة أبداً**. لقطة المالك
 * 2026-08-08: تسع محادثات أنهت عملها، صفر شارات. ومطلبُه: «هذه الشارات مرتبطة
 * بالمحادثات ومن غير المهم هي تعمل تحت أي مستخدم، أي مستخدم يجب أن يتمكن من
 * معرفة عدد المحادثات النشطة وحالتها».
 *
 * **صفٌّ واحد لكل محادثة**: المعروض هو *الحالة الراهنة* لا أرشيفُ الأحكام
 * (نفس عقد `provider_run_failures`). وبدءُ جولةٍ جديدة **يحذف الصفّ** — حكمٌ
 * ميّت معلّقٌ على محادثةٍ عادت تعمل تضليلٌ أسوأ من الصمت.
 *
 * **لا FK على `session_id`** (كـ`starred_sessions` و`closed_sessions`
 * و`provider_run_failures`): صفوف الجلسات تُزامَن كسولاً، بل إن الحالة التي
 * نسجّلها هي بعينها الحالة التي **قد لا يُولَد فيها صفُّ جلسة أصلاً** — فشلٌ
 * قبل أن يُنشئ المزوّد دماغه. مفتاحٌ أجنبيٌّ هنا يرفض الصفّ في اللحظة التي هو
 * ألزم ما يكون فيها.
 *
 * **ولا عمود لهوية من شغّل الجولة**: المالك قال «من غير المهم هي تعمل تحت أي
 * مستخدم». وحقلُ هويةٍ بلا مستهلك يُغري لاحقاً باستعماله في قرار وصول — وهو
 * درسٌ مسجَّل (‏`session_participants` ليس دليل من تكلّم).
 *
 * **ولا `project_path` مُكرَّراً**: الفلترة بالانضمام إلى `sessions`. تكرارُه
 * حقلٌ يتعفّن عند إعادة تسمية المشروع، والتعفّن هنا **تسريبُ رؤية**.
 *
 * NOTE: يُنشأ بالترحيل (migrateSessionOutcomes) لا في INIT_SCHEMA_SQL، وفهرسه
 * كذلك (درس الـ502).
 */
export const SESSION_RUN_OUTCOMES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_run_outcomes (
    session_id TEXT PRIMARY KEY,
    outcome TEXT NOT NULL,
    outcome_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    provider TEXT,
    global_seen_at DATETIME DEFAULT NULL
);
`;

/**
 * session_outcome_reads — جدول القراءة الشخصية القديم (B-577).
 *
 * «انتهت» حقيقةٌ مشتركة، و«رأيتُها» شخصية. ودمجُهما في مدخلةٍ واحدة هو عطبُ
 * اليوم: فتحُ المحادثة كان **يحذف الحقيقة نفسها** فتضيع عن بقية الأعضاء.
 *
 * **القيمة زمنٌ لا بوليان**: جولةٌ جديدة تُنتج `outcome_at` أحدث فتُلغي إقرار
 * **كل** المستخدمين تلقائياً بلا كتابةٍ واحدة. والبوليان يفرض مسحاً بعدد
 * الأعضاء عند كل نهاية جولة — كتابةٌ تتضخّم مع نموّ الفريق على أسخن مسار.
 *
 * **وفي القاعدة لا في المتصفّح**: `localStorage` يفشل في «جهازٍ جديد» و«نافذةٍ
 * خاصة» فشلاً معكوساً لعطب اليوم — اليومَ لا شارة أبداً، وهناك جدارُ شاراتٍ
 * كاذبة عن كل ما انتهى منذ الأزل. وكلاهما يقتل الثقة بالمؤشّر، وهي كل الميزة.
 *
 * أبقيناه لترحيلٍ متوافق فقط. منذ T-1340 صار الإقرار عالمياً في
 * `session_run_outcomes.global_seen_at`، ولا يقرأ التطبيق هذا الجدول ولا يكتب فيه.
 */
export const SESSION_OUTCOME_READS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_outcome_reads (
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    seen_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, session_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * session_tombstones — شاهدُ أن المحادثة حُذفت عن قصد (ADR-120).
 *
 * حذفُ صفّ الجلسة **لا يحذف المحادثة**: تسعة عشر موقعاً تستطيع إنشاء الصفّ،
 * ستةَ عشرَ منها عبر `createSession`، والمزامنةُ الكاملة تعمل عند الإقلاع وعند
 * **كل** `GET /api/projects` وعند **كل** `GET /api/projects/archived` (والأخير
 * بلا خيار تخطٍّ). فالصفُّ المحذوف الذي بقي نصُّه على القرص يعود خلال ثوانٍ —
 * ويعود **مغلقاً وبلا مالك**، لأن `closed_sessions` ينجو بينما يتتالى
 * `session_participants` فيزول.
 *
 * فالشاهدُ هو الحذفُ نفسه: صفُّ `sessions` مخزنٌ مؤقّت، وهذا الجدول هو القرار.
 * ‏`createSession` يستشيره **داخل معاملته** فيرفض البعث.
 *
 * **وليس ابناً لـ`sessions` عمداً:** الصفُّ موجودٌ لأن صفَّ الجلسة غير موجود.
 * قيدٌ هنا يُفشل الإدراج، و`ON DELETE CASCADE` يقتل الشاهد مع الجلسة — أي عكس
 * غرضه تماماً. وعليه أن ينجو من `rebuildSessionsTableWithProjectSchema` الذي
 * يعيد البناء تحت `PRAGMA foreign_keys = OFF`، وهي الآلية نفسها التي أنتجت
 * أيتام `session_participants`.
 *
 * **ولا عنوان فيه ولا محتوى:** الشاهد يعيش أبداً، فكلُّ ما يوضع فيه ينجو من
 * «الحذف» — وذلك يجعل الحذف كذبة. العنوان يعيش في صفّ التدقيق (نافذة 90 يوماً):
 * ذاك هو الأثر الجنائي، وهذا هو الحارس.
 *
 * **قاعدة التقليم — «زوال الأثر» لا العمر:** يجوز حذف الشاهد إذا وفقط إذا
 * اجتمعت الأربعة: ‏`source_path IS NOT NULL` (وإلا فالمخزن الباعث قاعدةُ مزوّدٍ
 * مشتركة لا نملكها — ‏28 صفّاً اليوم بلا مسار)، والملفُ غير موجود، وجذرُ مراقبة
 * المزوّد موجودٌ ومقروء لحظة الفحص (وإلا فـ«غاب الملف» تعني «القرص غير موصول»)،
 * و`deleted_at` أقدم من 30 يوماً. **والتقليم بالعمر وحده يُعيد العطب.**
 *
 * NOTE: يُنشأ بترحيل (migrateSessionTombstones) لا في INIT_SCHEMA_SQL، وفهارسه
 * كذلك في الترحيل وحده (درس الـ502).
 */
export const SESSION_TOMBSTONES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_tombstones (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    project_path TEXT,
    source_path TEXT,
    deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_by INTEGER,
    FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL
);
`;

/**
 * project_cost_daily — السجلّ الدائم لكلفة كل مشروع، يوماً بيوم (ADR-078).
 *
 * سبب وجوده كجدول لا كحساب لحظي: كلود يكنس سجلّاته بعد ~30 يوماً، فالكلفة
 * المحسوبة من القرص **تختفي مع الملف**. هذا الجدول هو الأثر الباقي: صفٌّ كُتب
 * مرّة لا يُحذف لأن مصدره اختفى — وذلك بالضبط العطب الذي وُجدت الميزة لمنعه.
 *
 * **مفتاح الصفّ يحمل `source_key` وهذا انحرافٌ مقصود** عن الشكل المقترح
 * `(project_id, day, vendor, model)`: صفّ اليوم الواحد يتغذّى من عشرات
 * السجلّات، والمسح **تزايدي** (يُعاد قراءة ما تغيّر وحده). فلو كان المفتاح
 * بلا مصدر لصار أمام كل إعادة مسح خياران كلاهما فاسد: ‏`REPLACE` بقيمة ملف
 * واحد فتُمحى مساهمة بقيّة الملفات، أو `cost = cost + x` فتتضخّم الكلفة مع كل
 * مسح. بحمل المصدر في المفتاح تصير إعادة المسح **حذفاً لصفوف ذلك المصدر ثم
 * إدراجاً لقيمته المُعاد حسابها** — عملية عديمة الأثر تماماً مهما تكرّرت،
 * والتجميع (‏SUM … GROUP BY day) يقع وقت القراءة. الحجم يبقى صغيراً: صفّ لكل
 * (سجلّ، يوم، نموذج) ≈ بضعة آلاف في السنة على هذا التثبيت.
 *
 * `project_id` و`project_path` معاً عمداً: المشروع قد يُحذف صفّه من `projects`
 * ثم يُسجَّل ثانيةً بمُعرِّف جديد، فالمسار هو الجسر الذي يُعيد وصل التاريخ.
 *
 * `priced = 0` تعني «هذا النموذج بلا سعر رسمي» و`cost_usd` حينها **ليست صفر
 * إنفاق** بل غياب سعر — تُعرَض جزئيةً لا مجموعاً مؤكَّداً (قاعدة الصدق في
 * ADR-078). و`assumed = 1` تعني سعراً مفترَضاً لا رسمياً.
 *
 * لا مفتاح أجنبي على `project_id`: الحذف من `projects` يجب ألّا يُسقط التاريخ.
 *
 * NOTE: created via migration (migrateProjectCostLedger), NOT in
 * INIT_SCHEMA_SQL. Its indexes likewise live only in the migration (the 502
 * lesson).
 */
export const PROJECT_COST_DAILY_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_cost_daily (
    source_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_path TEXT,
    day TEXT NOT NULL,
    vendor TEXT NOT NULL,
    model TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT '',
    cost_usd REAL NOT NULL DEFAULT 0,
    priced INTEGER NOT NULL DEFAULT 1,
    assumed INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    prices_as_of TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_key, day, vendor, model, harness)
);
`;

/**
 * علامة مائية لكل سجلّ مُمسوح: (المسار + آخر تعديل + الحجم). وجودها هو ما
 * يجعل المسح تزايدياً — ملف لم يتغيّر لا يُفتح ثانية، فلا يُعاد قراءة آلاف
 * الملفات في كل استدعاء.
 *
 * تُحدَّث في **نفس معاملة** كتابة صفوف مصدرها: علامة تُكتب قبل الصفوف تعني
 * ملفاً يُتخطّى إلى الأبد وكلفتُه لم تُسجَّل قط.
 */
export const PROJECT_COST_SOURCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_cost_sources (
    source_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Incremental usage-ingestion state. This is deliberately independent from
 * project_cost_sources: the latter is a whole-file cost-ledger watermark,
 * while this cursor supports append-only reads, rotation and partial JSONL.
 */
export const USAGE_SOURCE_CHECKPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_source_checkpoints (
    source_key TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    source_path TEXT NOT NULL,
    device_id TEXT,
    inode TEXT,
    offset_bytes INTEGER NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0),
    partial_tail TEXT NOT NULL DEFAULT ''
      CHECK (length(CAST(partial_tail AS BLOB)) <= 262144),
    parser_version INTEGER NOT NULL CHECK (parser_version >= 0),
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    status TEXT NOT NULL DEFAULT 'ready'
      CHECK (status IN ('ready', 'processing', 'error', 'retired')),
    last_error TEXT,
    observed_size_bytes INTEGER CHECK (observed_size_bytes IS NULL OR observed_size_bytes >= 0),
    observed_mtime_ms INTEGER CHECK (observed_mtime_ms IS NULL OR observed_mtime_ms >= 0),
    boundary_hash TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** Logical, pricing-free request facts. Physical provenance lives separately. */
export const USAGE_REQUEST_EVENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_request_events (
    session_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    attribution_kind TEXT NOT NULL DEFAULT 'unattributed'
      CHECK (attribution_kind IN ('coordinator', 'agent', 'user', 'unattributed', 'ambiguous')),
    attribution_id TEXT NOT NULL DEFAULT '',
    attribution_scope TEXT NOT NULL DEFAULT 'conversation'
      CHECK (attribution_scope IN ('conversation', 'agent', 'user')),
    occurred_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    project_path TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_5m_tokens >= 0),
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_1h_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    output_max INTEGER CHECK (output_max IN (0, 1)),
    is_subagent INTEGER NOT NULL DEFAULT 0 CHECK (is_subagent IN (0, 1)),
    attribution_confidence REAL
      CHECK (attribution_confidence IS NULL OR (attribution_confidence >= 0 AND attribution_confidence <= 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, request_key, attribution_kind, attribution_id, attribution_scope)
);
`;

/** Every physical appearance of a logical request, retained across source copies. */
export const USAGE_REQUEST_OCCURRENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_request_occurrences (
    event_id TEXT PRIMARY KEY NOT NULL,
    source_key TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
    byte_end INTEGER NOT NULL CHECK (byte_end >= byte_start),
    session_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    attribution_kind TEXT NOT NULL,
    attribution_id TEXT NOT NULL DEFAULT '',
    attribution_scope TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_key, source_generation, byte_start, byte_end)
);
`;

/** Parent/child transcript lineage, including late-discovered subagents. */
export const USAGE_SOURCE_LINKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_source_links (
    parent_source_key TEXT NOT NULL,
    child_source_key TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('subagent', 'workflow', 'fork', 'other')),
    session_id TEXT,
    agent_id TEXT,
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (parent_source_key, child_source_key, relation, generation)
);
`;

/** Dedupe-safe intervals used to build work-duration snapshots. */
export const USAGE_DURATION_EVENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_duration_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    source_key TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
    session_id TEXT,
    project_id TEXT,
    project_path TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('request', 'tool', 'agent', 'work_interval')),
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    attribution_kind TEXT NOT NULL DEFAULT 'unattributed',
    attribution_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** Durable lifecycle for explicit rebuilds; generations never overwrite facts. */
export const USAGE_BACKFILL_GENERATIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_backfill_generations (
    generation INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version INTEGER NOT NULL CHECK (parser_version >= 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
    cursor_source_key TEXT,
    sources_total INTEGER NOT NULL DEFAULT 0 CHECK (sources_total >= 0),
    sources_processed INTEGER NOT NULL DEFAULT 0 CHECK (sources_processed >= 0),
    events_written INTEGER NOT NULL DEFAULT 0 CHECK (events_written >= 0),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** O(1) conversation-summary read model; never used as an ingestion cursor. */
export const CONVERSATION_USAGE_SNAPSHOTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_usage_snapshots (
    session_id TEXT NOT NULL,
    attribution_kind TEXT NOT NULL,
    attribution_id TEXT NOT NULL DEFAULT '',
    attribution_scope TEXT NOT NULL DEFAULT 'conversation',
    provider TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    project_path TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    snapshot_status TEXT NOT NULL DEFAULT 'initializing'
      CHECK (snapshot_status IN ('initializing', 'ready', 'stale', 'error')),
    as_of TEXT,
    measured INTEGER NOT NULL DEFAULT 0 CHECK (measured IN (0, 1)),
    ingest_complete INTEGER NOT NULL DEFAULT 0 CHECK (ingest_complete IN (0, 1)),
    pricing_complete INTEGER NOT NULL DEFAULT 0 CHECK (pricing_complete IN (0, 1)),
    request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    output_max_count INTEGER NOT NULL DEFAULT 0 CHECK (output_max_count >= 0),
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_5m_tokens >= 0),
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_1h_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
    reported_work_duration_ms INTEGER
      CHECK (reported_work_duration_ms IS NULL OR reported_work_duration_ms >= 0),
    breakdown_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, attribution_kind, attribution_id, attribution_scope)
);
`;


export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * pending_server_actions — queue of privileged host actions a Claude coordinator
 * requests and the platform owner executes from the web UI (ADR-066, T-944).
 *
 * The Claude client restart guard blocks restart-class commands only when they
 * originate from a Claude process. This queue lets a coordinator RECORD a
 * symbolic intent (action_type — a key into the server-side allowlist, NEVER a
 * shell string); the owner then executes it and THIS node server spawns the
 * fixed argv, legitimately bypassing the guard because the server is not a
 * Claude process.
 *
 * SECURITY: action_type is a symbolic key only. No column ever stores a command,
 * argv, or shell string — the executable argv is resolved from the in-code
 * allowlist (server/services/server-actions.js) at execution time.
 *
 * status ∈ { pending, executing, succeeded, failed, superseded }. QUEUE =
 * 'pending' (+ a live 'executing' row); HISTORY = the three settled states,
 * each stamped with `settled_at`. T-1684: a successful execution no longer
 * DELETES its row — it settles to 'succeeded' so the owner can still see what
 * ran; every settled row is deleted one hour after it settled (pruneHistory).
 * 'succeeded' is only ever written with real evidence (exit 0, or an OID
 * activation receipt) — an unproven outcome settles as failed/
 * `execution_unresolved`, never as success. Lifecycle transitions are
 * CAS-guarded so a concurrent/duplicate execute cannot double-run an action.
 *
 * NOTE: created via migration (migratePendingServerActions), NOT in
 * INIT_SCHEMA_SQL. Its indexes (a partial unique dedup index + a status index)
 * likewise live only in the migration (see the 502 lesson where indexing
 * migration-managed structures at init broke fresh boots).
 */
export const PENDING_SERVER_ACTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_server_actions (
    id TEXT PRIMARY KEY NOT NULL,
    action_type TEXT NOT NULL,
    session_id TEXT,
    reason TEXT,
    requested_by TEXT,
    expected_server_build_id TEXT,
    execution_attempt_nonce TEXT,
    source_update_job_id TEXT,
    source_update_transaction_id TEXT,
    activation_identity_sha256 TEXT,
    release_commit TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME,
    settled_at DATETIME
);
`;

/** Durable, generation-fenced control plane for asynchronous source updates. */
export const SOURCE_UPDATE_TABLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source_update_control (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
    fence_epoch INTEGER NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0),
    active_job_id TEXT,
    worker_id TEXT,
    pid INTEGER,
    start_ticks TEXT,
    boot_id TEXT,
    pgid INTEGER,
    lease_expires_at INTEGER,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_update_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    expected_version TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    idempotency_key_hash TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    strategy TEXT NOT NULL CHECK (strategy IN ('git-checkout-v2','release-layout-v2')),
    state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN (
      'awaiting_sessions',
      'accepted','resolving','resolved','downloading','archive_verified',
      'extracting','staging','candidate_sealed','restart_queued','activating',
      'runtime_verifying','activated','rollback_pending','rolled_back','failed',
      'superseded','manual_recovery_required','cancelled'
    )),
    worker_fence INTEGER,
    transaction_id TEXT UNIQUE,
    release_id TEXT,
    release_tag TEXT,
    release_asset_id TEXT,
    release_asset_name TEXT,
    release_asset_size INTEGER,
    release_asset_sha256 TEXT,
    archive_sha256 TEXT,
    activation_identity_sha256 TEXT,
    release_commit TEXT,
    source_tree_sha256 TEXT,
    expected_server_build_id TEXT,
    expected_client_build_id TEXT,
    progress_seq INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
    auto_activate INTEGER NOT NULL DEFAULT 0 CHECK (auto_activate IN (0, 1)),
    -- T-1730 W6: declared session deferral. Absolute wall-clock deadlines are
    -- stored as INTEGER epoch-ms (like lease_expires_at), never TEXT, because
    -- CURRENT_TIMESTAMP writes 'YYYY-MM-DD HH:MM:SS' while JS writes ISO, and a
    -- string comparison of the two in SQL is wrong.
    defer_until_idle INTEGER NOT NULL DEFAULT 0 CHECK (defer_until_idle IN (0, 1)),
    deferral_deadline_at INTEGER,
    deferral_rearm_count INTEGER NOT NULL DEFAULT 0 CHECK (deferral_rearm_count >= 0),
    idle_observed_at INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
    UNIQUE (owner_id, idempotency_key_hash)
);

CREATE TABLE IF NOT EXISTS source_update_receipts (
    job_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    worker_fence INTEGER NOT NULL CHECK (worker_fence >= 0),
    phase TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('intent','done','recovery','rollback')),
    facts_json TEXT NOT NULL DEFAULT '{}',
    facts_sha256 TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, sequence),
    FOREIGN KEY (job_id) REFERENCES source_update_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS source_update_effects (
    job_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    worker_fence INTEGER NOT NULL CHECK (worker_fence >= 0),
    effect_kind TEXT NOT NULL,
    pid INTEGER NOT NULL CHECK (pid > 0),
    start_ticks TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    pgid INTEGER NOT NULL CHECK (pgid > 0),
    state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','terminated')),
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    terminated_at DATETIME,
    PRIMARY KEY (job_id, effect_id),
    FOREIGN KEY (job_id) REFERENCES source_update_jobs(id) ON DELETE CASCADE
);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
-- NOTE: idx_users_role / idx_users_status moved to migrations.ts (migrateMultiUserAuth)
-- because the role/status columns are added there, AFTER initial schema creation.
-- Creating them here breaks fresh init on legacy DBs ("no such column: role").

${AUDIT_LOG_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

${INVITES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

${API_KEYS_TABLE_SCHEMA_SQL}
-- NOTE: idx_api_keys_digest is created by migrateApiKeysToDigests after legacy
-- plaintext tables have been rebuilt with the key_digest column.
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${USER_UI_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_ui_preferences_user_id ON user_ui_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}
`;

/**
 * user_identities — bridges an external IdP identity (issuer + subject) to a
 * local user, backing the OIDC Relying Party login flow (P-IDP-3, ADR-046).
 * The natural key is the (issuer, subject) pair: `issuer` is the IdP's `iss`
 * claim and `subject` is the stable per-IdP `sub` claim, so the same human
 * authenticating through two IdPs gets two rows pointing at one user_id. The
 * UNIQUE(issuer, subject) constraint guarantees an external identity is linked
 * to at most one local account; the link() write surfaces a violation as a
 * throw the caller maps to a conflict.
 *
 * user_id keeps its FK with ON DELETE CASCADE so deleting a user clears all of
 * their IdP links. No password is involved — this is an alternative to the
 * password_hash login path, not a replacement for it.
 *
 * NOTE: created via migration (user_identities step in runMigrations), NOT in
 * INIT_SCHEMA_SQL, and must run after `users` exists so the FK resolves.
 */
export const USER_IDENTITIES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(issuer, subject)
);`;

/**
 * governance_exemptions — the per-user, per-engine EXCEPTION list for nassaj
 * governance (owner decision 2026-08-08: "الالتزام بتعليمات نسّاج إجبار لا
 * تخيير"، with a per-harness opt-out).
 *
 * AN EXCEPTION TABLE, NOT A PREFERENCES TABLE — this is the whole design.
 * A preferences table would store a row per (user, engine) carrying
 * 'governed'|'exempt', and the default would then live in whatever code reads
 * it: a missing row, a typo'd value, a failed read or a fresh database would all
 * have to be *interpreted*, and every one of those interpretations is a place
 * where "governed" can silently become "not governed". Here the only fact
 * stored is the EXCEPTION. Absence of a row is not a default that code chooses —
 * it is the absence of an exemption, which cannot mean anything but "governed".
 * A dropped table, an empty database, an unreadable file: all of them answer
 * "no exemption found", i.e. governed. The state is fail-closed BY CONSTRUCTION,
 * not by a guard that could be forgotten.
 *
 * A row therefore reads: "this user asked that THIS engine run in its vendor
 * default, without nassaj instructions".
 *
 * granted_by is kept because the authority is ASYMMETRIC: any member may bind
 * themselves back under governance (delete their own row), but only an
 * owner/admin may create one — the governed party does not exempt itself. The
 * column is what makes "who exempted this member" answerable a year later; the
 * audit_log rows carry the same fact, and the two are cross-checkable.
 * ON DELETE SET NULL: deleting the admin who granted it must not delete the
 * exemption silently, which would flip a member back under governance with no
 * trace of why.
 *
 * NOTE: created via migration (migrateGovernanceExemptions), NOT in
 * INIT_SCHEMA_SQL, and must run after `users` exists so both FKs resolve.
 */
export const GOVERNANCE_EXEMPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS governance_exemptions (
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    granted_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, provider),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);`;

/**
 * provider_credential_grants — user-to-user credential delegation (T-1675).
 *
 * The base state of every provider is ISOLATION: each member runs on their own
 * credential tree. A row here is the one exception a member can create
 * themselves: "my <provider> credential may be used by <grantee>". The grantee
 * then runs on the OWNER's tree (or injected key) instead of their own, until
 * either side ends it — the owner by deleting the row, the grantee by setting
 * `declined_at` (which keeps the row so the owner still sees whom they offered
 * it to, and lets the grantee pick it back up without asking again).
 *
 * One row per (owner, grantee, provider). A grantee holding several grants for
 * one provider uses at most one (the earliest non-declined one); the rest stay
 * offered. No transitive delegation: a grantee's grants are never re-shared.
 *
 * NOTE: created via migration (migrateProviderCredentialGrants), NOT in
 * INIT_SCHEMA_SQL, and must run after `users` exists so both FKs resolve.
 */
export const PROVIDER_CREDENTIAL_GRANTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_credential_grants (
    owner_user_id INTEGER NOT NULL,
    grantee_user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    declined_at DATETIME,
    PRIMARY KEY (owner_user_id, grantee_user_id, provider),
    CHECK (owner_user_id <> grantee_user_id),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (grantee_user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

/**
 * External platform connectors (T-1226, ADR-098).
 *
 * WHAT THIS IS. One row per external platform the operator has connected —
 * Canva, Wafeq, Google, anything with an API key. The row is the REGISTRY entry:
 * what the platform is called, how it is reached, and whether sharing is even
 * allowed for it. **The API key itself is never stored here** — it lives
 * encrypted in provider-secrets-store under the `connector` namespace (T-1225).
 * Putting a secret in SQLite would put it in every backup, every `SELECT *`, and
 * every debug dump of this table; the encrypted store exists precisely so it does
 * not have to.
 *
 * WHY THERE IS NO min_role COLUMN. An earlier draft gated each connector by role
 * (owner/admin/user). The owner dropped it on 2026-08-04 (ADR-098 §1): a
 * connector is available to every nassaj member, full stop. The absence is
 * recorded here so it is not re-added in good faith later — under a shared uid
 * that gate is a UI affordance, not a boundary, and a page that promises it lies.
 *
 * credential_mode is 'org_shared' for every row today. The column exists so that
 * adding 'per_member' later is a value change, not a migration.
 *
 * allows_sharing is a property OF THE SERVICE, not a user choice: some platforms
 * (Canva among them) require each person to authenticate individually, so a
 * single shared key is a terms-of-service violation rather than a preference. A
 * row with allows_sharing = 0 is rejected at the API, not warned about.
 *
 * account_label distinguishes two connections to the SAME service ("Canva —
 * personal" vs "Canva — client"). It is part of the uniqueness key from day one
 * because retrofitting it later would mean migrating live rows.
 *
 * NOTE: created via migration (migrateConnectors in runMigrations), NOT in
 * INIT_SCHEMA_SQL, and must run after `users` exists so the created_by FK
 * resolves.
 */
export const CONNECTORS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    display_name TEXT NOT NULL,
    account_label TEXT NOT NULL DEFAULT '',
    credential_mode TEXT NOT NULL DEFAULT 'org_shared',
    owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    allows_sharing INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    args_json TEXT NOT NULL DEFAULT '[]',
    url TEXT,
    key_env_var TEXT,
    key_header TEXT,
    key_header_prefix TEXT NOT NULL DEFAULT '',
    extra_env_json TEXT NOT NULL DEFAULT '{}',
    auth_mode TEXT NOT NULL DEFAULT 'key',
    source_revision INTEGER NOT NULL DEFAULT 0
      CHECK (source_revision BETWEEN 0 AND 9007199254740991),
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    -- Uniqueness is enforced by two PARTIAL indexes in the migration, not here:
    -- SQL NULLs compare distinct, so a table-level UNIQUE spanning
    -- owner_user_id would never fire for shared rows (owner NULL) and would
    -- silently permit duplicates. See migrateConnectors.
    UNIQUE(id)
);`;

/**
 * Durable desired/applied ledger for the transitional connector fan-out.
 *
 * This is additive infrastructure only: creating the table neither backfills
 * rows nor authorizes a worker.  A placement belongs to one connector, member,
 * and proven runtime body.  Deletion is deliberately RESTRICTed so lifecycle
 * code cannot erase the evidence before cleanup has been reconciled.
 *
 * The lease is fenced twice. `fencing_token` increases on every acquisition;
 * `desired_generation` changes when the desired material changes. A future
 * writer must match both values before publishing an applied generation.
 */
export const CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_placements (
    connector_id TEXT NOT NULL,
    member_user_id INTEGER NOT NULL CHECK (member_user_id > 0),
    body_provider TEXT NOT NULL CHECK (body_provider IN ('claude', 'codex')),
    contract_version TEXT NOT NULL CHECK (contract_version = 'mcp-user-v1'),
    desired_generation INTEGER NOT NULL DEFAULT 0 CHECK (desired_generation >= 0),
    applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (applied_generation >= 0),
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'applying', 'healthy', 'degraded', 'removing', 'blocked')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_retry_at TEXT,
    last_error_code TEXT,
    desired_fingerprint_version INTEGER NOT NULL DEFAULT 0
      CHECK (desired_fingerprint_version IN (0, 1, 2)),
    desired_fingerprint TEXT NOT NULL DEFAULT '',
    desired_source_revision INTEGER NOT NULL DEFAULT -1
      CHECK (desired_source_revision BETWEEN -1 AND 9007199254740991),
    desired_present INTEGER NOT NULL DEFAULT 1 CHECK (desired_present IN (0, 1)),
    applied_fingerprint_version INTEGER
      CHECK (applied_fingerprint_version IS NULL OR applied_fingerprint_version IN (1, 2)),
    applied_fingerprint TEXT,
    lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (lease_expires_at_ms >= 0),
    fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (connector_id, member_user_id, body_provider),
    FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE RESTRICT,
    FOREIGN KEY (member_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CHECK (applied_generation <= desired_generation),
    CHECK (
      (desired_generation = 0 AND desired_fingerprint_version = 0 AND desired_fingerprint = '') OR
      (desired_generation > 0 AND desired_fingerprint_version IN (1, 2)
        AND length(desired_fingerprint) = 64
        AND desired_fingerprint NOT GLOB '*[^0-9a-f]*')
    ),
    CHECK (
      (applied_generation = 0 AND applied_fingerprint_version IS NULL AND applied_fingerprint IS NULL) OR
      (applied_generation > 0 AND applied_fingerprint_version IN (1, 2)
        AND length(applied_fingerprint) = 64
        AND applied_fingerprint NOT GLOB '*[^0-9a-f]*')
    ),
    CHECK (
      (lease_owner = '' AND lease_expires_at_ms = 0) OR
      (length(trim(lease_owner)) BETWEEN 1 AND 128
        AND lease_expires_at_ms > 0 AND fencing_token > 0)
    ),
    CHECK (state != 'applying' OR (desired_generation > 0 AND lease_owner != '')),
    CHECK (
      state != 'blocked' OR
      (last_error_code IS NOT NULL AND length(trim(last_error_code)) BETWEEN 1 AND 128)
    ),
    CHECK (
      state != 'healthy' OR
      (desired_generation > 0
        AND applied_generation = desired_generation
        AND applied_fingerprint_version = desired_fingerprint_version
        AND applied_fingerprint IS NOT NULL
        AND applied_fingerprint = desired_fingerprint)
    )
);
`;

/** Short-lived encrypted OAuth PKCE state; plaintext and the raw state never enter SQLite. */
export const CONNECTOR_OAUTH_PENDING_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_oauth_pending (
    state_hash TEXT PRIMARY KEY
      CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
    key_version INTEGER NOT NULL CHECK (key_version = 1),
    nonce BLOB NOT NULL CHECK (length(nonce) = 12),
    ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0),
    tag BLOB NOT NULL CHECK (length(tag) = 16),
    expires_at INTEGER NOT NULL CHECK (expires_at > 0),
    consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at > 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0)
);`;

/**
 * How a connector is actually REACHED (T-1228). Split out of the prose above
 * because it answers a different question than "what is this platform":
 *
 *   transport 'stdio' → `command` + `args_json` launch a local MCP server (the
 *     platform's own, or `mcp-remote`), and `key_env_var` names the environment
 *     variable that carries the secret into it.
 *   transport 'http'  → `url` is the remote MCP endpoint and `key_header` names
 *     the header that carries the secret, with `key_header_prefix` in front of
 *     it (e.g. 'Bearer ').
 *
 * The secret's NAME lives here; the secret's VALUE never does. Storing "which
 * env var" next to the platform definition is what lets one generic distributor
 * serve every platform without a per-platform adapter in code.
 */
