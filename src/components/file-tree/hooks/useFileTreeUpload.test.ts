import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  csrf: vi.fn(),
  identitySignal: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('../../../constants/config', () => ({ IS_PLATFORM: false }));
vi.mock('../../../utils/api', () => ({
  applyRefreshedToken: vi.fn(),
  isSessionRejection: vi.fn(async () => true),
  requestMutationCsrf: mocks.csrf,
}));
vi.mock('../../auth/accountIdentityBarrier', () => ({
  identityRequestSignal: mocks.identitySignal,
  reconcileRevokedIdentity: mocks.reconcile,
}));

import { uploadFormDataWithProgress } from './useFileTreeUpload';

class FakeXhr {
  static instances: FakeXhr[] = [];
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  headers = new Map<string, string>();
  status = 0;
  responseText = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = '';
  url = '';
  sent = false;
  aborted = false;

  constructor() { FakeXhr.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  getResponseHeader() { return null; }
  send() { this.sent = true; }
  abort() { this.aborted = true; this.onabort?.(); }
}

beforeEach(() => {
  localStorage.clear();
  FakeXhr.instances = [];
  vi.clearAllMocks();
  mocks.csrf.mockResolvedValue({
    token: 'valid.csrf', response: new Response(null, { status: 200 }),
  });
  const controller = new AbortController();
  mocks.identitySignal.mockReturnValue(controller.signal);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

describe('file-tree device upload', () => {
  it('obtains method/path-bound CSRF before sending XHR without Bearer', async () => {
    const pending = uploadFormDataWithProgress('project/a', new FormData(), vi.fn());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    expect(mocks.csrf).toHaveBeenCalledWith(
      '/api/projects/project%2Fa/files/upload', 'POST', expect.any(AbortSignal),
    );
    expect(xhr.headers.get('X-CSRF-Token')).toBe('valid.csrf');
    expect(xhr.headers.has('Authorization')).toBe(false);
    expect(xhr.sent).toBe(true);
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ uploadedCount: 1, requestedFileCount: 1 });
    xhr.onload?.();
    await expect(pending).resolves.toMatchObject({ uploadedCount: 1 });
  });

  it('surfaces a server rejection for a wrong CSRF token without replay', async () => {
    mocks.csrf.mockResolvedValue({ token: 'wrong.csrf', response: new Response(null, { status: 200 }) });
    const pending = uploadFormDataWithProgress('p', new FormData(), vi.fn());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    xhr.status = 403;
    xhr.responseText = JSON.stringify({ error: 'Invalid CSRF token' });
    xhr.onload?.();
    await expect(pending).rejects.toThrow('Invalid CSRF token');
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it('aborts the active XHR on identity switch and ignores a late success', async () => {
    const controller = new AbortController();
    mocks.identitySignal.mockReturnValue(controller.signal);
    const progress = vi.fn();
    const pending = uploadFormDataWithProgress('p', new FormData(), progress);
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    controller.abort('identity_switch');
    expect(xhr.aborted).toBe(true);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 9, total: 10 } as ProgressEvent);
    expect(progress).not.toHaveBeenCalled();
    xhr.status = 200;
    xhr.responseText = '{}';
    xhr.onload?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores a late 401 classification after the identity signal aborts', async () => {
    let resolveClassification!: (value: boolean) => void;
    const api = await import('../../../utils/api');
    vi.mocked(api.isSessionRejection).mockReturnValueOnce(
      new Promise((resolve) => { resolveClassification = resolve; }),
    );
    const controller = new AbortController();
    mocks.identitySignal.mockReturnValue(controller.signal);
    const pending = uploadFormDataWithProgress('p', new FormData(), vi.fn());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    xhr.status = 401;
    xhr.responseText = JSON.stringify({ code: 'device_session_invalid' });
    xhr.onload?.();
    controller.abort('identity_switch');
    resolveClassification(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
