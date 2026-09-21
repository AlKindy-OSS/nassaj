import React from 'react'
import ReactDOM from 'react-dom/client'

// Guaranteed Arabic glyph fallback for terminal output regardless of UI font.
import '@fontsource/ibm-plex-sans-arabic/400.css'
import 'katex/dist/katex.min.css'
// xterm's structural CSS serves Shell and the project-independent panel.
import '@xterm/xterm/css/xterm.css'
import App from './App.tsx'
import './i18n/config.js'
import './index.css'
import { applyStoredUiFont } from './lib/ui-font'
import { applyStoredThemePreset } from './lib/theme-presets'
import { installSystemBarsBridge } from './native/systemBarsBridge'
import { installPreferenceWriteMirror } from './preferences/preferencesSync'

// Apply the stored brand theme preset before first paint so the default
// theme never flashes (ThemeContext keeps it in sync afterwards).
applyStoredThemePreset()

// The Android wrapper exposes this narrowly scoped WebMessage object. In a
// browser/PWA the installer is a no-op; in the wrapper it mirrors the resolved
// meta theme color without duplicating the preset table here.
const uninstallSystemBarsBridge = installSystemBarsBridge()
if (import.meta.hot) {
  import.meta.hot.dispose(uninstallSystemBarsBridge)
}

// Same idea for the interface font: write `--font-ui` (and start the lazy
// @fontsource download for a non-default choice) before the first paint, so the
// UI never renders in the system stack and re-flows into the chosen family.
applyStoredUiFont()

// Mirror synced UI preferences to the user's account. Patching setItem here —
// before any preference owner runs — ensures every synced write is captured.
// Stays dormant until a token exists and the server route proves reachable, so
// pre-login and pre-restart behaviour is unchanged (localStorage only).
installPreferenceWriteMirror()

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
