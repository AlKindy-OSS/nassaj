import { authenticatedFetch } from '../../utils/api';

/**
 * Client for `/api/harness-files` (ADR-203, T-2003 C4): shared vs private
 * skills per user, and the owner/admin workspace switch. The server answers
 * the GET with the bare view (no `{success,data}` envelope) and errors with
 * `{ success:false, error:{ code, message } }`.
 */

export type HarnessFilesMode = 'shared' | 'private';
export type HarnessSupportReason = 'no_shared_baseline' | 'shared_not_hideable' | 'no_managed_skills';
export type ClaudeLinkState = 'in-sync' | 'pending' | 'legacy-real-dir' | 'absent' | 'unknown';

export type HarnessSupport = {
  provider: string;
  support: 'full' | 'shared-only';
  reason?: HarnessSupportReason | string;
};

export type HarnessFilesView = {
  workspace: { allowMemberPrivate: boolean; savedPrivateMembers?: number };
  me: {
    requested: HarnessFilesMode;
    effective: HarnessFilesMode;
    canChoose: boolean;
    canManageWorkspace: boolean;
    featureEnabled: boolean;
    harnesses: HarnessSupport[];
    claude: { link: ClaudeLinkState };
  };
};

export type HarnessFilesModeResult = HarnessFilesView & { claudeLink?: string };
export type HarnessFilesWorkspaceResult = HarnessFilesView & { affectedMembers?: number };

/** A failed call, carrying the server's stable error code for translation. */
export class HarnessFilesError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'HarnessFilesError';
    this.code = code;
    this.status = status;
  }
}

const isMode = (value: unknown): value is HarnessFilesMode => value === 'shared' || value === 'private';

/** Rejects anything that is not a complete view, so a stray payload never renders as state. */
export function parseHarnessFilesView(payload: unknown): HarnessFilesView | null {
  const record = payload as Partial<HarnessFilesView> | null;
  const me = record?.me;
  const workspace = record?.workspace;
  if (!me || !workspace || !isMode(me.requested) || !isMode(me.effective)) return null;
  return {
    workspace: {
      allowMemberPrivate: workspace.allowMemberPrivate === true,
      ...(typeof workspace.savedPrivateMembers === 'number'
        ? { savedPrivateMembers: workspace.savedPrivateMembers } : {}),
    },
    me: {
      requested: me.requested,
      effective: me.effective,
      canChoose: me.canChoose === true,
      canManageWorkspace: me.canManageWorkspace === true,
      featureEnabled: me.featureEnabled === true,
      harnesses: Array.isArray(me.harnesses) ? me.harnesses : [],
      claude: { link: me.claude?.link ?? 'unknown' },
    },
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T & HarnessFilesView> {
  const response = await authenticatedFetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new HarnessFilesError(error?.code ?? 'UNKNOWN', response.status, error?.message ?? 'Request failed');
  }
  const view = parseHarnessFilesView(payload);
  if (!view) throw new HarnessFilesError('INVALID_RESPONSE', response.status, 'Invalid response');
  return { ...(payload as T), ...view };
}

export const getHarnessFiles = () => request<HarnessFilesView>('/api/harness-files');

export const putMyHarnessFilesMode = (mode: HarnessFilesMode) => request<HarnessFilesModeResult>(
  '/api/harness-files/me',
  { method: 'PUT', body: JSON.stringify({ mode }) },
);

export const putWorkspaceAllowMemberPrivate = (allowMemberPrivate: boolean) =>
  request<HarnessFilesWorkspaceResult>(
    '/api/harness-files/workspace',
    { method: 'PUT', body: JSON.stringify({ allowMemberPrivate }) },
  );
