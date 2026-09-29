/** Map known server error codes to i18n keys in the 'chat' namespace. */
export const SERVER_ERROR_CODE_KEYS: Record<string, string> = {
  message_dispatch_not_started: 'outbox.reason.message_dispatch_not_started',
  message_dispatch_unconfirmed: 'outbox.reason.unconfirmed',
  project_dir_missing: 'serverError.project_dir_missing',
  cli_not_installed: 'serverError.cli_not_installed',
  spawn_failed: 'serverError.spawn_failed',
  session_create_failed: 'serverError.session_create_failed',
  abort_failed: 'serverError.abort_failed',
  conversation_not_found: 'sessionNotResumable.message',
  stream_recovery_gap: 'streamRecoveryGap',
  authentication_required: 'serverError.authentication_required',
  model_not_supported: 'serverError.model_not_supported',
  codex_cache_incompatible: 'serverError.codex_cache_incompatible',
  usage_limit: 'serverError.usage_limit',
  codex_turn_failed: 'serverError.codex_turn_failed',
  // B-518: رفض قاطع لا عطل — المحادثة عليها جولة حيّة. كان يسقط إلى
  // `unknown` («حدث خطأ غير متوقع») فلا يفهم المستخدم أن رسالته لم تُرسل
  // أصلاً ولا ما يفعله، فيعيد الإرسال ويُرفض ثانيةً.
  session_busy: 'serverError.session_busy',
  // B-1298: رموز أخطاء المزوّد المحلي — تصل مباشرةً على إطار kind:'error' أو
  // في حقل providerErrorCode على إطار message_dispatch_unconfirmed.
  provider_auth_failed: 'serverError.provider_auth_failed',
  provider_context_overflow: 'serverError.provider_context_overflow',
  LOCAL_MODELS_AUTH_FAILED: 'serverError.local_models_auth_failed',
  // B-1076: حجب الصلاحيات — جولةٌ سابقة انتهت بأثرٍ مجهول (B-953/T-1770).
  // `effect_scope_fenced`/`generation_blocked` قاطعان (retryable:false) ولا
  // يُترجَمان بمفتاح واحد: النصّ يفترق بحسب `fence.scopeKind`، فمفتاحاهما
  // العامّان هنا احتياطٌ حين يغيب حقل `fence` نفسه.
  effect_scope_fenced: 'outbox.reason.effect_scope_fenced_unknown',
  generation_blocked: 'outbox.reason.generation_blocked',
  generation_transitioning: 'outbox.reason.generation_transitioning',
};

/** نطاق حجب الصلاحية كما يصل من الخادم. */
export type OutboxFenceScopeKind = 'session' | 'user_provider_purpose' | 'generation';

export type OutboxFenceInfo = { scopeKind?: OutboxFenceScopeKind; reasonCode?: string };

const FENCE_SCOPE_KINDS = new Set<string>(['session', 'user_provider_purpose', 'generation']);

/**
 * الرمزان الوحيدان اللذان يجوز أن يُفسَّرا «قاطعَين» (لا زرّ إعادة إرسال):
 * حرفياً `effect_scope_fenced` و`generation_blocked` — لا سواهما، ولو ادّعى
 * إطارٌ آخر `retryable:false` خطأً أو تدهوراً في مزوّدٍ لاحق.
 */
export const PERMANENT_OUTBOX_CODES: ReadonlySet<string> =
  new Set(['effect_scope_fenced', 'generation_blocked']);

/** `retryable:false` مُعتمَدٌ فقط حين يكون الرمز أحد القاطعَين الاثنين. */
export function isPermanentOutboxBlock(
  code: string | null | undefined,
  retryable: boolean | null | undefined,
): boolean {
  return typeof code === 'string' && PERMANENT_OUTBOX_CODES.has(code) && retryable === false;
}

/** يستخرج `fence` من الشكلين: مُنظَّماً داخل `error.fence` أو مسطَّحاً في الجذر. */
export function readServerErrorFence(msg: { fence?: unknown; error?: unknown }): OutboxFenceInfo | null {
  const structured =
    msg.error && typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : null;
  const raw = (structured && 'fence' in structured ? structured.fence : msg.fence) as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const scopeKind = typeof record.scopeKind === 'string' && FENCE_SCOPE_KINDS.has(record.scopeKind)
    ? (record.scopeKind as OutboxFenceScopeKind) : undefined;
  const reasonCode = typeof record.reasonCode === 'string' ? record.reasonCode : undefined;
  return { scopeKind, reasonCode };
}

/** يستخرج `retryable` (جذراً أو داخل `error.retryable`)، أو `null` إن غاب. */
export function readServerErrorRetryable(msg: { retryable?: unknown; error?: unknown }): boolean | null {
  const structured =
    msg.error && typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : null;
  const value = structured && 'retryable' in structured ? structured.retryable : msg.retryable;
  return typeof value === 'boolean' ? value : null;
}

/**
 * مفتاح نصّ السبب لحجوب الصلاحية وحدها، متفرّعاً بحسب `fence.scopeKind`.
 * ‏`''` لأي رمزٍ آخر — عندها يُستعمَل `SERVER_ERROR_CODE_KEYS` كالمعتاد.
 */
export function resolveOutboxFenceReasonKey(code: string, fence: OutboxFenceInfo | null): string {
  if (code === 'effect_scope_fenced') {
    if (fence?.scopeKind === 'session') return 'outbox.reason.effect_scope_fenced_session';
    if (fence?.scopeKind === 'user_provider_purpose') return 'outbox.reason.effect_scope_fenced_provider';
    return 'outbox.reason.effect_scope_fenced_unknown';
  }
  if (code === 'generation_blocked') return 'outbox.reason.generation_blocked';
  if (code === 'generation_transitioning') return 'outbox.reason.generation_transitioning';
  return '';
}

export type OutboxFenceAction =
  | { kind: 'new_conversation' }
  | { kind: 'review_unlock'; scopeKind: OutboxFenceScopeKind | null };

/**
 * الفعل الملائم لبطاقة الصادر تحت حجب صلاحيةٍ قاطع. غير الأصحاب (`isOwner`
 * false) لا يُعرض لهم رفعُ الحجب — لهم فقط الاستمرار في محادثة جديدة حين
 * يكون الحجب خاصّاً بجلستهم هذه بعينها؛ حجبٌ أعمّ (مزوّد أو الخادم كله) لا
 * حلّ من طرفهم فلا فعل يُعرض، والنصّ وحده يوجّههم لطلب المالك.
 */
export function resolveOutboxFenceAction(
  code: string,
  fence: OutboxFenceInfo | null,
  isOwner: boolean,
): OutboxFenceAction[] {
  if (!PERMANENT_OUTBOX_CODES.has(code)) return [];
  const actions: OutboxFenceAction[] = [];
  if (code === 'effect_scope_fenced' && fence?.scopeKind === 'session') {
    actions.push({ kind: 'new_conversation' });
  }
  if (isOwner) {
    actions.push({ kind: 'review_unlock', scopeKind: fence?.scopeKind ?? null });
  }
  return actions;
}

/**
 * رمز الخطأ كما يصل بشكليه: منظَّماً داخل `error.code` أو مسطَّحاً في الجذر
 * (الشكل القديم). مستخرَجٌ من `resolveServerErrorMessage` لأن التمييز بين
 * «فشلت الجولة» و«رُفضت المحاولة» يحتاج الرمز لا نصّه المترجَم.
 */
export function readServerErrorCode(msg: { code?: unknown; error?: unknown }): string | null {
  const structured =
    msg.error && typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : null;
  if (structured && typeof structured.code === 'string' && structured.code) {
    return structured.code;
  }
  return typeof msg.code === 'string' && msg.code ? msg.code : null;
}

/**
 * التفصيل الخام كما يصل بشكليه (`error.detail` أو `reason`). مستخرَجٌ لأن
 * صندوق الصادر (T-1295) يخزّن **الرمز والتفصيل** لا النصّ المترجَم: البطاقة قد
 * تُعرض بعد أن يبدّل المستخدم لغة الواجهة، فسببٌ محفوظ بلغةٍ ماضية سببٌ خاطئ.
 */
export function readServerErrorDetail(msg: { error?: unknown; reason?: unknown }): string | null {
  const structured =
    msg.error && typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : null;
  if (structured && typeof structured.detail === 'string' && structured.detail) {
    return structured.detail;
  }
  return typeof msg.reason === 'string' && msg.reason ? msg.reason : null;
}

/** Only bounded, ASCII identifier codes are safe to include in a banner. */
function safeDisplayErrorCode(value: unknown): string | null {
  return typeof value === 'string'
    && value.length <= 64
    && /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/.test(value)
    ? value : null;
}

/**
 * Translate trusted error classifications without exposing raw server details.
 * SERVER_ERROR_UNCLASSIFIED is a UI category, not a unique incident identifier.
 * Display validation must not change the codes used by delivery state handling.
 *
 * B-1298: when the frame is a message_dispatch_unconfirmed dispatch failure and
 * carries a `providerErrorCode` sibling field (e.g. provider_auth_failed), use
 * the provider code for both the headline and the displayed code label. The
 * delivery semantics (unconfirmed outbox state) are unaffected.
 */
export function resolveServerErrorMessage(
  msg: { code?: unknown; error?: unknown; reason?: unknown; providerErrorCode?: unknown },
  t: (key: string, opts?: Record<string, unknown>) => string,
  fallbackCode: 'SERVER_ERROR_UNCLASSIFIED' | 'session_create_failed' | 'abort_failed'
    = 'SERVER_ERROR_UNCLASSIFIED',
): string {
  const fallback = t('serverError.unknown');
  const structured =
    msg.error && typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : null;
  const rawCode = safeDisplayErrorCode(structured?.code) || safeDisplayErrorCode(msg.code);
  // Prefer providerErrorCode when the delivery frame is unconfirmed and the
  // provider reported a specific cause (e.g. wrong key, context overflow).
  const providerCode = rawCode === 'message_dispatch_unconfirmed'
    ? safeDisplayErrorCode(msg.providerErrorCode) : null;
  const code = providerCode ?? rawCode;
  const displayCode = code || fallbackCode;
  const mappedKey = Object.prototype.hasOwnProperty.call(SERVER_ERROR_CODE_KEYS, displayCode)
    ? SERVER_ERROR_CODE_KEYS[displayCode] : null;
  const trustedMessageKey = !code && typeof structured?.messageKey === 'string'
    && Object.values(SERVER_ERROR_CODE_KEYS).includes(structured.messageKey)
    ? structured.messageKey : null;
  const messageKey = mappedKey || trustedMessageKey;
  const headline = messageKey ? t(messageKey, { defaultValue: fallback }) : fallback;
  return `${headline}. ${t('serverError.codeLabel')}: ${displayCode}`;
}

