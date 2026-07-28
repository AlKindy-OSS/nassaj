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
    api_key TEXT UNIQUE NOT NULL,
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

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'public',
    created_by INTEGER
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
 * session_participants — records every authenticated human user who has
 * spawned a run inside a session. The first participant is flagged 'owner';
 * subsequent users are 'participant'. message_count is a coarse activity
 * counter incremented on each spawn.
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
    PRIMARY KEY (session_id, agent_name, agent_kind),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

/**
 * session_agents_meta — freshness sentinel for session_agents_cache. Stores the
 * transcript file mtime at last parse so getSessionAgents can skip re-parsing
 * an unchanged transcript.
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
 * status ∈ { pending, executing, failed }. A SUCCESSFUL execution DELETES the
 * row (there is no stored 'success' state); a failure keeps the row as 'failed'
 * with the error for visibility. Lifecycle transitions are CAS-guarded so a
 * concurrent/duplicate execute cannot double-run an action.
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
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME
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
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
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
