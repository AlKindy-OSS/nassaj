import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';

import { readCredentials } from './loadShare';
import { ShareApp } from './ShareApp';

/**
 * Public share viewer entry. Runs in an opaque-origin sandbox and is isolated from
 * the app by construction: it reads no storage, registers no service worker, opens
 * no socket and imports nothing from src/components (ESLint-enforced).
 */
// Read once at load: the fragment token is consumed (and erased) by this call.
const credentials = readCredentials(window.location, window.history);
createRoot(document.getElementById('root')!).render(<ShareApp credentials={credentials} />);
