/**
 * Browser-side helper for measure-prose-fence.mjs (B-1674). Served by the
 * project's Vite dev server so it shares the app's module graph (React, i18n,
 * src/index.css) and renders the real chat `Markdown` component.
 */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { AuthProvider } from '../../src/components/auth/index.ts';
import { Markdown } from '../../src/components/chat/view/subcomponents/Markdown.tsx';

/** Renders `source` through the chat Markdown into a fresh host appended to <body>. */
export function mountMarkdown(id, source, messageDir) {
  const host = document.createElement('div');
  host.id = id;
  host.style.width = '640px';
  host.dir = messageDir;
  document.body.appendChild(host);
  flushSync(() => {
    createRoot(host).render(createElement(AuthProvider, null, createElement(Markdown, null, source)));
  });
  return host;
}
