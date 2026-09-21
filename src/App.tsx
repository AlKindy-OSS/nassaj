import { Navigate, BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from './contexts/ThemeContext';
import { RtlProvider } from './contexts/RtlContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import JoinPage from './components/auth/view/JoinPage';
import SharedDocumentPage from './components/document-sharing/SharedDocumentPage';
import ShareLoginPage from './components/document-sharing/ShareLoginPage';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { BrandingProvider } from './contexts/BrandingContext';
import AppContent from './components/app/AppContent';
import WikiPanel from './components/wiki/view/WikiPanel';
import i18n from './i18n/config.js';

// The authenticated application shell. Everything here sits behind
// ProtectedRoute (login gate + onboarding) and the realtime/data providers.
function AuthenticatedApp() {
  return (
    <WebSocketProvider>
      <ProtectedRoute>
        <Routes>
          <Route path="/" element={<AppContent />} />
          <Route path="/session/:sessionId" element={<AppContent />} />
          <Route path="/scheduled" element={<AppContent />} />
          {/* The wiki panel is `h-full` and owns its own internal scrolling.
              `#root` only sets `min-height`, which does not give a percentage
              height anything to resolve against, so on this standalone route
              the panel used to fall back to content height. Two visible
              consequences: the sticky toolbar never stuck (the document
              scrolled instead of the panel's inner container), and the
              collapsed index — width:0 but with 19 titles wrapping inside it —
              imposed its ~2500px intrinsic height on the flex row, leaving
              1195px of blank page below the footer. A definite height on the
              wrapper fixes both. As a tab inside MainContent the panel already
              has a sized flex parent, which is why only this route was
              affected. */}
          <Route
            path="/wiki"
            element={
              <div className="wiki-standalone-shell overflow-hidden">
                <WikiPanel standalone />
              </div>
            }
          />
          {/* No route matched, yet the user IS authenticated — render the app
              instead of nothing. `/login` is the case that bites: AuthContext
              sends a 401 there, the login form renders on any path, and after
              a successful sign-in the URL is still /login — which used to
              match no route and paint a blank page (B-313). */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ProtectedRoute>
    </WebSocketProvider>
  );
}

const DEPLOYMENT_ASSET_DIRECTORIES = new Set(['assets', 'static', 'icons', 'images']);

/**
 * Detect the router basename from explicit runtime config or deployment hints.
 *
 * CloudCLI can be served from a path prefix by a reverse proxy, for example:
 *   /ai/manifest.json
 *   /ai/assets/index-abc123.js
 *   /ai/icons/icon-192x192.png
 *
 * React Router needs that prefix as its basename, but the packaged app should
 * also keep working when served directly from the domain root. The direct-root
 * case is easy to misread because asset URLs such as /icons/icon-192x192.png
 * contain a directory even though there is no application basename.
 */
function detectRouterBasename() {
  const explicitBasename = typeof window !== 'undefined' ? window.__ROUTER_BASENAME__ || '' : '';
  if (explicitBasename) {
    // Keep the deployment escape hatch authoritative. A trailing slash is
    // harmless for humans but React Router expects a normalized basename.
    return explicitBasename.replace(/\/+$/, '');
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '';
  }

  const candidatePaths = [
    { kind: 'manifest' as const, value: document.querySelector('link[rel="manifest"]')?.getAttribute('href') },
    { kind: 'script' as const, value: document.querySelector('script[type="module"][src]')?.getAttribute('src') },
    ...Array.from(
      document.querySelectorAll(
        'link[rel~="icon"][href], link[rel="apple-touch-icon"][href], link[rel="apple-touch-icon-precomposed"][href], link[rel="mask-icon"][href]'
      )
    ).map((node) => ({
      kind: 'icon' as const,
      value: node.getAttribute('href'),
    })),
  ].filter((candidate): candidate is { kind: 'manifest' | 'script' | 'icon'; value: string } => Boolean(candidate.value));

  let detectedBasename = '';
  for (const candidate of candidatePaths) {
    try {
      const candidateUrl = new URL(candidate.value, document.baseURI || window.location.href);
      if (candidateUrl.origin !== window.location.origin) {
        continue;
      }

      // A sealed asset generation is a storage address, not a router mount.
      const pathname = candidateUrl.pathname.replace(/^\/assets\/generations\/[a-f0-9]{64}(?=\/)/, '');
      const normalizedPathname = pathname.replace(/\/+$/, '');

      let normalized = '';
      if (candidate.kind === 'script') {
        const match = normalizedPathname.match(/^(.*)\/assets\//);
        normalized = match?.[1] ? match[1].replace(/\/+$/, '') : '';
      } else {
        const manifestMatch = normalizedPathname.match(/^(.*)\/(?:manifest\.json|site\.webmanifest)$/);
        const iconMatch = normalizedPathname.match(
          /^(.*)\/(?:favicon(?:\.[^/]+)?|apple-touch-icon(?:-[^/]+)?(?:\.[^/]+)?|mask-icon(?:\.[^/]+)?|[^/]*icon[^/]*)$/
        );
        const match = candidate.kind === 'manifest' ? manifestMatch : iconMatch;
        if (match?.[1]) {
          const segments = match[1].split('/').filter(Boolean);

          // Strip directories that describe where static files live, not where
          // the app is mounted. This must also run for a single segment:
          //   /icons/icon-192x192.png       -> ''
          //   /ai/icons/icon-192x192.png    -> '/ai'
          // The previous implementation only stripped while more than one
          // segment remained, which incorrectly turned root deployments into a
          // Router basename of /icons and caused a blank page after login.
          while (segments.length > 0 && DEPLOYMENT_ASSET_DIRECTORIES.has(segments[segments.length - 1])) {
            segments.pop();
          }

          normalized = segments.length > 0 ? `/${segments.join('/')}` : '';
        }
      }

      if (normalized.length > detectedBasename.length) {
        detectedBasename = normalized;
      }
    } catch {
      // Ignore invalid candidate URLs and continue checking other hints.
    }
  }

  return detectedBasename;
}

export default function App() {
  const routerBasename = detectRouterBasename();

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <RtlProvider>
            <AuthProvider>
              {/* Branding sits ABOVE the auth gate: its endpoint is public, so the
                  login/setup/join screens and the document chrome (title/favicon)
                  already carry the custom identity before any token exists. */}
              <BrandingProvider>
                <Router basename={routerBasename}>
                  <Routes>
                    {/* Public invite-acceptance route — must bypass the auth gate. */}
                    <Route path="/join" element={<JoinPage />} />
                    <Route path="/share/members/:id" element={<SharedDocumentPage members />} />
                    <Route path="/share/:id" element={<SharedDocumentPage />} />
                    <Route path="/share/*" element={<SharedDocumentPage />} />
                    <Route path="/login" element={<ShareLoginPage />} />
                    {/* Everything else is gated behind authentication. */}
                    <Route path="/*" element={<AuthenticatedApp />} />
                  </Routes>
                </Router>
              </BrandingProvider>
            </AuthProvider>
        </RtlProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
