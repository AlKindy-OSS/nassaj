import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: null as null | { id: number; role: string }, token: null as string | null,
  isLoading: false, mustChangePassword: false, logout: vi.fn() }));
vi.mock('../auth/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../auth/view/LoginForm', () => ({ default: () => <div>EXISTING_LOGIN_FORM</div> }));
vi.mock('../auth/view/ForceChangePasswordForm', () => ({ default: () => <div>ROTATE_PASSWORD</div> }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('../../contexts/RtlContext', () => ({ useRtl: () => ({ rtlLayout: true }) }));
vi.mock('../../contexts/BrandingContext', () => ({ useBranding: () => ({ title: null, isLoading: false }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'ar' }, t: (key: string) => key }) }));

import SharedDocumentPage from './SharedDocumentPage';
import ShareLoginPage from './ShareLoginPage';
import DocumentShareButton from './DocumentShareButton';
import { safeShareReturn, shareLoginPath } from './share-navigation';
import { pageAssetScope, shareableReference, validCreatedShareUrl } from './share-contract';

const id = 'a'.repeat(32);
const token = 'b'.repeat(43);
const fetchMock = vi.fn();
const metadata = { document: { name: 'proposal.pdf', size: 20, modifiedAt: '2026-09-13T10:00:00Z', downloadPath: `/api/document-shares/${id}/content` } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Location() { const value = useLocation(); return <span data-testid="location">{value.pathname}{value.search}</span>; }
function openPage(entry: string) {
  return render(<MemoryRouter initialEntries={[entry]}><Location /><Routes>
    <Route path="/share/members/:id" element={<SharedDocumentPage members />} />
    <Route path="/share/:id" element={<SharedDocumentPage />} />
    <Route path="/login" element={<ShareLoginPage />} />
    <Route path="/" element={<div>HOME</div>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  auth.user = null; auth.token = null; auth.isLoading = false; auth.mustChangePassword = false;
  auth.logout.mockReset(); fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('public document states', () => {
  it('shows the Nassaj identity and a nonrevealing unavailable page for invalid links', () => {
    openPage('/share/wrong');
    expect(screen.getByRole('heading', { name: 'هذا الرابط غير متاح' })).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('src')).toContain('nassaj-logo');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps the client secret out of the request URL and sends it only in the header', async () => {
    fetchMock.mockResolvedValue(response(metadata));
    openPage(`/share/${id}#token=${token}`);
    expect(await screen.findByText('proposal.pdf')).toBeTruthy();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/document-shares/${id}`);
    expect(options.headers).toEqual({ 'X-Share-Token': token });
    expect(options.referrerPolicy).toBe('no-referrer');
    expect(options.credentials).toBe('omit');
  });
  it.each([404, 410])('uses one unavailable message for status %i without showing metadata', async (status) => {
    fetchMock.mockResolvedValue(response({ error: { code: 'SHARE_UNAVAILABLE' } }, status));
    openPage(`/share/${id}#token=${token}`);
    expect(await screen.findByRole('heading', { name: 'هذا الرابط غير متاح' })).toBeTruthy();
    expect(screen.queryByText('proposal.pdf')).toBeNull();
  });
  it('recovers from a network error without signing out or claiming the link is wrong', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(metadata));
    openPage(`/share/${id}#token=${token}`);
    fireEvent.click(await screen.findByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('proposal.pdf')).toBeTruthy();
    expect(auth.logout).not.toHaveBeenCalled();
  });
  it('rechecks access on download and removes metadata after revocation', async () => {
    fetchMock.mockResolvedValueOnce(response(metadata)).mockResolvedValueOnce(response({}, 404));
    openPage(`/share/${id}#token=${token}`);
    fireEvent.click(await screen.findByRole('button', { name: 'تنزيل المستند' }));
    expect(await screen.findByRole('heading', { name: 'هذا الرابط غير متاح' })).toBeTruthy();
    expect(screen.queryByText('proposal.pdf')).toBeNull();
  });
});

describe('member login and return', () => {
  it('asks for login before any identifier lookup and preserves the exact member destination', async () => {
    openPage(`/share/members/${id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'تسجيل الدخول' }));
    expect(screen.getByText('EXISTING_LOGIN_FORM')).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(shareLoginPath(`/share/members/${id}`));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('returns after valid login and rechecks document permissions', async () => {
    auth.user = { id: 2, role: 'user' }; auth.token = 'jwt';
    fetchMock.mockResolvedValue(response(metadata));
    openPage(shareLoginPath(`/share/members/${id}`));
    expect(await screen.findByText('proposal.pdf')).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(`/share/members/${id}`);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer jwt' });
  });
  it('allows changing an unauthorized account without an automatic login loop', async () => {
    auth.user = { id: 3, role: 'user' }; auth.token = 'jwt';
    auth.logout.mockImplementation(() => { auth.user = null; auth.token = null; });
    fetchMock.mockResolvedValue(response({}, 403));
    openPage(`/share/members/${id}`);
    expect(await screen.findByRole('heading', { name: 'لا يمكنك الوصول بهذا الحساب' })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(`/share/members/${id}`);
    fireEvent.click(screen.getByRole('button', { name: 'استخدام حساب آخر' }));
    expect(screen.getByText('EXISTING_LOGIN_FORM')).toBeTruthy();
  });
  it('does not bypass forced password rotation while returning', () => {
    auth.user = { id: 2, role: 'user' }; auth.token = 'jwt'; auth.mustChangePassword = true;
    openPage(shareLoginPath(`/share/members/${id}`));
    expect(screen.getByText('ROTATE_PASSWORD')).toBeTruthy();
  });
  it('rejects external, encoded and looping destinations and keeps independent tab destinations', () => {
    for (const value of ['https://evil.test', '//evil.test', '/login', '/share/members/../login', '%2f%2fevil.test', `/share/members/${id}?next=evil`, `/share/${id}#token=secret`]) {
      expect(safeShareReturn(value)).toBeNull();
    }
    const other = 'c'.repeat(32);
    expect(shareLoginPath(`/share/members/${id}`)).not.toBe(shareLoginPath(`/share/members/${other}`));
  });
});

describe('share management', () => {
  it('offers management only to a verified administrator and supported file formats', () => {
    auth.user = { id: 2, role: 'user' }; auth.token = 'jwt';
    render(<DocumentShareButton projectId="p1" filePath="docs/a.txt" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('creates from the canonical relative path and shows a one-time copyable link after success', async () => {
    auth.user = { id: 1, role: 'owner' }; auth.token = 'jwt';
    fetchMock.mockResolvedValueOnce(response({ shares: [], projectPath: '/project' }))
      .mockResolvedValueOnce(response({ shareUrl: `${window.location.origin}/share/${id}#token=${token}`, sharePath: '/ignored' }, 201))
      .mockResolvedValueOnce(response({ shares: [], projectPath: '/project' }));
    render(<DocumentShareButton projectId="p1" filePath="/project/docs/proposal.pdf" />);
    fireEvent.click(screen.getByRole('button', { name: 'مشاركة المستند' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'إنشاء الرابط ونسخه' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByLabelText('كل من يحمل الرابط'));
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء الرابط ونسخه' }));
    const link = await screen.findByLabelText('رابط المشاركة جاهز');
    expect((link as HTMLInputElement).value).toContain(`#token=${token}`);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toEqual({ relativePath: 'docs/proposal.pdf', audience: 'client', expiresAt: null });
    expect(screen.getByRole('dialog').hasAttribute('data-document-share-dialog')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('page sharing safety', () => {
  it.each(['docs/a.html', 'doc/a.htm', 'docs/a.xhtml', 'docs/ملف%20تجريبي.html'])('recognizes supported local references: %s', href => {
    expect(shareableReference(href)).toBe(decodeURIComponent(href));
  });
  it.each(['https://evil.test/docs/a.html', '/docs/a.html', 'docs/../private.html', 'docs/%2e%2e/a.html', 'docs/a.html?projectId=other',
    'docs/a.html#x', 'docs/.secret.html', 'docs/a%252fsecret.html', 'docs/a%00.html', 'docs/x.js'])('rejects ambiguous references: %s', href => {
    expect(shareableReference(href)).toBeNull();
  });
  it('pins the scope and validates actual URL results without trusting sharePath', () => {
    expect(pageAssetScope('docs/page.html')).toBe('docs/page.assets');
    expect(pageAssetScope('docs/a.pdf')).toBeNull();
    const origin = 'https://nassaj.example.com';
    expect(validCreatedShareUrl(`${origin}/share/${id}#token=${token}`, origin)).toBe(true);
    for (const url of [`https://evil.test/share/${id}#token=${token}`, `${origin}/share/${id}#token=`,
      `https://user:pass@nassaj.example.com/share/${id}#token=${token}`, `${origin}/share/${id}?x=y#token=${token}`]) {
      expect(validCreatedShareUrl(url, origin)).toBe(false);
    }
  });
  it('loads the fixed preview endpoint with credentials outside the empty sandbox', async () => {
    fetchMock.mockResolvedValueOnce(response({ document: { ...metadata.document, name: 'page.html', previewPath: `/api/document-shares/${id}/preview` } }))
      .mockResolvedValueOnce(response({ html: '<h1>Safe preview</h1>', warnings: ['RESOURCE_REMOVED'] }));
    const view = openPage(`/share/${id}#token=${token}`);
    const frame = await screen.findByTitle('معاينة آمنة للصفحة');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain("script-src 'none'");
    expect(frame.getAttribute('srcdoc')).not.toContain(token);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/document-shares/${id}/preview`);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'X-Share-Token': token });
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toBeNull();
  });
  it('removes preview and metadata when permission is revoked before preview loading', async () => {
    fetchMock.mockResolvedValueOnce(response({ document: { ...metadata.document, previewPath: `/api/document-shares/${id}/preview` } }))
      .mockResolvedValueOnce(response({}, 404));
    openPage(`/share/${id}#token=${token}`);
    expect(await screen.findByRole('heading', { name: 'هذا الرابط غير متاح' })).toBeTruthy();
    expect(screen.queryByTitle('معاينة آمنة للصفحة')).toBeNull();
  });
  it('clears created links on project changes and never recreates after clipboard denial', async () => {
    auth.user = { id: 1, role: 'owner' }; auth.token = 'jwt';
    fetchMock.mockImplementation((_url: string, options: RequestInit) => Promise.resolve(response(options?.method === 'POST'
      ? { shareUrl: `${window.location.origin}/share/${id}#token=${token}` } : { shares: [], projectPath: '/project' })));
    const view = render(<DocumentShareButton projectId="p1" filePath="docs/page.html" />);
    fireEvent.click(screen.getByRole('button', { name: 'مشاركة المستند' }));
    expect(await screen.findByText('docs/page.assets/')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'إنشاء الرابط ونسخه' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء الرابط ونسخه' }));
    await screen.findByLabelText('رابط المشاركة جاهز');
    expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    view.rerender(<DocumentShareButton projectId="p2" filePath="docs/page.html" />);
    expect(screen.queryByLabelText('رابط المشاركة جاهز')).toBeNull();
  });
});
