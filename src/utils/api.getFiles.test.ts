// B-1669: getFiles({ partial: true }) asks for the lean always-200 listing, and
// the `partial` key never leaks into the fetch options.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from './api.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api.getFiles', () => {
  it('appends ?partial=1 and strips the option from the fetch init', async () => {
    const fetchMock = stubFetch();
    await api.getFiles('proj-1', { partial: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { partial?: unknown }];
    expect(url).toBe('/api/projects/proj-1/files?partial=1');
    expect(init.partial).toBeUndefined();
  });

  it('keeps the full-tree URL by default and encodes the project id', async () => {
    const fetchMock = stubFetch();
    await api.getFiles('a/b');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/projects/a%2Fb/files');
  });
});
