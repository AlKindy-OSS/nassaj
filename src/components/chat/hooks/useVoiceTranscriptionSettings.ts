import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

/**
 * useVoiceTranscriptionSettings — «هل يُعرض الوضع الدقيق أصلاً؟» (ADR-103 / T-1248).
 *
 * مصدر الإجابة الوحيد هو `GET /api/voice/transcription/settings`؛ والواجهة لا
 * تستنتج الإتاحة من شيء آخر: وجود مفتاح أو انطفاء علم كلاهما يُعرَف هناك فقط.
 *
 * **fail-closed حرفياً**: أي فشل — شبكة، ‏404 لأنّ الخادم أقدم من الميزة، جسم
 * غير متوقّع — يُبقي `settings = null` أي `available=false`، فلا يظهر وضعٌ
 * يعِد بما لا يستطيع الوفاء به. الحالة الوحيدة التي تُعرض «معطَّلة مع سبب»
 * هي جوابٌ صريح `enabled=true` بلا مفتاح: هناك المستخدم يستحق أن يعرف أنّ
 * الفارق خطوةٌ في الإعدادات لا عطلٌ في جهازه.
 *
 * القراءة مرّة عند التركيب، و`refresh()` عند فتح القائمة — فالمالك قد يضيف
 * المفتاح في تبويب آخر، وإجبار المستخدم على إعادة تحميل الصفحة ليراه رداءة.
 */

export interface VoiceTranscriptionSettings {
  enabled: boolean;
  canManage: boolean;
  baseUrl: string;
  model: string;
  maxMb: number;
  key: { system: boolean; user: boolean };
  /** الشرط الوحيد لإتاحة الوضع الدقيق للمستخدم: علمٌ مرفوع **ومفتاحٌ** موجود. */
  available: boolean;
}

export interface UseVoiceTranscriptionSettingsResult {
  settings: VoiceTranscriptionSettings | null;
  /** انتهت أول محاولة قراءة (نجحت أو فشلت) — تمنع وميض «غير متاح» أثناءها. */
  loaded: boolean;
  refresh: () => void;
}

function normalize(raw: unknown): VoiceTranscriptionSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') return null;
  const key = (value.key ?? {}) as Record<string, unknown>;
  return {
    enabled: value.enabled,
    canManage: value.canManage === true,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    model: typeof value.model === 'string' ? value.model : '',
    maxMb: typeof value.maxMb === 'number' && value.maxMb > 0 ? value.maxMb : 10,
    key: { system: key.system === true, user: key.user === true },
    available: value.available === true,
  };
}

export function useVoiceTranscriptionSettings(): UseVoiceTranscriptionSettingsResult {
  const [settings, setSettings] = useState<VoiceTranscriptionSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);
  // قراءة واحدة حيّة: فتح القائمة مراراً بسرعة لا يفتح طوابير طلبات.
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void (async () => {
      try {
        const response = await authenticatedFetch('/api/voice/transcription/settings');
        if (!response.ok) {
          if (mountedRef.current) setSettings(null);
          return;
        }
        const payload = await response.json();
        if (mountedRef.current) setSettings(normalize(payload));
      } catch {
        // fail-closed: لا إتاحة بلا جواب صريح.
        if (mountedRef.current) setSettings(null);
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { settings, loaded, refresh };
}
