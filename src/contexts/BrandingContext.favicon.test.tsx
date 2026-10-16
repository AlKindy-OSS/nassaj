/**
 * أيقونة التبويب: أيقونة الخادم > الشعار > أيقونات index.html الأصلية،
 * ويتبدّل الترتيب فوراً عند refresh() بلا إعادة تحميل.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

import { resetFaviconAttentionForTests, setFaviconAttention } from '../utils/faviconAttention';

import { BrandingProvider, useBranding } from './BrandingContext';

const getBranding = vi.fn();

vi.mock('../utils/api', () => ({
  api: { branding: { get: () => getBranding() } },
}));

const NODE_ICON = 'data:image/png;base64,AAAA';
const LOGO = '/uploads/logo.png';
const STATIC_ICON = '/favicon.svg';

const respond = (data: Record<string, unknown>) =>
  getBranding.mockResolvedValue({ ok: true, json: async () => data });

const iconHrefs = () =>
  Array.from(document.head.querySelectorAll('link[rel="icon"]')).map((n) => n.getAttribute('href'));

let refreshFn: () => Promise<void>;
function Capture() {
  refreshFn = useBranding().refresh;
  return null;
}

const mount = async () => {
  render(
    <BrandingProvider>
      <Capture />
    </BrandingProvider>,
  );
  await waitFor(() => expect(getBranding).toHaveBeenCalled());
};

describe('BrandingContext favicon', () => {
  beforeEach(() => {
    resetFaviconAttentionForTests();
    getBranding.mockReset();
    document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${STATIC_ICON}">
<link rel="apple-touch-icon" href="/apple.png">`;
  });
  afterEach(() => {
    cleanup();
    resetFaviconAttentionForTests();
    vi.unstubAllGlobals();
  });

  it('uses the node icon data URI when set', async () => {
    respond({ logoUrl: LOGO, nodeIconDataUri: NODE_ICON });
    await mount();
    await waitFor(() => expect(iconHrefs()).toEqual([NODE_ICON]));
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')).not.toBeNull();
  });

  it('falls back to the logo when no node icon', async () => {
    respond({ logoUrl: LOGO, nodeIconDataUri: null });
    await mount();
    await waitFor(() => expect(iconHrefs()).toEqual([LOGO]));
  });

  it('keeps the static icons when nothing is customised', async () => {
    respond({});
    await mount();
    await waitFor(() => expect(getBranding).toHaveBeenCalled());
    expect(iconHrefs()).toEqual([STATIC_ICON]);
  });

  it('switches live: node icon removed -> logo -> original links', async () => {
    respond({ logoUrl: LOGO, nodeIconDataUri: NODE_ICON });
    await mount();
    await waitFor(() => expect(iconHrefs()).toEqual([NODE_ICON]));

    respond({ logoUrl: LOGO, nodeIconDataUri: null });
    await act(async () => refreshFn());
    await waitFor(() => expect(iconHrefs()).toEqual([LOGO]));

    respond({ logoUrl: null, nodeIconDataUri: null });
    await act(async () => refreshFn());
    await waitFor(() => expect(iconHrefs()).toEqual([STATIC_ICON]));
  });

  // T-2041: تغيير العلامة لا يمحو نقطة «ينتظر جوابك» — يُعاد رسمها فوق الأساس الجديد.
  it('a branding change preserves a live attention overlay', async () => {
    // jsdom بلا canvas: يسقط الرسم إلى أيقونة النقطة المجرّدة، وهذا كافٍ لإثبات
    // أن الكاتب المشترك لم يُستبدَل بالأيقونة الخام.
    vi.stubGlobal(
      'Image',
      class {
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    respond({ logoUrl: LOGO, nodeIconDataUri: null });
    await mount();
    await waitFor(() => expect(iconHrefs()).toEqual([LOGO]));

    setFaviconAttention(true);
    await waitFor(() => expect(iconHrefs()[0]?.startsWith('data:image/svg+xml,')).toBe(true));

    respond({ logoUrl: LOGO, nodeIconDataUri: NODE_ICON });
    await act(async () => refreshFn());
    await waitFor(() => expect(iconHrefs()[0]?.startsWith('data:image/svg+xml,')).toBe(true));
    expect(iconHrefs()).toHaveLength(1);

    setFaviconAttention(false);
    expect(iconHrefs()).toEqual([NODE_ICON]);
  });
});
