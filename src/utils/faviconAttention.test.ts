/**
 * T-2041 — أيقونة التبويب تحمل «ينتظر جوابك»، والكاتب واحد.
 *
 * jsdom بلا canvas ولا تحميل صور، فيُركَّب بديلان: صورةٌ تُحمَّل (أو تفشل إن
 * احتوى عنوانها `broken`) في microtask، ولوحةٌ تُرجع إطاراً يصف ما رُسم عليه
 * (المصدر وشفافية النقطة ولونها) — الاختبار يقود الوحدة الإنتاجية نفسها.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetFaviconAttentionForTests,
  setBaseFavicon,
  setFaviconAttention,
} from './faviconAttention';

const STATIC_ICON = '/favicon.svg';

type FakeContext = {
  globalAlpha: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  drawn: string | null;
  drawImage: (image: { src: string }) => void;
  beginPath: () => void;
  arc: () => void;
  fill: () => void;
  stroke: () => void;
};

const contexts = new WeakMap<HTMLCanvasElement, FakeContext>();
const requestedImages: string[] = [];
let reducedMotion = false;
let hidden = false;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  private source = '';
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    requestedImages.push(value);
    queueMicrotask(() => (value.includes('broken') ? this.onerror?.() : this.onload?.()));
  }
}

const iconHrefs = () =>
  Array.from(document.head.querySelectorAll('link[rel="icon"]')).map((n) => n.getAttribute('href'));

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const setHidden = (value: boolean) => {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  resetFaviconAttentionForTests();
  requestedImages.length = 0;
  reducedMotion = false;
  hidden = false;
  document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${STATIC_ICON}">`;
  document.documentElement.style.setProperty('--primary', '10 20% 30%');
  document.documentElement.style.setProperty('--primary-foreground', '0 0% 100%');
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion') && reducedMotion,
    addEventListener: () => {},
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const context: FakeContext = {
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      drawn: null,
      drawImage(image) {
        this.drawn = image.src;
      },
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
    };
    contexts.set(this, context);
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const context = contexts.get(this)!;
    return `data:frame;base=${context.drawn};alpha=${context.globalAlpha};dot=${context.fillStyle}`;
  });
});

afterEach(() => {
  resetFaviconAttentionForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('faviconAttention', () => {
  it('raises a dot in the --primary token colour over the static icon', async () => {
    setFaviconAttention(true);
    await flush();

    expect(requestedImages).toEqual([STATIC_ICON]);
    expect(iconHrefs()).toEqual([
      `data:frame;base=${STATIC_ICON};alpha=1;dot=hsl(10 20% 30%)`,
    ]);
  });

  it('pulses once a second while the tab is hidden', async () => {
    hidden = true;
    setFaviconAttention(true);
    await flush();
    const first = iconHrefs()[0];
    expect(first).toContain('alpha=1;');

    vi.advanceTimersByTime(1000);
    expect(iconHrefs()[0]).toContain('alpha=0.35;');
    vi.advanceTimersByTime(1000);
    expect(iconHrefs()[0]).toBe(first);
  });

  it('stops pulsing (static dot) when the tab becomes visible', async () => {
    hidden = true;
    setFaviconAttention(true);
    await flush();
    vi.advanceTimersByTime(1000);
    expect(iconHrefs()[0]).toContain('alpha=0.35;');

    setHidden(false);
    expect(iconHrefs()[0]).toContain('alpha=1;');
    vi.advanceTimersByTime(3000);
    expect(iconHrefs()[0]).toContain('alpha=1;');
  });

  it('stays static under prefers-reduced-motion even when hidden', async () => {
    reducedMotion = true;
    hidden = true;
    setFaviconAttention(true);
    await flush();

    vi.advanceTimersByTime(5000);
    expect(iconHrefs()[0]).toContain('alpha=1;');
  });

  it('restores the original icons when cleared', async () => {
    hidden = true;
    setFaviconAttention(true);
    await flush();

    setFaviconAttention(false);
    expect(iconHrefs()).toEqual([STATIC_ICON]);
    vi.advanceTimersByTime(3000);
    expect(iconHrefs()).toEqual([STATIC_ICON]);
  });

  it('restores a custom base icon when cleared', async () => {
    setBaseFavicon('/uploads/logo.png');
    setFaviconAttention(true);
    await flush();
    setFaviconAttention(false);

    expect(iconHrefs()).toEqual(['/uploads/logo.png']);
  });

  it('a branding change keeps the attention overlay, redrawn over the new base', async () => {
    setBaseFavicon('/uploads/logo.png');
    setFaviconAttention(true);
    await flush();

    setBaseFavicon('data:image/png;base64,NODE');
    await flush();

    expect(iconHrefs()).toHaveLength(1);
    expect(iconHrefs()[0]).toContain('base=data:image/png;base64,NODE;alpha=1;');
  });

  it('falls back to a plain dot icon when the base image fails to load', async () => {
    setBaseFavicon('https://cdn.example/broken.png');
    setFaviconAttention(true);
    await flush();

    const href = iconHrefs()[0] ?? '';
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(href)).toContain('fill="hsl(10 20% 30%)"');
  });

  it('falls back to a plain dot icon when the canvas is tainted (cross-origin)', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => {
      throw new DOMException('tainted', 'SecurityError');
    });
    setBaseFavicon('https://cdn.example/logo.png');
    setFaviconAttention(true);
    await flush();

    expect(iconHrefs()[0]?.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('leaves index.html icons untouched when nothing was ever customised', () => {
    setBaseFavicon(null);
    setFaviconAttention(false);
    expect(iconHrefs()).toEqual([STATIC_ICON]);
  });
});
