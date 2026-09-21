import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, SquareTerminal } from "lucide-react";

import { authenticatedFetch } from "../../../utils/api";
import { copyTextToClipboard } from "../../../utils/clipboard";

const POLL_MS = 1_500;
const RETRY_MS = 3_000;
const MAX_KEPT_CHARS = 2 * 1024 * 1024;
const MAX_RENDERED_LINES = 2_000;

/**
 * Poll the job's live log from a byte offset while `enabled` (T-1768). Keeps
 * polling through the activation restart (fetch errors back off and retry) and
 * stops after one last read once the job is no longer live.
 */
function useUpdateJobLog(logPath: string | null, enabled: boolean, live: boolean): string {
    const [text, setText] = useState('');
    const offsetRef = useRef(0);
    const liveRef = useRef(live);
    liveRef.current = live;

    useEffect(() => {
        offsetRef.current = 0;
        setText('');
    }, [logPath]);

    useEffect(() => {
        if (!logPath || !enabled) return undefined;
        let cancelled = false;
        let timer: number | null = null;
        const controller = new AbortController();
        const poll = async () => {
            const wasLive = liveRef.current;
            let delay = POLL_MS;
            try {
                const response = await authenticatedFetch(`${logPath}?offset=${offsetRef.current}`, { signal: controller.signal });
                if (response.ok) {
                    const data = await response.json() as { offset?: unknown; text?: unknown };
                    const chunk = typeof data.text === 'string' ? data.text : '';
                    if (typeof data.offset === 'number') offsetRef.current = data.offset;
                    if (chunk) setText(previous => (previous + chunk).slice(-MAX_KEPT_CHARS));
                    // More is already waiting: read it now rather than a poll later.
                    if (chunk.length > 0 && typeof data.offset === 'number') delay = 0;
                    else if (!wasLive) return;
                } else {
                    delay = RETRY_MS;
                }
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') return;
                delay = RETRY_MS;
            }
            if (!cancelled) timer = window.setTimeout(() => void poll(), delay);
        };
        void poll();
        return () => {
            cancelled = true;
            controller.abort();
            if (timer !== null) window.clearTimeout(timer);
        };
    }, [enabled, logPath]);

    return text;
}

function lineClass(line: string): string {
    if (line.startsWith('$ ')) return 'text-sky-300';
    if (/^\[\d{2}:\d{2}:\d{2}\] (?:✗|⚠)/.test(line)) return 'text-amber-300';
    if (/^\[\d{2}:\d{2}:\d{2}\] /.test(line)) return 'text-emerald-300';
    return 'text-zinc-200';
}

interface UpdateTerminalLogProps {
    /** The job's status path; the log lives at `<statusUrl>/log`. */
    statusUrl?: string;
    /** The job is still running, so the log may still grow. */
    live: boolean;
}

/**
 * A collapsible console under the update stepper, like a Linux installer's
 * "show details": every command the updater runs and its output, live.
 */
export function UpdateTerminalLog({ statusUrl, live }: UpdateTerminalLogProps) {
    const { t } = useTranslation('common');
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const scrollRef = useRef<HTMLPreElement | null>(null);
    const stickRef = useRef(true);
    const logPath = statusUrl ? `${statusUrl.split('?')[0]}/log` : null;
    const text = useUpdateJobLog(logPath, open, live);

    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const hidden = Math.max(0, lines.length - MAX_RENDERED_LINES);
    const shown = hidden > 0 ? lines.slice(hidden) : lines;

    // Follow new output only while the reader is at the bottom.
    useLayoutEffect(() => {
        const node = scrollRef.current;
        if (node && stickRef.current) node.scrollTop = node.scrollHeight;
    }, [text, open]);

    if (!logPath) return null;

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={() => setOpen(value => !value)}
                    aria-expanded={open}
                    aria-controls={panelId}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                    <SquareTerminal aria-hidden="true" className="h-3.5 w-3.5" />
                    {open ? t('versionUpdate.terminal.hide') : t('versionUpdate.terminal.show')}
                    <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && text && (
                    <button
                        type="button"
                        onClick={() => copyTextToClipboard(text)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                        {t('versionUpdate.terminal.copy')}
                    </button>
                )}
            </div>
            {open && (
                <div id={panelId} className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                    {hidden > 0 && (
                        <p className="border-b border-zinc-800 px-3 py-1 text-[11px] text-zinc-400">
                            {t('versionUpdate.terminal.truncatedView', { count: MAX_RENDERED_LINES })}
                        </p>
                    )}
                    <pre
                        ref={scrollRef}
                        dir="ltr"
                        role="log"
                        aria-live="off"
                        aria-label={t('versionUpdate.terminal.label')}
                        tabIndex={0}
                        onScroll={event => {
                            const node = event.currentTarget;
                            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
                        }}
                        className="max-h-72 overflow-auto whitespace-pre-wrap break-all p-3 text-start font-mono text-[11px] leading-5"
                    >
                        {shown.length === 0
                            ? <span className="text-zinc-400">{t('versionUpdate.terminal.empty')}</span>
                            : shown.map((line, index) => (
                                <span key={hidden + index} className={`block ${lineClass(line)}`}>{line || ' '}</span>
                            ))}
                        {live && shown.length > 0 && (
                            <span aria-hidden="true" className="inline-block h-3 w-1.5 animate-pulse bg-zinc-300 motion-reduce:animate-none" />
                        )}
                    </pre>
                </div>
            )}
        </div>
    );
}
