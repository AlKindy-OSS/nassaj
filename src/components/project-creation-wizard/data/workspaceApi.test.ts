import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCloneTicket: vi.fn(),
  cloneProgressUrl: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  api: {
    createCloneTicket: mocks.createCloneTicket,
    cloneProgressUrl: mocks.cloneProgressUrl,
  },
}));

import { cloneWorkspaceWithProgress } from './workspaceApi';
import { CloneWorkspaceError } from '../types';

type Listener = (event: unknown) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  closed = false;
  listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, payload: unknown) {
    this.listeners.get(type)?.forEach((listener) => listener(payload));
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as unknown as MessageEvent);
  }

  close() {
    this.closed = true;
  }
}

const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('cloneWorkspaceWithProgress', () => {
  const baseParams = {
    workspacePath: '  /home/user/work  ',
    githubUrl: '  https://github.com/example/repo.git  ',
    tokenMode: 'stored' as const,
    selectedGithubToken: '42',
    newGithubToken: '',
  };

  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
    mocks.createCloneTicket.mockReset();
    mocks.cloneProgressUrl.mockReset();
    mocks.cloneProgressUrl.mockImplementation((ticket: string) => `/api/projects/clone-progress?ticket=${ticket}`);
    window.addEventListener = window.addEventListener.bind(window);
    window.removeEventListener = window.removeEventListener.bind(window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the trimmed path/githubUrl and the stored token id as a number', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(201, { ticket: 'tkt-1', expiresInSeconds: 60 }));

    const promise = cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} });

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(mocks.createCloneTicket).toHaveBeenCalledWith({
      path: '/home/user/work',
      githubUrl: 'https://github.com/example/repo.git',
      githubTokenId: 42,
    });

    const source = FakeEventSource.instances[0];
    source.emitMessage({ type: 'complete', project: { id: 'p1' } });
    await expect(promise).resolves.toEqual({ id: 'p1' });
  });

  it('sends newGithubToken only in "new" token mode and omits githubTokenId', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(201, { ticket: 'tkt-2' }));

    const promise = cloneWorkspaceWithProgress(
      { ...baseParams, tokenMode: 'new', newGithubToken: '  ghp_secret  ' },
      { onProgress: () => {} },
    );

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(mocks.createCloneTicket).toHaveBeenCalledWith({
      path: '/home/user/work',
      githubUrl: 'https://github.com/example/repo.git',
      newGithubToken: 'ghp_secret',
    });

    FakeEventSource.instances[0].emitMessage({ type: 'complete', project: {} });
    await promise;
  });

  it('opens the EventSource with a URL containing only ticket (and token), never the raw PAT/path/githubUrl', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(201, { ticket: 'tkt-3' }));

    const promise = cloneWorkspaceWithProgress(
      { ...baseParams, tokenMode: 'new', newGithubToken: 'ghp_super_secret' },
      { onProgress: () => {} },
    );

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];
    expect(source.url).not.toMatch(/ghp_super_secret/);
    expect(source.url).not.toMatch(/githubUrl=/);
    expect(source.url).not.toMatch(/path=/);
    expect(source.url).toMatch(/ticket=tkt-3/);

    source.emitMessage({ type: 'complete', project: {} });
    await promise;
  });

  it('throws a CloneWorkspaceError carrying the error code and never opens an EventSource on failure', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(429, { error: 'CLONE_TICKET_LIMIT_REACHED' }));

    await expect(
      cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} }),
    ).rejects.toMatchObject({
      code: 'CLONE_TICKET_LIMIT_REACHED',
    });

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('propagates a rejected CloneWorkspaceError instance', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(400, { error: 'INVALID_GITHUB_URL' }));

    let caught: unknown;
    try {
      await cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CloneWorkspaceError);
  });

  it('does not include a token param in the progress URL when localStorage has none', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(201, { ticket: 'tkt-4' }));
    mocks.cloneProgressUrl.mockImplementation((ticket: string) => `/api/projects/clone-progress?ticket=${ticket}`);

    const promise = cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} });
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0].url).not.toMatch(/token=/);

    FakeEventSource.instances[0].emitMessage({ type: 'complete', project: {} });
    await promise;
  });

  it('rejects with AbortError when the identity_revoked SSE event fires', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(201, { ticket: 'tkt-5' }));

    const promise = cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} });
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];

    source.dispatch('identity_revoked', {});

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.closed).toBe(true);
  });

  it('calls onTicketCreated once the ticket is issued, before the clone completes', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(201, { ticket: 'tkt-6' }));
    const onTicketCreated = vi.fn();

    const promise = cloneWorkspaceWithProgress(baseParams, { onProgress: () => {}, onTicketCreated });
    await vi.waitFor(() => expect(onTicketCreated).toHaveBeenCalledTimes(1));

    FakeEventSource.instances[0].emitMessage({ type: 'complete', project: {} });
    await promise;
  });

  it('maps a non-JSON 502 (gateway HTML page) to CloneWorkspaceError CLONE_TICKET_CREATE_FAILED', async () => {
    mocks.createCloneTicket.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    let caught: unknown;
    try {
      await cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CloneWorkspaceError);
    expect((caught as CloneWorkspaceError).code).toBe('CLONE_TICKET_CREATE_FAILED');
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('maps an !ok response with an unrecognized error code to CLONE_TICKET_CREATE_FAILED', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(500, { error: 'SOME_UNKNOWN_SERVER_CODE' }));

    await expect(
      cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} }),
    ).rejects.toMatchObject({ code: 'CLONE_TICKET_CREATE_FAILED' });
  });

  it('rejects with AbortError when the SSE access_fence event fires, and removes the listener on settle', async () => {
    mocks.createCloneTicket.mockResolvedValue(jsonResponse(201, { ticket: 'tkt-7' }));

    const promise = cloneWorkspaceWithProgress(baseParams, { onProgress: () => {} });
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];

    source.dispatch('access_fence', { type: 'access_fence', code: 'device_revoked' });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.closed).toBe(true);
    expect(source.listeners.get('access_fence')?.size).toBe(0);
  });

  it('rejects with CloneWorkspaceError INVALID_CLONE_REQUEST for a non-positive-integer stored token id, without POSTing', async () => {
    await expect(
      cloneWorkspaceWithProgress(
        { ...baseParams, tokenMode: 'stored', selectedGithubToken: 'not-a-number' },
        { onProgress: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CLONE_REQUEST' });

    expect(mocks.createCloneTicket).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
