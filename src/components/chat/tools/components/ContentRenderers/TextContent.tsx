import React from 'react';

import { resolveTextDirection } from '../../../../../utils/textDirection';

interface TextContentProps {
  content: string;
  format?: 'plain' | 'json' | 'code';
  className?: string;
}

/**
 * Renders plain text, JSON, or code content
 * Used by: Raw parameters, generic text results, JSON responses
 */
export const TextContent: React.FC<TextContentProps> = ({
  content,
  format = 'plain',
  className = ''
}) => {
  if (format === 'json') {
    let formattedJson = content;
    try {
      const parsed = JSON.parse(content);
      formattedJson = JSON.stringify(parsed, null, 2);
    } catch (e) {
      // If parsing fails, use original content
      console.warn('Failed to parse JSON content:', e);
    }

    return (
      <pre className={`mt-1 overflow-x-auto rounded bg-gray-900 p-2.5 font-mono text-xs text-gray-100 dark:bg-gray-950 ${className}`}>
        {formattedJson}
      </pre>
    );
  }

  if (format === 'code') {
    return (
      <pre className={`mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-gray-200/50 bg-gray-50 p-2 font-mono text-xs text-gray-700 dark:border-gray-700/50 dark:bg-gray-800/50 dark:text-gray-300 ${className}`}>
        {content}
      </pre>
    );
  }

  // Plain text — free prose in the user's language, so its base direction is
  // resolved from the content itself (majority of strong characters, never
  // first-strong: a result that opens with a Latin identifier is still Arabic).
  // The `json`/`code` branches above stay untouched: `pre` is pinned LTR in
  // index.css because it is Latin by construction, not by language.
  return (
    <div
      className={`mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 ${className}`}
      dir={resolveTextDirection(content) ?? undefined}
    >
      {content}
    </div>
  );
};
