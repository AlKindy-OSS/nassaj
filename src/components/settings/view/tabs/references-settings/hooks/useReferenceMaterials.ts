import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../../../../utils/api';
import type { ReferenceMaterial } from '../types';

export type ReferenceMaterialRecord = {
  id: string;
  name: string;
  material: ReferenceMaterial;
  affectedScope: 'all_members' | 'current_user' | 'project' | 'none' | 'unknown';
  updatedAt: string | null;
  size: number | null;
  content?: string | null;
  contentUnavailableReason?: 'no_file' | 'unreadable' | null;
  status?: string | null;
  reason?: string | null;
  canEdit: boolean;
  canCreateSibling: boolean;
};

type ApiEnvelope<T> = { data?: T; error?: { code?: string } };
type ReferenceMaterialEntry = {
  id: string;
  material: ReferenceMaterial;
  title: string;
  affectedScope: ReferenceMaterialRecord['affectedScope'];
  metadata?: Record<string, unknown>;
  content?: string | null;
  contentUnavailableReason?: 'no_file' | 'unreadable' | null;
  canEdit?: boolean;
  canCreateSibling?: boolean;
};
type ListResponse = {
  entries?: ReferenceMaterialEntry[];
  total?: number;
  canManage?: boolean;
};
type ItemResponse = { item?: ReferenceMaterialEntry; canManage?: boolean };
const PAGE_SIZE = 100;

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok) {
    const error = new Error(`Reference materials request failed (${response.status})`);
    Object.assign(error, { code: payload.error?.code ?? null });
    throw error;
  }
  if (!payload.data) throw new Error('Reference materials response is missing data');
  return payload.data;
}

function toRecord(entry: ReferenceMaterialEntry): ReferenceMaterialRecord {
  const updatedAt = typeof entry.metadata?.updatedAt === 'string' ? entry.metadata.updatedAt : null;
  const size = typeof entry.metadata?.size === 'number' ? entry.metadata.size : null;
  const content = typeof entry.content === 'string' || entry.content === null
    ? entry.content
    : undefined;
  return {
    id: entry.id,
    name: entry.title,
    material: entry.material,
    affectedScope: entry.affectedScope,
    updatedAt,
    size,
    content,
    contentUnavailableReason: entry.contentUnavailableReason ?? null,
    status: typeof entry.metadata?.status === 'string' ? entry.metadata.status : null,
    reason: typeof entry.metadata?.reason === 'string' ? entry.metadata.reason : null,
    canEdit: entry.canEdit === true,
    canCreateSibling: entry.canCreateSibling === true,
  };
}

/** قائمة ومحتوى المواد؛ لا يغادر العميلَ سوى نوع المادة ومعرّف خادمي مبهم. */
export function useReferenceMaterials(material: ReferenceMaterial, active: boolean) {
  const [items, setItems] = useState<ReferenceMaterialRecord[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [token, setToken] = useState(0);
  const reload = useCallback(() => setToken((value) => value + 1), []);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setIsLoading(true);
    setFailed(false);
    setFailureCode(null);
    void (async () => {
      try {
        const collected: ReferenceMaterialRecord[] = [];
        let page = 1;
        let total = 0;
        do {
          const response = await authenticatedFetch(`/api/references/${material}?page=${page}&pageSize=${PAGE_SIZE}`);
          const payload = await readJson<ListResponse>(response);
          if (!Array.isArray(payload.entries)) throw new Error('Invalid reference list');
          collected.push(...payload.entries.map(toRecord));
          total = typeof payload.total === 'number' ? payload.total : collected.length;
          setCanManage(payload.canManage === true);
          page += 1;
        } while (collected.length < total);
        if (!cancelled) setItems(collected);
      } catch (error) {
        if (!cancelled) {
          setItems([]);
          setCanManage(false);
          setFailed(true);
          setFailureCode(error instanceof Error && 'code' in error
            ? String((error as Error & { code?: unknown }).code ?? '') || null
            : null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [active, material, token]);

  const loadContent = useCallback((id: string) => {
    if (items.find((item) => item.id === id)?.content !== undefined) return;
    void authenticatedFetch(`/api/references/${material}/${encodeURIComponent(id)}`)
      .then((response) => readJson<ItemResponse>(response))
      .then((payload) => {
        if (!payload.item) return;
        setCanManage(payload.canManage === true);
        setItems((current) => current.map((item) => item.id === id ? toRecord(payload.item!) : item));
      })
      .catch((error: unknown) => {
        setFailed(true);
        setFailureCode(error instanceof Error && 'code' in error
          ? String((error as Error & { code?: unknown }).code ?? '') || null
          : null);
      });
  }, [items, material]);

  const update = useCallback((id: string, content: string) => {
    setSaving(true); setSaveFailed(false);
    void authenticatedFetch(`/api/references/${material}/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    }).then((response) => readJson<ItemResponse>(response)).then((payload) => {
      if (!payload.item) throw new Error('Invalid item');
      setItems((current) => current.map((item) => item.id === id ? toRecord(payload.item!) : item));
    }).catch(() => setSaveFailed(true)).finally(() => setSaving(false));
  }, [material]);

  const create = useCallback((name: string, content: string, provider?: string) => {
    setSaving(true); setSaveFailed(false);
    void authenticatedFetch(`/api/references/${material}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content, provider }),
    }).then((response) => readJson<ItemResponse>(response)).then(() => reload())
      .catch(() => setSaveFailed(true)).finally(() => setSaving(false));
  }, [material, reload]);

  return { items, canManage, isLoading, failed, failureCode, saving, saveFailed, reload, loadContent, update, create };
}
