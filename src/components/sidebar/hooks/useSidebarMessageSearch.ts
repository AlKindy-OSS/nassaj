import { useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

/**
 * Sidebar message search (B-332).
 *
 * Streams matches from GET /api/providers/search/sessions (SSE) — the same
 * server-side scan the command palette uses, but unscoped: every project the
 * caller may see is searched, because the sidebar filters the whole project
 * list. Authorization is enforced server-side; this hook never widens it.
 *
 * The scan reads transcripts off disk, so it is deliberately kept off the
 * keystroke path: minimum query length, a debounce, and results delivered
 * incrementally. Callers layer these matches on top of the instant local title
 * filter rather than waiting for them.
 */

/**
 * One matching conversation. `summary`/`provider`/`projectId` come from the
 * server payload so the sidebar can render the row even when that session is
 * not in the loaded page (projects load their newest 20 sessions only) — a
 * match the user cannot see is the same as no match at all.
 */
export type MessageSearchMatch = {
  sessionId: string;
  snippet: string;
  summary: string;
  provider: LLMProvider;
  projectId: string | null;
};

export type MessageSearchResult = {
  /** sessionId → its match. */
  matchBySessionId: Map<string, MessageSearchMatch>;
  /** Project ids that own ≥1 matching session (null-id projects are skipped). */
  projectIds: Set<string>;
  /** True while a scan for the current query is still streaming. */
  isSearching: boolean;
};

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  sessions: Array<{
    sessionId: string;
    provider: LLMProvider;
    sessionSummary: string;
    matches: Array<{ snippet: string }>;
  }>;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 350;

const EMPTY: MessageSearchResult = {
  matchBySessionId: new Map(),
  projectIds: new Set(),
  isSearching: false,
};

export function useSidebarMessageSearch(query: string, enabled: boolean): MessageSearchResult {
  const [result, setResult] = useState<MessageSearchResult>(EMPTY);
  const seqRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    const closeStream = () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };

    if (!enabled || trimmed.length < MIN_QUERY) {
      closeStream();
      seqRef.current++;
      setResult(EMPTY);
      return;
    }

    closeStream();
    // Invalidate any in-flight stream before the debounce elapses, so a stale
    // `result` event can never be applied to a newer query.
    seqRef.current++;
    setResult({ matchBySessionId: new Map(), projectIds: new Set(), isSearching: true });

    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      const source = new EventSource(api.searchConversationsUrl(trimmed));
      sourceRef.current = source;

      const matchBySessionId = new Map<string, MessageSearchMatch>();
      const projectIds = new Set<string>();

      source.addEventListener('result', (event) => {
        if (seq !== seqRef.current) {
          source.close();
          return;
        }
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { projectResult?: ProjectResult };
          const projectResult = payload.projectResult;
          if (!projectResult) {
            return;
          }
          if (projectResult.projectId) {
            projectIds.add(projectResult.projectId);
          }
          for (const session of projectResult.sessions) {
            if (!matchBySessionId.has(session.sessionId)) {
              matchBySessionId.set(session.sessionId, {
                sessionId: session.sessionId,
                snippet: session.matches[0]?.snippet ?? '',
                summary: session.sessionSummary,
                provider: session.provider,
                projectId: projectResult.projectId,
              });
            }
          }
          setResult({
            matchBySessionId: new Map(matchBySessionId),
            projectIds: new Set(projectIds),
            isSearching: true,
          });
        } catch {
          // Ignore malformed frames — the stream keeps going.
        }
      });

      const finish = () => {
        if (seq !== seqRef.current) {
          return;
        }
        source.close();
        sourceRef.current = null;
        setResult({
          matchBySessionId: new Map(matchBySessionId),
          projectIds: new Set(projectIds),
          isSearching: false,
        });
      };

      source.addEventListener('done', finish);
      source.addEventListener('error', finish);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [enabled, query]);

  // Close the stream when the sidebar unmounts so the server stops scanning.
  useEffect(() => () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  return result;
}
