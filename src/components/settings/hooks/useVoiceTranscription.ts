/**
 * useVoiceTranscription — the client half of ADR-103 / T-1246.
 *
 * ## لماذا خطّاف واحد للمفتاح وللإعداد معاً
 *
 * الخادم يجيب عنهما من نقطة واحدة (`GET /transcription/settings`) عمداً: حضورُ
 * المفتاح (`key.system` / `key.user`) وحالةُ العلم يُقرآن معاً لأن أحدهما بلا
 * الآخر لا يقول شيئاً — علمٌ مرفوع بلا مفتاح ميزةٌ لا تعمل، ومفتاحٌ مخزَّن تحت
 * علمٍ مطفأ سرٌّ نائم. فخطّافان يعنيان طلبين لجوابٍ واحد، وفرصةً لأن تتناقض
 * الشاشة مع نفسها بين الطلبين.
 *
 * ## fail-closed عند فشل القراءة
 *
 * جوابٌ لم يصل ليس «الوضع السابق» ولا «افترض الأفضل»: تُقفل الحالة كاملةً
 * (‏`enabled:false`, `canManage:false`, لا مفاتيح) ويُرفع `loadFailed`. والفرق
 * بين الاثنين مقصود: `loadFailed` يمنع الشاشةَ من أن تقول «الميزة مطفأة» وهي لا
 * تعلم — تقول «تعذّرت القراءة» بدل ادّعاءِ حالةٍ لم تُقرأ (درس `feedback_no_fabricated_tool_output`).
 *
 * ## ولا يبتلع 403
 *
 * الصلاحية تُحسب مسبقاً من `canManage` ومن دور المستخدم كي لا يُعرض زرٌّ يرفضه
 * الخادم (B-362). ومع ذلك، حين يرفض الخادم فعلاً، **تُعرض رسالته هو** لا رسالةٌ
 * عامّة: الحالتان اللتان لا يستطيع العميل توقّعهما — وضعُ المنصّة
 * (`PLATFORM_MODE_WRITE_REFUSED`) وتحقّقُ القيم (`INVALID_BASE_URL` وأخواتها) —
 * لا يُعرف سببهما إلا من الجواب (B-367).
 *
 * ## والمفتاح لا يمرّ من هنا في اتجاه القراءة
 *
 * الجواب يحمل منطقيّاتٍ فقط (`key: { system, user }`). ولا يُخزَّن المفتاح في
 * حالة هذا الخطّاف: يُمرَّر وسيطاً إلى `saveKey` ثم يُنسى، ويُفرَّغ حقلُ المكوّن
 * فور نجاح الحفظ.
 */
import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type TranscriptionKeyScope = 'system' | 'user';

export type VoiceTranscriptionState = {
  enabled: boolean;
  /** هل يقبل الخادم من هذا المستخدم كتابةَ إعدادات التفريغ؟ (مالك، وخارج وضع المنصّة) */
  canManage: boolean;
  baseUrl: string;
  model: string;
  maxMb: number;
  key: { system: boolean; user: boolean };
  /** الميزة صالحة للاستعمال فعلاً: العلم مرفوع ومفتاحٌ مّا موجود. */
  available: boolean;
};

export type VoiceTranscriptionPatch = {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  maxMb?: number;
};

/**
 * الحالة المقفلة. تُستعمل قبل أول جواب وعند فشل القراءة معاً — فلا لحظةَ تعرض
 * فيها الشاشة سطحاً مفتوحاً لم يؤكّده الخادم.
 */
const CLOSED: VoiceTranscriptionState = {
  enabled: false,
  canManage: false,
  baseUrl: '',
  model: '',
  maxMb: 0,
  key: { system: false, user: false },
  available: false,
};

type ServerPayload = Partial<VoiceTranscriptionState> & { error?: string; code?: string };

/** يقرأ جسم الجواب بلا أن يرمي على جسمٍ غير JSON (خادمٌ خلف وسيط، أو 502 بصفحة HTML). */
const readJson = async (response: Response): Promise<ServerPayload> => {
  try {
    return (await response.json()) as ServerPayload;
  } catch {
    return {};
  }
};

/**
 * يُطبّع جواب الخادم إلى حالةٍ كاملة. كل حقل يُفحص نوعه: خادمٌ أقدم لا يعرف
 * `key` يجب أن يُقرأ «لا مفاتيح» لا `undefined` تنفجر عند القراءة.
 */
const normalize = (payload: ServerPayload): VoiceTranscriptionState => ({
  enabled: payload.enabled === true,
  canManage: payload.canManage === true,
  baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl : '',
  model: typeof payload.model === 'string' ? payload.model : '',
  maxMb: typeof payload.maxMb === 'number' ? payload.maxMb : 0,
  key: {
    system: payload.key?.system === true,
    user: payload.key?.user === true,
  },
  available: payload.available === true,
});

export type VoiceTranscriptionResult = { ok: boolean; error?: string };

export function useVoiceTranscription() {
  const [state, setState] = useState<VoiceTranscriptionState>(CLOSED);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/voice/transcription/settings');
      if (!response.ok) throw new Error(String(response.status));
      setState(normalize(await readJson(response)));
      setLoadFailed(false);
    } catch {
      setState(CLOSED);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * فعلٌ واحد يلفّ كل كتابة: يُمسك الخطأ، ويُفضّل **رسالة الخادم** على أي نصٍّ
   * محلّي متى وُجدت، ويعيد النتيجة للمكوّن ليقرّر أيُفرّغ الحقل أم يُبقيه.
   */
  const write = useCallback(
    async (
      url: string,
      init: RequestInit,
      onSuccess: (payload: ServerPayload) => void,
      fallbackError: string,
    ): Promise<VoiceTranscriptionResult> => {
      setSaving(true);
      setError(null);
      try {
        const response = await authenticatedFetch(url, init);
        const payload = await readJson(response);
        if (!response.ok) {
          const message = payload.error || fallbackError;
          setError(message);
          return { ok: false, error: message };
        }
        onSuccess(payload);
        return { ok: true };
      } catch {
        setError(fallbackError);
        return { ok: false, error: fallbackError };
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const updateSettings = useCallback(
    (patch: VoiceTranscriptionPatch, fallbackError: string) =>
      write(
        '/api/voice/transcription/settings',
        { method: 'PUT', body: JSON.stringify(patch) },
        // الجواب هو الحالة كاملةً بعد الكتابة، فتُعتمد بدل تعديلٍ متفائل محلّي:
        // الخادم قد يقصّ القيمة (سقف 25MB) فتُعرض قيمتُه لا قيمة الحقل.
        (payload) => setState(normalize(payload)),
        fallbackError,
      ),
    [write],
  );

  const saveKey = useCallback(
    (apiKey: string, scope: TranscriptionKeyScope, fallbackError: string) =>
      write(
        '/api/voice/transcription/key',
        { method: 'PUT', body: JSON.stringify({ apiKey, scope }) },
        // جواب هذه النقطة `{ scope, configured }` لا الحالة كاملة، فتُحدَّث
        // خانةُ النطاق وحدها — و`available` معها، فوجودُ مفتاحٍ تحت علمٍ مرفوع
        // هو تعريفها حرفياً عند الخادم.
        () =>
          setState((previous) => {
            const key = { ...previous.key, [scope]: true };
            return { ...previous, key, available: previous.enabled && (key.system || key.user) };
          }),
        fallbackError,
      ),
    [write],
  );

  const deleteKey = useCallback(
    (scope: TranscriptionKeyScope, fallbackError: string) =>
      write(
        `/api/voice/transcription/key?scope=${scope}`,
        { method: 'DELETE' },
        () =>
          setState((previous) => {
            const key = { ...previous.key, [scope]: false };
            return { ...previous, key, available: previous.enabled && (key.system || key.user) };
          }),
        fallbackError,
      ),
    [write],
  );

  return {
    state,
    loading,
    loadFailed,
    saving,
    error,
    clearError: useCallback(() => setError(null), []),
    refresh,
    updateSettings,
    saveKey,
    deleteKey,
  };
}
