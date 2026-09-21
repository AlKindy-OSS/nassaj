/**
 * PermissionFencesSection — حجوب الصلاحيات ورفعها برقابة المالك (T-1770، B-953).
 *
 * حين تنتهي عملية ولا يُعرف أثرها، يحجب نسّاج جيل الصلاحيات أو نطاقها احتياطاً،
 * فيُرفض كل تشغيل بعدها برمز 64. قبل هذا القسم كان الرفع يحتاج SSH وأداة
 * `scripts/permission-fence.mjs`. هنا يرى المالك الحجب وسببه، ويرفعه بسبب مكتوب
 * وإقرار صريح بأن الأثر الخارجي مجهول. الخادم ينفّذ عبر نواة الأداة نفسها
 * ويسجّل النية قبل الحذف. لا رفع تلقائي، ولا تجاوز للإيجارات المفتوحة من الواجهة.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import StatusBadge from '../StatusBadge';

type FenceDecision = {
  provider: string | null;
  entrypoint: string | null;
  purpose: string | null;
  decidedAtMs: number | null;
};

export type PermissionFence = {
  generation: number;
  scopeKind?: 'session' | 'user_provider_purpose';
  scopeKey?: string;
  reasonCode: string;
  createdAtMs: number;
  openLeases: number;
  decision: FenceDecision | null;
};

type FencesResponse = { fences: PermissionFence[]; scopedFences: PermissionFence[] };

const REASON_MAX = 512;

const INPUT_CLASS =
  'w-full touch-manipulation rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** يبني جسم طلب الرفع بالمحدِّد الدقيق: الجيل وحده، أو نوع النطاق ومفتاحه. */
function liftSelector(fence: PermissionFence) {
  return fence.scopeKind
    ? { scopeKind: fence.scopeKind, scopeKey: fence.scopeKey }
    : { generation: fence.generation };
}

function fenceKey(fence: PermissionFence): string {
  return fence.scopeKind ? `${fence.scopeKind}:${fence.scopeKey}` : `generation:${fence.generation}`;
}

type FenceCardProps = {
  fence: PermissionFence;
  busy: boolean;
  onLift: (fence: PermissionFence, reason: string) => Promise<void>;
};

/** بطاقة حجب واحد: سببه ومصدره، ونموذج الرفع بسبب وإقرار. */
function FenceCard({ fence, busy, onLift }: FenceCardProps) {
  const { t, i18n } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const blockedByLeases = fence.openLeases > 0;
  const canLift = !busy && !blockedByLeases && acknowledged && reason.trim().length > 0;
  const when = new Date(fence.createdAtMs).toLocaleString(i18n.language);
  const source = [fence.decision?.provider, fence.decision?.entrypoint, fence.decision?.purpose]
    .filter(Boolean).join(' · ') || t('permissionFences.unknownSource');

  return (
    <SettingsCard tone="warning">
      <div className="space-y-2 text-[13px] leading-relaxed text-foreground">
        <p className="font-medium">
          {fence.scopeKind
            ? t('permissionFences.kindScoped', { scope: fence.scopeKey })
            : t('permissionFences.kindGeneration', { generation: fence.generation })}
        </p>
        <p className="text-muted-foreground">{t('permissionFences.source', { source })}</p>
        <p className="text-muted-foreground">{t('permissionFences.since', { when, reason: fence.reasonCode })}</p>
        {blockedByLeases ? (
          <p className="text-danger" role="alert">{t('permissionFences.openLeases', { count: fence.openLeases })}</p>
        ) : !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex touch-manipulation items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('permissionFences.liftButton')}
          </button>
        ) : (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span>{t('permissionFences.reasonLabel')}</span>
              <textarea
                value={reason}
                maxLength={REASON_MAX}
                rows={2}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('permissionFences.reasonPlaceholder')}
                className={INPUT_CLASS}
              />
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1 h-4 w-4 flex-shrink-0"
              />
              <span>{t('permissionFences.acknowledge')}</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canLift}
                onClick={() => void onLift(fence, reason.trim())}
                className="inline-flex touch-manipulation items-center justify-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm text-danger hover:bg-destructive/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('permissionFences.confirmLift')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setOpen(false); setReason(''); setAcknowledged(false); }}
                className="inline-flex touch-manipulation items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {t('permissionFences.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

/** يحوّل فشل الطلب إلى رسالة تقول للمالك ما يفعله: صلاحية، أو إيجار مفتوح، أو عطل. */
function liftErrorKey(status: number, code: string | undefined): string {
  if (status === 403) return 'permissionFences.forbidden';
  if (code === 'open_leases') return 'permissionFences.openLeasesRefused';
  if (code === 'fence_not_found') return 'permissionFences.alreadyLifted';
  return 'permissionFences.liftFailed';
}

/** قسم إعدادات المالك: يعرض كل حجب قائم ويتيح رفعه بسبب وإقرار. */
export default function PermissionFencesSection() {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<FencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/system/permission-fences');
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as FencesResponse);
      setError(null);
    } catch (err) {
      setError(t(err instanceof Error && err.message === '403' ? 'permissionFences.forbidden' : 'permissionFences.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const lift = async (fence: PermissionFence, reason: string) => {
    setBusyKey(fenceKey(fence));
    setLifted(null);
    try {
      const res = await authenticatedFetch('/api/system/permission-fences/lift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...liftSelector(fence), reason, acknowledgeExternalEffects: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; operationId?: string };
      if (!res.ok) throw Object.assign(new Error('lift'), { status: res.status, code: body.code });
      setLifted(body.operationId ?? '');
      setError(null);
    } catch (err) {
      const { status = 0, code } = err as { status?: number; code?: string };
      setError(t(liftErrorKey(status, code)));
    } finally {
      setBusyKey(null);
      await load();
    }
  };

  const fences = [...(data?.fences ?? []), ...(data?.scopedFences ?? [])];

  return (
    <SettingsSection
      boxed
      icon={ShieldAlert}
      title={t('permissionFences.title')}
      description={t('permissionFences.description')}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('commandBoardSettings.loading')}
        </div>
      ) : (
        <div className="space-y-4 py-2">
          <SettingsCard tone="warning">
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
              <span>{t('permissionFences.warning')}</span>
            </p>
          </SettingsCard>
          {error && (
            <SettingsCard tone="danger">
              <p className="text-[13px] leading-relaxed text-danger" role="alert">{error}</p>
            </SettingsCard>
          )}
          {lifted !== null && (
            <p className="text-[13px] text-muted-foreground" role="status">
              {t('permissionFences.lifted', { operationId: lifted })}
            </p>
          )}
          {fences.length === 0 ? (
            <StatusBadge>{t('permissionFences.none')}</StatusBadge>
          ) : (
            fences.map((fence) => (
              <FenceCard key={fenceKey(fence)} fence={fence} busy={busyKey === fenceKey(fence)} onLift={lift} />
            ))
          )}
        </div>
      )}
    </SettingsSection>
  );
}
