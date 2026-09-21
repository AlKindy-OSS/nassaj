import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../../../../utils/api';

/** محكوم = تصله تعليمات نسّاج. معفى = يعمل بوضعه الافتراضي. */
export type GovernanceMode = 'governed' | 'exempt';
export type GovernancePreferenceEnforcement = 'fail-closed' | 'best-effort' | 'none';

export type GovernancePreferenceChannel = {
  provider: string;
  mode: GovernanceMode;
  /**
   * أيملك **هذا المُنادي** تبديلَ هذه القناة — يقرّره الخادم، ولا يُشتقّ هنا أبداً
   * (سابقة B-362): زرٌّ ونقطةُ نهايةٍ يختلفان في الحكم عطبٌ أمني لا تفاوت عرض.
   */
  canManage: boolean;
  enforcement: GovernancePreferenceEnforcement;
  /** سببُ المنع كمعرّفٍ رمزي — يُترجَم عند العرض، ولا يُعرض خاماً. */
  reason?: string;
};

export type GovernancePreferencesState = {
  /** `null` = **لا يُرسم اللوح إطلاقاً** (fail-HIDDEN). لا رسالةَ خطأ مخيفة. */
  channels: GovernancePreferenceChannel[] | null;
  /** معرّف المحرّك الجاري حفظُه، أو `null`. */
  saving: string | null;
  /** فشلُ كتابةٍ — يُقال عند صفّه، والحالة المعروضة تبقى ما قرأه الخادم. */
  writeError: string | null;
  setMode: (provider: string, mode: GovernanceMode) => Promise<void>;
};

const MODES: ReadonlySet<string> = new Set(['governed', 'exempt']);
const ENFORCEMENTS: ReadonlySet<string> = new Set(['fail-closed', 'best-effort', 'none']);

/** أيُّ حقلٍ مفقودٍ أو غيرِ معروف ⇒ رفضُ الجواب كلّه. قناةٌ نصفُ مفهومةٍ لا تُرسم. */
function parseChannel(raw: unknown): GovernancePreferenceChannel | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.provider !== 'string'
    || typeof c.mode !== 'string'
    || !MODES.has(c.mode)
    || typeof c.canManage !== 'boolean'
    || typeof c.enforcement !== 'string'
    || !ENFORCEMENTS.has(c.enforcement)
    || (c.reason !== undefined && typeof c.reason !== 'string')
  ) {
    return null;
  }
  return {
    provider: c.provider,
    mode: c.mode as GovernanceMode,
    canManage: c.canManage,
    enforcement: c.enforcement as GovernancePreferenceEnforcement,
    reason: c.reason as string | undefined,
  };
}

function parseChannels(raw: unknown): GovernancePreferenceChannel[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed: GovernancePreferenceChannel[] = [];
  for (const entry of raw) {
    const channel = parseChannel(entry);
    if (!channel) return null;
    parsed.push(channel);
  }
  return parsed;
}

/**
 * تفضيلُ «يتبع تعليمات نسّاج» لكل محرّك
 * (‏`GET /api/governance/preferences` · `PUT /api/governance/preferences/:provider`).
 *
 * **‏fail-HIDDEN حرفياً على سابقة `useProviderGovernance.ts:172-205`:** خادمٌ لا
 * يعرف هذه النقطة (‏404)، أو خطأُ شبكة، أو شكلٌ غير معروف ⇒ `channels === null`
 * ⇒ **اللوح لا يُرسم**. لا رسالةَ خطأٍ مخيفة عن ميزةٍ لم تصل بعد؛ غيابُ الجواب
 * إخفاءٌ لا حكم.
 *
 * **ولا حالةَ متفائلة بعد الكتابة:** ‏`PUT` يعيد القناة بعد التطبيق فتُستبدَل
 * بها، وحين يفشل يُعاد جلبُ القائمة كلّها — فالمعروض ما يشهد به الخادم دائماً،
 * لا ما نوى العميل.
 */
export function useGovernancePreferences(active: boolean): GovernancePreferencesState {
  const [channels, setChannels] = useState<GovernancePreferenceChannel[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!active) return undefined;

    let cancelled = false;

    void (async () => {
      try {
        const response = await authenticatedFetch('/api/governance/preferences');
        if (!response.ok) {
          if (!cancelled) setChannels(null);
          return;
        }
        const payload = (await response.json()) as {
          channels?: unknown;
          data?: { channels?: unknown };
        };
        if (cancelled) return;
        // العقد يضع `channels` في الجذر؛ ومغلّف `createApiSuccessResponse` القائم
        // يضعها تحت `data`. يُقبل الشكلان، ولا يُقبل ثالثٌ.
        const parsed = parseChannels(payload?.channels ?? payload?.data?.channels);
        setChannels(parsed);
      } catch {
        if (!cancelled) setChannels(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, token]);

  const setMode = useCallback(async (provider: string, mode: GovernanceMode) => {
    setSaving(provider);
    setWriteError(null);
    try {
      const response = await authenticatedFetch(`/api/governance/preferences/${provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) {
        setWriteError(provider);
        setToken((value) => value + 1);
        return;
      }
      const payload = (await response.json()) as { data?: unknown };
      const applied = parseChannel(payload?.data ?? payload);
      if (!applied) {
        // كتابةٌ نجحت وجوابُها غير مفهوم: لا يُخمَّن الأثر — يُعاد القراءة.
        setToken((value) => value + 1);
        return;
      }
      setChannels((current) =>
        current
          ? current.map((channel) => (channel.provider === applied.provider ? applied : channel))
          : current,
      );
    } catch {
      setWriteError(provider);
      setToken((value) => value + 1);
    } finally {
      setSaving(null);
    }
  }, []);

  return { channels, saving, writeError, setMode };
}
