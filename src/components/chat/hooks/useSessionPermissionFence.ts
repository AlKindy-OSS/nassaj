import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type SessionFenceContainment = 'contained' | 'leases_open' | 'not_contained' | 'not_provable';

/** T-1910 S4 — حالة حجب الصلاحية لجلسةٍ واحدة كما يعرضها الخادم. */
export interface SessionPermissionFence {
  fenced: boolean;
  scope?: string;
  reason?: string;
  decisionUserId?: number;
  canAcknowledge: boolean;
  containment?: SessionFenceContainment;
}

/** مفاتيح أسباب الرفض تحت `outbox.continueHere.error.*`. */
export type AcknowledgeErrorKey =
  | 'not_contained'
  | 'leases_open'
  | 'not_provable'
  | 'fence_changed'
  | 'not_session_scope'
  | 'unverified_actor'
  | 'forbidden'
  | 'rate_limited'
  | 'unknown';

export type AcknowledgeResult = { ok: true } | { ok: false; errorKey: AcknowledgeErrorKey };

const CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'not_contained',
  'leases_open',
  'not_provable',
  'fence_changed',
  'not_session_scope',
]);

function sessionFenceUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/permission-fence`;
}

function errorKeyForStatus(status: number, reason: unknown, code: unknown): AcknowledgeErrorKey {
  if (status === 403) return code === 'unverified_actor' ? 'unverified_actor' : 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status === 409 && typeof reason === 'string' && CONFLICT_REASONS.has(reason)) {
    return reason as AcknowledgeErrorKey;
  }
  return 'unknown';
}

/**
 * يقرأ حجب الجلسة ويتيح «أكمل من هنا». لا منطق عمل في المكوّن: الاستدعاءان
 * وتصنيف الرفض هنا. `enabled=false` لا يطلب شيئاً. 404 وأي فشل قراءة = لا حجب
 * معروض (البطاقة تبقى كما كانت).
 */
export function useSessionPermissionFence(sessionId: string | null | undefined, enabled: boolean) {
  const [fence, setFence] = useState<SessionPermissionFence | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await authenticatedFetch(sessionFenceUrl(sessionId));
      setFence(res.ok ? ((await res.json()) as SessionPermissionFence) : null);
    } catch {
      setFence(null);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setFence(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await authenticatedFetch(sessionFenceUrl(sessionId));
        const body = res.ok ? ((await res.json()) as SessionPermissionFence) : null;
        if (!cancelled) setFence(body);
      } catch {
        if (!cancelled) setFence(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId]);

  const acknowledge = useCallback(async (): Promise<AcknowledgeResult> => {
    if (!sessionId) return { ok: false, errorKey: 'unknown' };
    setBusy(true);
    try {
      const res = await authenticatedFetch(`${sessionFenceUrl(sessionId)}/acknowledge`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { lifted?: boolean; reason?: string; code?: string };
      if (res.ok) {
        // `not_fenced` = الحجب زال أصلاً: الهدف تحقّق، فالنجاح هو الجواب.
        await refresh();
        return { ok: true };
      }
      return { ok: false, errorKey: errorKeyForStatus(res.status, body.reason, body.code) };
    } catch {
      return { ok: false, errorKey: 'unknown' };
    } finally {
      setBusy(false);
    }
  }, [sessionId, refresh]);

  return { fence, busy, acknowledge, refresh };
}
