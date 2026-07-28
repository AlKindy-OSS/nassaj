import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { UserRole } from '../components/auth/types';

import type { ExecuteOutcome, PublicAction } from './useServerActions';

/**
 * CatalogAction — عنصر واحد من GET /api/system/actions (T-947).
 * actionType: المعرّف الرمزي المُستخدَم في العلامة nassaj-exec:<actionType>.
 * commandPreview: الأمر للعرض فقط (لا يُرسَل إلى السيرفر).
 * minRole: الدور الأدنى المطلوب لتفعيل الزر.
 */
export type CatalogAction = {
  actionType: string;
  label: string;
  commandPreview: string | null;
  minRole: 'owner' | 'admin' | 'user';
};

export type RunActionOpts = {
  sessionId?: string;
  reason?: string;
};

/**
 * roleSatisfies — هل الدور role يفي بالحدّ الأدنى minRole؟
 * owner > admin > user
 */
export function roleSatisfies(
  role: UserRole | undefined,
  minRole: 'owner' | 'admin' | 'user',
): boolean {
  const RANK: Record<string, number> = { owner: 3, admin: 2, user: 1 };
  return (RANK[role ?? ''] ?? 0) >= (RANK[minRole] ?? 0);
}

// ---------------------------------------------------------------------------
// Module-level singleton cache — يشارك فيه جميع instances لتجنّب N طلبات
// ---------------------------------------------------------------------------
let _cachedCatalog: CatalogAction[] = [];
let _fetchState: 'idle' | 'fetching' = 'idle';
let _listeners: Array<(catalog: CatalogAction[]) => void> = [];

function _notifyListeners(catalog: CatalogAction[]): void {
  _cachedCatalog = catalog;
  _listeners.forEach((fn) => fn(catalog));
}

async function _fetchCatalog(): Promise<void> {
  if (_fetchState === 'fetching') return;
  _fetchState = 'fetching';
  try {
    const res = await (authenticatedFetch as (url: string) => Promise<Response>)(
      '/api/system/actions',
    );
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        actions?: CatalogAction[];
      } | null;
      _notifyListeners(data?.actions ?? []);
    }
  } catch {
    // Network error — keep previous cached catalog
  } finally {
    _fetchState = 'idle';
  }
}

// ---------------------------------------------------------------------------
// الطابور الحيّ المشترك (T-947 F4): يربط زر المحادثة inline بلوحة الأوامر.
// نفس مصدر الحقيقة (GET /api/system/pending) ونفس إشارة WS
// 'pending-actions-updated' — فتنفيذ أمرٍ من النافذة ينعكس لحظيّاً على كل
// أزرار المحادثة لنفس الـactionType (والعكس)، عبر cache وحيد على مستوى الوحدة.
// ---------------------------------------------------------------------------
let _liveActions: PublicAction[] = [];
let _liveFetchState: 'idle' | 'fetching' = 'idle';
let _liveListeners: Array<(actions: PublicAction[]) => void> = [];

function _notifyLive(actions: PublicAction[]): void {
  _liveActions = actions;
  _liveListeners.forEach((fn) => fn(actions));
}

async function _fetchLive(): Promise<void> {
  if (_liveFetchState === 'fetching') return;
  _liveFetchState = 'fetching';
  try {
    const res = await (authenticatedFetch as (url: string) => Promise<Response>)(
      '/api/system/pending',
    );
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        actions?: PublicAction[];
      } | null;
      _notifyLive(data?.actions ?? []);
    }
  } catch {
    // خطأ شبكة — أبقِ الطابور المكيّش (الخادم قد يكون يُعاد تشغيله)
  } finally {
    _liveFetchState = 'idle';
  }
}

// ---------------------------------------------------------------------------
// useServerActionCatalog — T-947 F1
//
// يجلب GET /api/system/actions ويكيّشه على مستوى الوحدة (module-level)
// حتى لا تُكرَّر الطلبات لكل كتلة كود في نفس الرسالة.
// يُعيد { catalog, runAction }.
// ---------------------------------------------------------------------------
export function useServerActionCatalog() {
  const [catalog, setCatalog] = useState<CatalogAction[]>(_cachedCatalog);
  const [liveActions, setLiveActions] = useState<PublicAction[]>(_liveActions);
  const { latestMessage } = useWebSocket();
  const lastMsgRef = useRef<unknown>(null);

  // اشترك في تحديثات singleton عند الوصل
  useEffect(() => {
    const listener = (updated: CatalogAction[]) => setCatalog(updated);
    _listeners.push(listener);
    const liveListener = (updated: PublicAction[]) => setLiveActions(updated);
    _liveListeners.push(liveListener);

    // أطلق الجلب الأول (لا يعمل إن كان الجلب جارياً)
    void _fetchCatalog();
    void _fetchLive();

    return () => {
      _listeners = _listeners.filter((fn) => fn !== listener);
      _liveListeners = _liveListeners.filter((fn) => fn !== liveListener);
    };
  }, []);

  // أعِد الجلب عند إشارات WS المعنيّة
  useEffect(() => {
    if (!latestMessage) return;
    if (lastMsgRef.current === latestMessage) return;
    lastMsgRef.current = latestMessage;
    const msg = latestMessage as { type?: string };
    if (
      msg.type === 'pending-actions-updated' ||
      msg.type === 'websocket-reconnected'
    ) {
      void _fetchCatalog();
      void _fetchLive();
    }
  }, [latestMessage]);

  /**
   * liveStatusOf — حالة الطابور الحيّة لفعلٍ ما (أو null إن لا صفّ له).
   * يربط زر inline بلوحة الأوامر: تنفيذ/إدراج من أيّ مكان ينعكس هنا عبر WS.
   */
  const liveStatusOf = useCallback(
    (actionType: string): PublicAction['status'] | null =>
      liveActions.find((a) => a.actionType === actionType)?.status ?? null,
    [liveActions],
  );

  /**
   * runAction — POST /api/system/actions/:actionType/run
   * يُرسِل actionType الرمزي فقط — لا نصّ الكتلة أبداً (حاجز أمني T-947).
   */
  const runAction = useCallback(
    async (actionType: string, opts?: RunActionOpts): Promise<ExecuteOutcome> => {
      try {
        const res = await (
          authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
        )(`/api/system/actions/${actionType}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts ?? {}),
        });

        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        if (!res.ok) {
          return { status: 'error', code: String(data.code ?? 'internal') };
        }

        const s = String(data.status ?? '');
        if (s === 'restarting') return { status: 'restarting' };
        if (s === 'success') return { status: 'success' };
        if (s === 'deferred') {
          return {
            status: 'deferred',
            reason: String(data.reason ?? ''),
            detail: data.detail !== undefined ? String(data.detail) : undefined,
          };
        }
        return { status: 'error', code: 'internal' };
      } catch {
        // Network error right after POST → server is likely restarting
        return { status: 'restarting' };
      }
    },
    [],
  );

  return { catalog, runAction, liveStatusOf };
}
