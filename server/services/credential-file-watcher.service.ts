/**
 * credential-file-watcher — read-only observer of every member's provider
 * credential files (B-1771).
 *
 * On 2026-11-09 a member's Claude `.credentials.json` was rewritten without a
 * refresh token and every chat of that member failed "Not logged in"; nothing
 * recorded when the file changed or what it lost. This service watches each
 * member tree (`~/.nassaj-users/<id>/`) for the files in PROVIDER_CREDENTIAL_FILES
 * and logs ONE structured line per settled change: provider, userId, path,
 * mtime, size, value-free presence booleans, the link state and the previous one.
 * A move out of a healthy state, or losing a field that was present, is a WARN.
 *
 * Guarantees: it never writes, never logs a credential value or part of one,
 * watches the parent DIRECTORY (an atomic temp+rename replace changes the inode,
 * so a file watch would go deaf), debounces bursts, tolerates missing trees, caps
 * its watchers, and a periodic rescan both attaches dirs created later and
 * catches a change a dropped fs event missed. Writer attribution is not
 * attempted: naming live processes would mean reading their environment or
 * command line, which can hold secrets.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  PROVIDER_CREDENTIAL_FILES,
  isCredentialDegrade,
  lostFields,
  readCredentialFileSnapshot,
  type CredentialFileSnapshot,
  type CredentialFileSpec,
} from '@/modules/providers/services/provider-credential-files.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';

type LogFn = (line: string) => void;

export type CredentialFileWatcherOptions = {
  /** Root holding one numeric directory per member; defaults to ~/.nassaj-users. */
  usersRoot?: string;
  specs?: ReadonlyArray<CredentialFileSpec>;
  logger?: { info: LogFn; warn: LogFn };
  debounceMs?: number;
  /** Rescan period; 0 disables the timer (rescan() stays callable). */
  rescanMs?: number;
  maxWatchers?: number;
};

export type CredentialFileWatcher = {
  start: () => Promise<void>;
  rescan: () => Promise<void>;
  stop: () => Promise<void>;
  watcherCount: () => number;
};

type Entry = {
  spec: CredentialFileSpec;
  userId: string;
  dir: string;
  file: string;
  snapshot: CredentialFileSnapshot;
  watcher?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
};

const LOG_TAG = '[credential-watch]';
const MEMBER_DIR = /^\d+$/u;

function defaultUsersRoot(): string {
  return path.dirname(userConfigDir('0'));
}

function listMemberIds(usersRoot: string): string[] {
  try {
    return fs.readdirSync(usersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && MEMBER_DIR.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Creates the watcher; nothing is watched until start(). */
export function createCredentialFileWatcher(options: CredentialFileWatcherOptions = {}): CredentialFileWatcher {
  const specs = options.specs ?? PROVIDER_CREDENTIAL_FILES;
  const logger = options.logger ?? { info: console.info, warn: console.warn };
  const debounceMs = options.debounceMs ?? 500;
  const rescanMs = options.rescanMs ?? 60_000;
  const maxWatchers = options.maxWatchers ?? 1024;
  const entries = new Map<string, Entry>();
  let usersRoot = '';
  let interval: NodeJS.Timeout | undefined;
  let running = false;
  let capLogged = false;

  const emit = (level: 'info' | 'warn', record: Record<string, unknown>) => {
    logger[level](`${LOG_TAG} ${JSON.stringify(record)}`);
  };
  const watcherCount = () => [...entries.values()].filter((entry) => entry.watcher).length;

  function evaluate(entry: Entry): void {
    if (!running) return;
    const previous = entry.snapshot;
    const current = readCredentialFileSnapshot(entry.spec, entry.file);
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size && current.state === previous.state) return;
    entry.snapshot = current;
    const lost = lostFields(previous, current);
    const degraded = lost.length > 0 || isCredentialDegrade(entry.spec, previous.state, current.state);
    emit(degraded ? 'warn' : 'info', {
      event: 'credential_file_change',
      provider: entry.spec.provider,
      userId: entry.userId,
      path: entry.file,
      mtime: current.mtimeMs === null ? null : new Date(current.mtimeMs).toISOString(),
      size: current.size,
      fields: current.fields,
      state: current.state,
      previousState: previous.state,
      lostFields: lost,
      degraded,
    });
  }

  /**
   * Logs a failure as one value-free line (error class only, never its message,
   * which could quote file content). Logging itself must not throw either: this
   * runs in timer callbacks, where an exception would crash the server.
   */
  function reportFailure(scope: Record<string, unknown>, error: unknown): void {
    try {
      emit('warn', { event: 'credential_watch_error', ...scope, error: error instanceof Error ? error.name : typeof error });
    } catch {
      // The logger is broken too; nothing safe is left to do.
    }
  }

  function safeEvaluate(entry: Entry): void {
    try {
      evaluate(entry);
    } catch (error) {
      reportFailure({ provider: entry.spec.provider, userId: entry.userId }, error);
    }
  }

  function schedule(entry: Entry): void {
    if (!running) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => safeEvaluate(entry), debounceMs);
    entry.timer.unref?.();
  }

  function detach(entry: Entry): void {
    entry.watcher?.close();
    entry.watcher = undefined;
  }

  function attach(entry: Entry): void {
    if (entry.watcher || !fs.existsSync(entry.dir)) return;
    if (watcherCount() >= maxWatchers) {
      if (!capLogged) emit('warn', { event: 'credential_watch_capped', maxWatchers });
      capLogged = true;
      return;
    }
    try {
      const watcher = fs.watch(entry.dir, { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === entry.spec.file) schedule(entry);
      });
      watcher.on('error', () => {
        // The directory went away; the next rescan re-attaches when it returns.
        detach(entry);
        schedule(entry);
      });
      entry.watcher = watcher;
    } catch {
      // Unwatchable now (permissions, a race with removal); rescan retries.
    }
  }

  async function rescan(): Promise<void> {
    if (!running) return;
    for (const userId of listMemberIds(usersRoot)) {
      for (const spec of specs) {
        const key = `${userId}\u0000${spec.provider}`;
        let entry = entries.get(key);
        if (!entry) {
          const dir = path.join(usersRoot, userId, spec.dir);
          const file = path.join(dir, spec.file);
          // First sight is the baseline: silent, so a restart does not flood the log.
          entry = { spec, userId, dir, file, snapshot: readCredentialFileSnapshot(spec, file) };
          entries.set(key, entry);
        } else {
          safeEvaluate(entry);
        }
        attach(entry);
      }
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      usersRoot = options.usersRoot ?? defaultUsersRoot();
      await rescan();
      if (rescanMs > 0) {
        interval = setInterval(() => {
          rescan().catch((error: unknown) => reportFailure({ phase: 'rescan' }, error));
        }, rescanMs);
        interval.unref?.();
      }
    },
    rescan,
    async stop() {
      running = false;
      clearInterval(interval);
      interval = undefined;
      for (const entry of entries.values()) {
        clearTimeout(entry.timer);
        detach(entry);
      }
      entries.clear();
    },
    watcherCount,
  };
}
