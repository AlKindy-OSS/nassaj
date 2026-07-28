import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'

// Apply the stored brand theme preset before first paint so the default
// theme never flashes (ThemeContext keeps it in sync afterwards).
import { applyStoredThemePreset } from './lib/theme-presets'
applyStoredThemePreset()

// Same idea for the interface font: write `--font-ui` (and start the lazy
// @fontsource download for a non-default choice) before the first paint, so the
// UI never renders in the system stack and re-flows into the chosen family.
import { applyStoredUiFont } from './lib/ui-font'
applyStoredUiFont()

// Mirror synced UI preferences to the user's account. Patching setItem here —
// before any preference owner runs — ensures every synced write is captured.
// Stays dormant until a token exists and the server route proves reachable, so
// pre-login and pre-restart behaviour is unchanged (localStorage only).
import { installPreferenceWriteMirror } from './preferences/preferencesSync'
installPreferenceWriteMirror()

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
