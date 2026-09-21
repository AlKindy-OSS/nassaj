// command-board-config.js — T-948 / ADR-067 (Phases 1–2) / ADR-072 (tier redesign)
//
// إعداد «لوحة الأوامر» المُدار من صفحة الإعدادات: يحوّل التخويل من قرارٍ
// مجمّد في الكود إلى config مخزَّن في app_config يديره المالك.
//
// ── نموذج الطبقات (ADR-072، معتمد 2026-07-26) ────────────────────────────────
// طبقةٌ واحدة مرتّبة لكل دور تحلّ محلّ (none|safe|general) + علم raw منفصل. صار
// «الوضع» والـ«raw» بُعداً واحداً مرتّباً بدل ازدواج المفتاح مع المصفوفة الذي كان
// يربك القرار (سبب B-199):
//   • none   — لا وصول.
//   • safe   — القائمة الآمنة المجمّدة (server-actions) غير المعطّلة.
//   • custom — safe + الأوامر المخصّصة (كان اسمها 'general').
//   • raw    — safe + custom + تنفيذ أي نصّ حرّ (command-board-raw.js). يجوز
//              إسنادها لأي دور صراحةً (قرار المالك 2026-07-26، ADR-072 مُعدَّل).
//
// دالّة القرار الواحدة (تلغي تعدّد دوال الفحص):
//     TIER_ORDER = { none:0, safe:1, custom:2, raw:3 }
//     capabilityForRole(role, cfg):
//         granted = canonicalizeRoleMode(role, cfg.roleModes[role])
//                   // general→custom (ترحيلٌ owner-only لـraw)؛ raw→raw لأي دور؛
//                   // مجهول/تالف→none؛ owner floor = safe
//         ceiling = (cfg.rawExecEnabled === true && لا مانع بيئي) ? 'raw' : 'custom'
//         return minTier(granted, ceiling)   // السقف يخفض فقط، لا يرفع أبداً
//     roleCanRun(role, requiredTier, cfg) = TIER_ORDER[capability] >= TIER_ORDER[required]
// كل تنفيذي يُحلّ إلى requiredTier: ثابت→'safe'، مخصّص→'custom'، raw→'raw'.
// canRoleRunAction / canRoleRunRawExec أغلفةٌ رفيعة فوق roleCanRun (تقليل الاضطراب
// في المسارات والاختبارات القائمة).
//
// مبادئ أمنية (fail-closed):
//   • غياب/تلف الـconfig → الافتراض الآمن (المالك 'safe'، الآدمن/المستخدم 'none').
//   • rawExecEnabled = سقفٌ لا مِنحة: مطفأ ⇒ السقف 'custom' ⇒ أي دور مُمنَح 'raw'
//     يُقصّ حتماً؛ إطفاؤه فعلٌ واحد يُسقط raw عن كل الأدوار فوراً (شرط B-197).
//   • raw قابلة للإسناد لأي دور صراحةً (قرار المالك 2026-07-26، ADR-072 مُعدَّل:
//     «سيبني اعطي الصلاحيات براحتي، لا تقيدني»): canonicalizeRoleMode تُبقي 'raw'
//     المخزَّنة كما هي لكل الأدوار. الكبح الوحيد هو السقف rawExecEnabled + الحارس
//     البيئي (يقصّان كل الأدوار معاً بفعلٍ واحد، لا صفّاً بعينه). مسارات raw صارت
//     مخوَّلة بالطبقة (roleCanRun(role,'raw')) بدل أرضية الدور الخشنة، مع المصادقة
//     أعلاها (authenticateToken) وإعادة الفحص في prepareRawExecution دفاعاً بعمق.
//     الأثر (قبِله المالك): أي دور يُمنح raw يشغّل أي أمر على المضيف بصلاحية مستخدم
//     الخدمة nassaj.
//   • لا ترقية ضمنية عبر الترحيل: owner=custom مع علمٍ مسلَّح يبقى 'custom' — يختار
//     المالك 'raw' صراحةً. الاستثناء الوحيد ترحيلٌ لا ترقية: الطبقة القديمة
//     owner='general' مع علمٍ مسلَّح مخزَّن كانت تملك raw فعلياً قبل ADR-072
//     (canRoleRunRawExec القديمة = rawExecEnabled===true && mode==='general')، فتُرحَّل
//     إلى 'raw' حفظاً لقدرةٍ قائمة لا منحاً جديداً — والسقف يقصّها إن أُطفئ العلم.
//     غير المالك على general لا يُرحَّل إلى raw أبداً (الترحيل الضمني owner-only)؛
//     يبلغ non-owner الطبقةَ raw فقط بإسنادٍ صريح 'raw'.
//   • هذا التخويج طبقةٌ فوق الأرضية الخشنة requireRole(...) وإلى جانب
//     roleSatisfies(minRole) في المسارات — لا يستبدلهما ولا يخفّفهما.

import { IS_PLATFORM } from '../constants/config.js';
import { appConfigDb } from '../modules/database/index.js';
import { getAction } from './server-actions.js';
import { getCustomAction } from './command-board-custom.js';

export const COMMAND_BOARD_CONFIG_KEY = 'command_board_config';

// ── raw-exec ENVIRONMENT guard (B-197) ──────────────────────────────────────
//
// THE PROBLEM THIS SOLVES. `rawExecEnabled` is a plain owner toggle, and the
// ONLY thing that makes raw exec tolerable is the owner's human review of the
// exact command. That guarantee is void in environments where "the owner" is not
// a single reviewing human — and nothing stopped the flag from being raised in
// exactly such an environment. The most concrete case (B-186 / B-5):
// VITE_IS_PLATFORM=true makes middleware/auth.js authenticate EVERY request —
// including one with no token at all — as the first user, i.e. as the owner. The
// route floor requireRole('owner'), the raw tier and every canRoleRunRawExec
// check then pass for an anonymous visitor, so raw exec degenerates into
// unauthenticated RCE.
//
// THE GUARD. Fail-closed, evaluated SERVER-SIDE at every read of the config (not
// only at boot, so a value planted directly in app_config by another process
// cannot win either):
//   • getCommandBoardConfig() forces rawExecEnabled=false while any blocker
//     holds — so the CEILING every gate derives is already 'custom'.
//   • setCommandBoardConfig() REFUSES to raise the flag with a symbolic
//     `raw_exec_blocked:<reason>` instead of silently accepting a value the
//     reader would ignore.
//   • enforceRawExecEnvironmentGuard() additionally PERSISTS the drop, so a
//     stored `true` written before the blocker appeared does not lie in the
//     settings UI.
//   • capabilityForRole() ALSO re-checks the blocker when computing the ceiling,
//     so a hand-built cfg carrying `rawExecEnabled:true` cannot mint 'raw' either.
//
// HONEST SCOPE. This closes the "flag raised in an environment that voids the
// guarantee" hole. It does NOT make human review server-ENFORCED: an attacker
// with script execution inside a live owner session can still insert → read the
// digest → execute, because every one of those is an ordinary authenticated
// request. Closing that requires a step-up (re-auth / out-of-band code) on the
// execute call, which is a UI-bearing change tracked separately in B-197.
//
/** Symbolic blocker codes (stable strings — used in API responses and i18n). */
export const RAW_EXEC_BLOCKER_IS_PLATFORM = 'is_platform';

/**
 * Environment conditions that void the human-review guarantee behind raw exec.
 * Pure; evaluated on every call so a runtime change is picked up without a
 * restart. Returns a (possibly empty) array of symbolic codes.
 * @returns {string[]}
 */
export function rawExecEnvironmentBlockers() {
  const blockers = [];
  // Platform mode authenticates every session (even token-less) as the first
  // user = the owner, collapsing owner-only into "everyone is owner".
  if (IS_PLATFORM) blockers.push(RAW_EXEC_BLOCKER_IS_PLATFORM);
  return blockers;
}

// ── Tier vocabulary (ADR-072) ────────────────────────────────────────────────

/** Ordered capability tiers. A higher rank strictly includes every lower one. */
export const TIER_ORDER = Object.freeze({ none: 0, safe: 1, custom: 2, raw: 3 });

/** The set of canonical (new-vocabulary) tiers stored/returned by this module. */
const CANONICAL_TIERS = new Set(['none', 'safe', 'custom', 'raw']);

/**
 * Accepted INPUT tokens for setCommandBoardConfig. Includes the legacy 'general'
 * (tolerated and canonicalized to 'custom' on save) so a transitional client — or
 * an existing test — is not rejected; every stored value is written in the new
 * vocabulary regardless.
 */
const VALID_INPUT_MODES = new Set(['none', 'safe', 'custom', 'raw', 'general']);
const VALID_ROLES = new Set(['owner', 'admin', 'user']);
const ALL_ROLES = ['owner', 'admin', 'user'];

/**
 * The highest tier the OWNER may ASSIGN to a role in the settings picker. ADR-072
 * AMENDED 2026-07-26 (owner decision «سيبني اعطي الصلاحيات براحتي، لا تقيدني»):
 * raw is assignable to EVERY role (owner/admin/user), reversing the earlier
 * owner-only clamp (B-199). The settings UI derives the enabled columns from this
 * map, so the 'raw' column becomes selectable for every row automatically. The
 * ONLY brake on an assigned 'raw' becoming EFFECTIVE is the armed-flag ceiling +
 * the environment guard (the ceiling in capabilityForRole), which drop raw for
 * ALL roles at once — never a per-row clip. IMPACT, explicitly accepted by the
 * owner: any role granted raw can run ANY command on the host as the `nassaj`
 * service user.
 */
export const MAX_ASSIGNABLE_TIER = Object.freeze({ owner: 'raw', admin: 'raw', user: 'raw' });

/** Returns the lower of two tiers (the ceiling can only lower, never raise). */
function minTier(a, b) {
  return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

/**
 * Canonicalizes a STORED role mode (old or new vocabulary) into a granted tier,
 * fail-closed. This is the lazy read-time migration (ADR-072) — no destructive
 * rewrite of the stored config is needed:
 *   • 'none' / 'safe' / 'custom' → unchanged.
 *   • 'general' (legacy): owner + configured-armed flag → 'raw'; otherwise → 'custom'.
 *     Rationale — under the pre-ADR-072 rule (canRoleRunRawExec = rawExecEnabled===true
 *     && mode==='general') an owner on 'general' with the armed flag GENUINELY HELD raw
 *     live, so mapping it to 'custom' would DOWNGRADE a standing capability, not
 *     "prevent an implicit upgrade". We preserve it EXACTLY — and no further: any
 *     non-owner 'general', or an owner without the armed flag, → 'custom' (never held
 *     raw; the legacy general→raw MIGRATION stays owner-only to avoid an implicit
 *     upgrade — a non-owner reaches raw only via an EXPLICIT 'raw' assignment).
 *   • 'raw' → 'raw' for ANY role. ADR-072 AMENDED 2026-07-26 (owner decision): raw
 *     is assignable to admin/user, not owner-only. The only brake on a raw grant is
 *     the armed-flag CEILING + the environment guard (applied in capabilityForRole),
 *     which lower EVERY role at once — never a per-row clip here.
 *   • anything else (missing / corrupt / unknown string) → 'none'.
 *   • owner floor: the owner is never left at 'none' (would lock everyone out of
 *     managing the feature) — raised to 'safe'.
 * NOTE this returns the GRANTED tier only; the armed-flag CEILING is applied
 * separately in capabilityForRole so that turning the flag off drops raw for
 * every role at once. So even when this mints 'raw' for a migrated owner, the
 * effective capability falls to 'custom' the moment the flag is unarmed.
 * @param {string} role
 * @param {unknown} storedMode
 * @param {boolean} [rawExecEnabled=false] The RAW configured armed flag (as stored,
 *   BEFORE the environment-guard ceiling) — NOT the effective tier after min(). Only
 *   the legacy 'general' → owner branch reads it. It is passed in as a plain boolean
 *   by the caller precisely to avoid a circular dependency: this function must never
 *   call capabilityForRole (which itself calls canonicalizeRoleMode) to derive it.
 * @returns {'none'|'safe'|'custom'|'raw'}
 */
export function canonicalizeRoleMode(role, storedMode, rawExecEnabled = false) {
  let tier;
  switch (storedMode) {
    case 'safe':
      tier = 'safe';
      break;
    case 'custom':
      tier = 'custom';
      break;
    case 'general':
      // legacy vocabulary. owner + configured-armed → raw (preserve a live capability,
      // NOT an upgrade); every other case → custom. See doc above for the full rule.
      tier = role === 'owner' && rawExecEnabled === true ? 'raw' : 'custom';
      break;
    case 'raw':
      // ADR-072 AMENDED 2026-07-26 (owner decision): raw is assignable to ANY role
      // — not owner-only. The armed-flag ceiling + environment guard
      // (capabilityForRole) are the ONLY brakes on a raw grant becoming effective.
      tier = 'raw';
      break;
    case 'none':
      tier = 'none';
      break;
    default:
      tier = 'none'; // missing / corrupt / unknown → fail-closed
      break;
  }
  if (role === 'owner' && tier === 'none') tier = 'safe'; // owner floor
  return tier;
}

/** الوضع الافتراضي الآمن — يطابق سلوك ما قبل T-948 (المالك فقط). */
const DEFAULT_CONFIG = Object.freeze({
  roleModes: Object.freeze({ owner: 'safe', admin: 'none', user: 'none' }),
  disabledActions: Object.freeze([]),
  // raw-exec (ADR-072 ceiling / ADR-070): مطفأ افتراضاً، fail-closed. لا يُفعّل
  // السقف 'raw' إلا بقيمة boolean true صريحة — أي قيمة أخرى → false.
  rawExecEnabled: false,
});

/**
 * @typedef {'none'|'safe'|'custom'|'raw'} RoleTier
 * @typedef {{ roleModes: Record<string, RoleTier>, disabledActions: string[],
 *            rawExecEnabled: boolean }} CommandBoardConfig
 */

/**
 * يقرأ الـconfig من app_config ويُطبّع القيم fail-closed مع ترحيلٍ كسول وقت القراءة
 * (canonicalizeRoleMode) إلى مفردات الطبقات. أي حقل ناقص/غير صالح يعود لافتراضه
 * الآمن. roleModes الناتجة granted tiers بالمفردات الجديدة (بلا سقف — السقف يُطبَّق
 * في capabilityForRole). لا يرمي أبداً.
 * @returns {CommandBoardConfig}
 */
export function getCommandBoardConfig() {
  let parsed = null;
  try {
    const raw = appConfigDb.get(COMMAND_BOARD_CONFIG_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null; // تلف JSON → الافتراض الآمن
  }
  const storedRoleModes =
    parsed && parsed.roleModes && typeof parsed.roleModes === 'object' ? parsed.roleModes : {};

  // Compute the RAW configured armed flag FIRST — the legacy 'general' migration
  // needs it to know whether owner+general held raw live. Pass this RAW value (the
  // stored boolean, BEFORE the environment-guard ceiling below) into
  // canonicalizeRoleMode so the GRANTED tier reflects what the owner actually
  // configured; the environment guard is a CEILING concern (applied to
  // `rawExecEnabled` here and again in capabilityForRole), never a downgrade of the
  // grant. Ordering also keeps the dependency one-way: canonicalizeRoleMode takes a
  // plain boolean and never reaches back into capabilityForRole's post-min() tier.
  const rawFlagConfigured = !!(parsed && parsed.rawExecEnabled === true);

  const roleModes = {};
  for (const role of VALID_ROLES) {
    // canonicalizeRoleMode handles missing/corrupt (→none) + owner floor (→safe),
    // and owner+general+armed → raw (capability preservation, clipped by the ceiling).
    roleModes[role] = canonicalizeRoleMode(role, storedRoleModes[role], rawFlagConfigured);
  }

  let disabledActions = [];
  if (parsed && Array.isArray(parsed.disabledActions)) {
    disabledActions = parsed.disabledActions.filter((a) => typeof a === 'string');
  }

  // fail-closed: the armed flag is true ONLY for an explicit boolean `true`. A
  // missing / corrupt / non-boolean value keeps it OFF. B-197: an environment
  // blocker overrides a stored `true` at READ time, so the ceiling every
  // downstream gate derives is already 'custom' without needing to know the
  // guard exists.
  const rawExecEnabled = rawFlagConfigured && rawExecEnvironmentBlockers().length === 0;

  return { roleModes, disabledActions, rawExecEnabled };
}

/**
 * الطبقة المُمنَحة (granted tier) لدورٍ ما كما هي مخزَّنة/مُرحَّلة — قبل تطبيق سقف
 * العلم. ('none' لدورٍ مجهول.) تُعيد الآن مفردات الطبقات (none/safe/custom/raw).
 */
export function effectiveModeForRole(role, config = getCommandBoardConfig()) {
  return config.roleModes[role] ?? 'none';
}

/**
 * الطبقة الفعّالة (effective capability) لدورٍ ما: الطبقة المُمنَحة مقصوصةً بسقف
 * العلم. السقف = 'raw' فقط إن كان العلم مسلَّحاً بلا مانع بيئي، وإلا 'custom' —
 * فيقصّ أي 'raw' مُمنَح إلى 'custom'. هذه هي دالّة القرار الوحيدة التي تبني عليها
 * كل الأغلفة.
 * @param {string} role
 * @param {CommandBoardConfig} [cfg]
 * @returns {'none'|'safe'|'custom'|'raw'}
 */
export function capabilityForRole(role, cfg = getCommandBoardConfig()) {
  // The configured armed flag on the cfg (already env-gated when cfg came from
  // getCommandBoardConfig). Feed it into canonicalizeRoleMode so a hand-built cfg
  // carrying owner+general+armed migrates the SAME way a stored one does; for a cfg
  // from getCommandBoardConfig the roleMode is already migrated, so this arg is a
  // no-op there ('general' has become 'raw'/'custom' already).
  const rawFlagConfigured = cfg.rawExecEnabled === true;
  const granted = canonicalizeRoleMode(role, cfg.roleModes?.[role], rawFlagConfigured);
  // Belt-and-suspenders: getCommandBoardConfig already zeroes the flag under a
  // blocker, but re-check here so a hand-built cfg cannot mint 'raw' either.
  const armed = rawFlagConfigured && rawExecEnvironmentBlockers().length === 0;
  const ceiling = armed ? 'raw' : 'custom';
  return minTier(granted, ceiling);
}

/**
 * جدول الحقيقة الأساسي: هل تبلغ قدرةُ الدور الطبقةَ المطلوبة؟ fail-closed —
 * requiredTier مجهول ⇒ false.
 * @param {string} role
 * @param {'none'|'safe'|'custom'|'raw'} requiredTier
 * @param {CommandBoardConfig} [cfg]
 * @returns {boolean}
 */
export function roleCanRun(role, requiredTier, cfg = getCommandBoardConfig()) {
  const need = TIER_ORDER[requiredTier];
  if (need === undefined) return false; // unknown requirement → fail-closed
  return TIER_ORDER[capabilityForRole(role, cfg)] >= need;
}

/**
 * هل يجوز لدورٍ تشغيلُ فعلٍ ما؟ غلافٌ رفيع فوق roleCanRun. fail-closed:
 *   • الفعل معروف (allowlist ثابت أو أمر مخصّص صالح)،
 *   • غير معطَّل في الـconfig (مرشِّح متعامد — يبقى)،
 *   • وقدرة الدور تبلغ الطبقة المطلوبة: ثابت→'safe'، مخصّص→'custom'.
 * ملاحظة: minRole لكل فعل يبقى مفروضاً بشكلٍ منفصل في المسار (roleSatisfies —
 * المرشِّح المتعامد الثاني)؛ هذه الدالة لا تُخفّفه.
 */
export function canRoleRunAction(role, actionType, config = getCommandBoardConfig()) {
  const staticAction = getAction(actionType);
  const customAction = staticAction ? null : getCustomAction(actionType);
  if (!staticAction && !customAction) return false; // مجهول → fail-closed
  if (config.disabledActions.includes(actionType)) return false;
  const requiredTier = staticAction ? 'safe' : 'custom';
  return roleCanRun(role, requiredTier, config);
}

/**
 * هل يجوز لدورٍ إدراجُ/تنفيذُ أمر raw حرّ (ADR-070/072)؟ غلافٌ رفيع =
 * roleCanRun(role,'raw'). أي نقص (دور مجهول) → false.
 *
 * ADR-072 (سبب B-199): حُذف شرط «الوضع general» القديم — كان زائداً بلا فائدة
 * أمنية (القدرة raw تتطلّب طبقة raw مُسنَدة + سقفاً مسلَّحاً بلا مانع بيئي). ومنذ
 * تعديل 2026-07-26 لم تعد raw حكراً على المالك: تُخوَّل المسارات بالطبقة نفسها.
 * السقف (rawExecEnabled) يمرّ عبر capabilityForRole: مُطفأ ⇒ لا يبلغ أحدٌ raw؛
 * ووجود أي مانع بيئي (IS_PLATFORM) يجعل السقف 'custom' مهما كان المخزَّن.
 *
 * مواضع الاستدعاء الفعلية (تُتَبَّع من هنا إلى سطر spawn — لا تصف هذه الوثيقة
 * حمايةً غير قائمة):
 *   1) `prepareRawExecution` في `command-board-raw.js` — البوّابة التي يمرّ بها
 *      كل تنفيذ raw قبل بناء وصف الـspawn؛ فشلها يعني «لا spawn».
 *   2) المسار `POST /command-board-raw/:id/execute` يستدعي قبلها
 *      `rawExecConfigGate` التي تفصل السببين (raw_exec_disabled مقابل
 *      config_denied) لرسالة أوضح — فالطبقتان متعمّدتان لا مكرّرتان.
 */
export function canRoleRunRawExec(role, config = getCommandBoardConfig()) {
  return roleCanRun(role, 'raw', config);
}

/**
 * إسقاط عام للـconfig لصفحة الإعدادات (بلا أسرار — مجرّد طبقات وتعطيل). العقد
 * (ADR-072) كي تشتقّ الواجهة التعطيل من حقيقة الخادم لا من ترميز عميلي:
 *   • roleModes: الطبقة المُمنَحة لكل دور بالمفردات الجديدة (none/safe/custom/raw).
 *   • maxAssignableTier: أقصى طبقة يجوز إسنادها لكل دور (raw لكل الأدوار — ADR-072
 *     مُعدَّل 2026-07-26).
 *   • rawExecEnabled: هل السقف raw مسلَّح فعلياً (بعد الحارس البيئي) — «مسلَّح/غير
 *     مسلَّح»؛ إسناد المالك 'raw' لا يسري إلا وهو true.
 *   • rawExecBlockedReasons: أسباب تعذُّر التسليح بيئياً (مصفوفة فارغة = لا مانع).
 * @returns {CommandBoardConfig & { maxAssignableTier: Record<string,string>,
 *          rawExecBlockedReasons: string[] }}
 */
export function toPublicCommandBoardConfig(config = getCommandBoardConfig()) {
  return {
    roleModes: ALL_ROLES.reduce((acc, r) => {
      acc[r] = config.roleModes[r] ?? 'none';
      return acc;
    }, {}),
    disabledActions: [...config.disabledActions],
    maxAssignableTier: { ...MAX_ASSIGNABLE_TIER },
    rawExecEnabled: config.rawExecEnabled === true,
    rawExecBlockedReasons: rawExecEnvironmentBlockers(),
  };
}

/**
 * يُسقط علم raw-exec المخزَّن **فعلياً** إن وُجد مانع بيئي (B-197). قراءة
 * `getCommandBoardConfig` تُحيّد العلم أصلاً، لكن هذه تكتب الإسقاط ليصير
 * المخزَّن مطابقاً للفعّال — فلا يعرض المخزون `true` مضلِّلاً في الإعدادات ولا
 * يعود العلم حيّاً لحظة زوال المانع دون قرار جديد من المالك.
 *
 * best-effort ولا ترمي: فشل الكتابة لا يفتح شيئاً (القراءة fail-closed أصلاً).
 * @returns {{ blockers: string[], dropped: boolean }}
 */
export function enforceRawExecEnvironmentGuard() {
  const blockers = rawExecEnvironmentBlockers();
  if (blockers.length === 0) return { blockers, dropped: false };
  let stored = null;
  try {
    const raw = appConfigDb.get(COMMAND_BOARD_CONFIG_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  if (!stored || stored.rawExecEnabled !== true) return { blockers, dropped: false };
  try {
    appConfigDb.set(
      COMMAND_BOARD_CONFIG_KEY,
      JSON.stringify({ ...stored, rawExecEnabled: false })
    );
  } catch {
    return { blockers, dropped: false };
  }
  console.warn('[command-board] raw-exec flag dropped by environment guard', { blockers });
  return { blockers, dropped: true };
}

/**
 * يتحقّق من مدخلات المالك ويكتب الـconfig. fail-closed: يرفض القيم/الأدوار غير
 * الصالحة بدل تجاهلها صامتاً. يقبل مفردات الطبقات الجديدة (ويتسامح مع 'general'
 * القديمة مُرحِّلاً إياها إلى 'custom')، يمنع owner=none، ويقبل 'raw' لأي دور
 * (ADR-072 مُعدَّل 2026-07-26 — لم تعد owner-only)، ويعيد الكتابة بالمفردات الجديدة
 * (canonical) عند الحفظ. يُعيد { ok, error?, config? }.
 */
export function setCommandBoardConfig(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_body' };
  const roleModes = {};
  if (input.roleModes && typeof input.roleModes === 'object') {
    for (const role of VALID_ROLES) {
      const m = input.roleModes[role];
      if (m === undefined) continue;
      if (typeof m !== 'string' || !VALID_INPUT_MODES.has(m)) {
        return { ok: false, error: `invalid_mode:${role}` };
      }
      // canonicalize on the way in: general→custom (legacy), raw→raw for ANY role
      // (ADR-072 amended 2026-07-26 — no longer owner-only), owner floor. Stored
      // value is always canonical new vocabulary.
      // NOTE the armed-flag arg is intentionally OMITTED (defaults false) here: an
      // EXPLICIT write of legacy 'general' is a fresh choice and must NOT auto-upgrade
      // to raw — the owner picks 'raw' explicitly. Live-capability preservation applies
      // only to the READ-time migration (getCommandBoardConfig), which the partial-merge
      // below inherits via `current`.
      roleModes[role] = canonicalizeRoleMode(role, m);
    }
  }
  let disabledActions;
  if (input.disabledActions !== undefined) {
    if (!Array.isArray(input.disabledActions)) return { ok: false, error: 'invalid_disabled' };
    for (const a of input.disabledActions) {
      if (typeof a !== 'string' || !getAction(a)) return { ok: false, error: `unknown_action:${a}` };
    }
    disabledActions = input.disabledActions;
  }
  // raw-exec (ADR-072 ceiling): يُقبل boolean فقط؛ أي نوع آخر يُرفض صراحةً لا يُتجاهل.
  let rawExecEnabled;
  if (input.rawExecEnabled !== undefined) {
    if (typeof input.rawExecEnabled !== 'boolean') {
      return { ok: false, error: 'invalid_raw_exec_enabled' };
    }
    // B-197: حارس بيئي fail-closed — التسليح مرفوض صراحةً (لا يُقبل ثم يُحيَّد عند
    // القراءة) ما دام المانع قائماً، مع كود سبب يعرضه المالك في الإعدادات. الإطفاء
    // يبقى مسموحاً دائماً.
    if (input.rawExecEnabled === true) {
      const blockers = rawExecEnvironmentBlockers();
      if (blockers.length > 0) {
        return { ok: false, error: `raw_exec_blocked:${blockers.join(',')}`, blockers };
      }
    }
    rawExecEnabled = input.rawExecEnabled;
  }
  // دمج فوق الحالي (تحديث جزئي مسموح). current.roleModes مُرحَّلة أصلاً (canonical).
  const current = getCommandBoardConfig();
  const merged = {
    roleModes: { ...current.roleModes, ...roleModes },
    disabledActions: disabledActions ?? current.disabledActions,
    rawExecEnabled: rawExecEnabled ?? current.rawExecEnabled,
  };
  // owner floor: the owner is never stored as 'none' (would lock everyone out of
  // managing the feature). canonicalizeRoleMode already enforces this on any input
  // and on read; this guards the merge with a possibly-stale current value too.
  if (merged.roleModes.owner === 'none') merged.roleModes.owner = 'safe';
  appConfigDb.set(COMMAND_BOARD_CONFIG_KEY, JSON.stringify(merged));
  return { ok: true, config: toPublicCommandBoardConfig(merged) };
}

// Kept for reference / potential reuse; the effective default is produced by
// canonicalizeRoleMode in getCommandBoardConfig.
export { DEFAULT_CONFIG, CANONICAL_TIERS };
