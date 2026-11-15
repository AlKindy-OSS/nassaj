/**
 * حدود الصور (الحجم والعدد) وحجم الملف المرفق حقول رقمية لا قوائم ثابتة،
 * ولا يصل الخادمَ إلا عددٌ صحيح داخل مداه (يطابق `STORAGE_POLICY_BOUNDS`).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const fetchMock = vi.fn();
vi.mock('../../../../utils/api', () => ({
  api: {},
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import StoragePolicySection from './StoragePolicySection';

const POLICY = {
  retentionDays: 30,
  retentionDaysIsDefault: true,
  imageMaxMb: 5,
  imageMaxMbIsDefault: true,
  imageMaxCount: 15,
  imageMaxCountIsDefault: true,
  attachmentMaxMb: 50,
  attachmentMaxMbIsDefault: true,
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PUT') return Promise.resolve(jsonResponse({ ...POLICY, ...JSON.parse(init.body ?? '{}') }));
    return Promise.resolve(jsonResponse(POLICY));
  });
});

afterEach(cleanup);

function putCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
}

async function field(label: string) {
  return (await screen.findByLabelText(label)) as HTMLInputElement;
}

function typeAndBlur(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

const CASES = [
  { label: 'storagePolicy.imageMbLabel', key: 'imageMaxMb', min: 1, max: 25, saved: '5', valid: 10 },
  { label: 'storagePolicy.imageCountLabel', key: 'imageMaxCount', min: 1, max: 50, saved: '15', valid: 30 },
  { label: 'storagePolicy.attachmentMbLabel', key: 'attachmentMaxMb', min: 1, max: 200, saved: '50', valid: 120 },
] as const;

describe.each(CASES)('StoragePolicySection — $key', ({ label, key, min, max, saved, valid }) => {
  it('حقل رقمي بمدى الخادم لا قائمة اختيار', async () => {
    render(<StoragePolicySection />);
    const input = await field(label);
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('number');
    expect(input.min).toBe(String(min));
    expect(input.max).toBe(String(max));
    expect(input.value).toBe(saved);
  });

  it.each([String(min - 1), String(max + 1), '2.5', ''])('القيمة %s لا تُرسل وتعود المسودّة للمحفوظ', async (bad) => {
    render(<StoragePolicySection />);
    const input = await field(label);
    typeAndBlur(input, bad);
    expect(putCalls()).toHaveLength(0);
    expect(input.value).toBe(saved);
  });

  it('قيمة صحيحة ضمن المدى تُحفظ عند المغادرة', async () => {
    render(<StoragePolicySection />);
    const input = await field(label);
    typeAndBlur(input, String(valid));
    expect(putCalls()).toHaveLength(1);
    expect(JSON.parse(putCalls()[0][1].body)).toEqual({ [key]: valid });
    await vi.waitFor(() => expect(input.value).toBe(String(valid)));
  });

  it('Enter يحفظ كذلك', async () => {
    render(<StoragePolicySection />);
    const input = await field(label);
    input.focus();
    fireEvent.change(input, { target: { value: String(valid) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(putCalls()).toHaveLength(1);
  });
});

describe('StoragePolicySection — attachment network note', () => {
  it('warns that some networks block uploads above 100 MB, range stays 1..200', async () => {
    render(<StoragePolicySection />);
    const input = await field('storagePolicy.attachmentMbLabel');
    expect(input.max).toBe('200');
    expect(screen.getByText('storagePolicy.attachmentMbHint')).toBeTruthy();
  });
});
