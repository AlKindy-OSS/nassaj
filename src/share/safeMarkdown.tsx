import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { safeExternalHref } from './safeUrl';

/**
 * Markdown renderer for untrusted public content.
 *
 * Deliberately minimal: no raw HTML (skipHtml, no rehype-raw), images never load
 * (rendered as their alt text), links are limited to http/https and open in a new
 * context without referrer/opener, and links back to the Nassaj host are plain text
 * so a shared message cannot present a phishing link into the app.
 */

const PLACEHOLDER_ALT = 'صورة';

function currentHost(): string {
  try {
    return new URL(window.location.href).hostname;
  } catch {
    return '';
  }
}

export function SafeMarkdown({ text, selfHost }: { text: string; selfHost?: string }) {
  const host = selfHost ?? currentHost();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      // Decisions happen in `a`/`img`; never let the library rewrite a URL into something else.
      urlTransform={(url) => url}
      components={{
        a({ href, children }: { href?: string; children?: ReactNode }) {
          const safe = safeExternalHref(href, host);
          if (!safe) return <span>{children}</span>;
          return (
            <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          );
        },
        img({ alt }: { alt?: string }) {
          return <span className="share-image-text">{alt?.trim() || PLACEHOLDER_ALT}</span>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
