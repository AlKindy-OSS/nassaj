import { describe, expect, it } from 'vitest';

import { originalLinkFor } from './lightboxOriginalLink';

const BASE = 'https://app.example/chat';

describe('originalLinkFor', () => {
  it('رابط http(s) يفتح الأصل في تبويب جديد', () => {
    expect(originalLinkFor('https://cdn.example/a.png', BASE)).toEqual({ kind: 'open', href: 'https://cdn.example/a.png' });
    expect(originalLinkFor('/api/files/a.png', BASE)).toEqual({ kind: 'open', href: 'https://app.example/api/files/a.png' });
  });

  it('blob: وdata: تنزيل لا تنقّل', () => {
    expect(originalLinkFor('blob:https://app.example/1234', BASE)?.kind).toBe('download');
    expect(originalLinkFor('data:image/png;base64,AA==', BASE)?.kind).toBe('download');
  });

  it('SVG لا يُفتح مستنداً أبداً', () => {
    expect(originalLinkFor('/api/files/a.svg', BASE)?.kind).toBe('download');
    expect(originalLinkFor('https://app.example/f/A.SVG?x=1', BASE)?.kind).toBe('download');
    // Cross-origin: the browser ignores `download` and would navigate, so no control.
    expect(originalLinkFor('https://cdn.example/a.svg', BASE)).toBeNull();
    expect(originalLinkFor('data:image/svg+xml;base64,AA==', BASE)?.kind).toBe('download');
  });

  it('المخططات الأخرى لا تعطي رابطاً', () => {
    expect(originalLinkFor('javascript:alert(1)', BASE)).toBeNull();
    expect(originalLinkFor('file:///etc/passwd', BASE)).toBeNull();
  });
});
