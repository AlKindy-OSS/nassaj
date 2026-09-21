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
};

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
 */
export function resolveServerErrorMessage(
  msg: { code?: unknown; error?: unknown; reason?: unknown },
  t: (key: string, opts?: Record<string, unknown>) => string,
  fallbackCode: 'SERVER_ERROR_UNCLASSIFIED' | 'session_create_failed' | 'abort_failed'
    = 'SERVER_ERROR_UNCLASSIFIED',
): string {
  const fallback = t('serverError.unknown');
  const structured =
    msg.error && typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : null;
  const code = safeDisplayErrorCode(structured?.code) || safeDisplayErrorCode(msg.code);
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

