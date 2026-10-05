/**
 * PROJECT BOARD API ROUTES
 * ========================
 *
 * Read-only projection of a project's board, read from the project's OWN
 * folder (B-1524). "Project Board" UI (spec: ~/.claude/wiki/project-board.md):
 *
 *   docs/project-state.json   — structured phases/tasks/issues/decisions
 *   docs/ARCHITECTURE.md      — technical architecture (Mermaid diagrams)
 *   docs/ARCHITECTURE_AR.md   — simplified owner-facing architecture
 *
 * Whoever may enter a project sees its board and nobody else: the visibility
 * guard runs first and yields the project root; every file is then read through
 * project-board-reader, which refuses anything that resolves outside that root
 * (except an operator-declared external binding for this exact projectId's
 * state file — NASSAJ_BOARD_EXTERNAL_BINDINGS).
 *
 * Resilience contract: an invalid project-state.json NEVER breaks the board.
 * The route keeps the last successfully parsed state in memory and returns it
 * together with `stateError: true` so the UI can show a warning banner.
 */

import path from 'path';

import express from 'express';
import chokidar from 'chokidar';

import {
    assertProjectVisible,
    coerceUserId,
} from '../modules/projects/services/project-visibility-guard.service.js';
import { AppError } from '../shared/utils.js';
import {
    ARCHITECTURE_AR_FILE,
    ARCHITECTURE_FILE,
    BOARD_STATE_FILE,
    getExternalBinding,
    isExternalStatePath,
    readProjectBoardState,
    readProjectFile,
    STATE_MAX_BYTES,
} from '../services/project-board-reader.js';

const router = express.Router();

// Safety valve: never accumulate watchers without bound on a long-lived server.
const MAX_WATCHED_PROJECTS = 50;
const BROADCAST_DEBOUNCE_MS = 250;
// The state-file cap in MiB, sent so the client can name the limit on too_large.
const STATE_LIMIT_MB = STATE_MAX_BYTES / (1024 * 1024);

/**
 * Per-project runtime cache.
 * projectId -> {
 *   projectPath: string,
 *   watcher: chokidar.FSWatcher | null,
 *   externalTarget: string | null,  // bound state file watched outside the root
 *   lastGoodState: object | null,   // last successfully parsed project-state.json
 *   debounceTimer: NodeJS.Timeout | null,
 * }
 */
const boards = new Map();

/** Fan a JSON message out to every connected board client. */
function broadcastBoardUpdate(wss, projectId) {
    if (!wss || !projectId) {
        return;
    }

    const message = JSON.stringify({
        type: 'project-board-updated',
        projectId,
        timestamp: new Date().toISOString(),
    });

    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(message);
            } catch (error) {
                console.error('Error sending project board update:', error);
            }
        }
    });
}

function closeEntryWatcher(entry) {
    if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
    }
    if (entry.watcher) {
        entry.watcher.close().catch(() => {});
        entry.watcher = null;
    }
    entry.externalTarget = null;
}

function getBoardEntry(projectId, projectPath) {
    let entry = boards.get(projectId);
    if (!entry) {
        entry = {
            projectPath, watcher: null, externalTarget: null, lastGoodState: null, debounceTimer: null,
        };
        boards.set(projectId, entry);
    }
    // Project paths can change (project re-created); keep the entry honest.
    if (entry.projectPath !== projectPath) {
        entry.projectPath = projectPath;
        closeEntryWatcher(entry);
        entry.lastGoodState = null;
    }
    return entry;
}

/**
 * Lazily start a chokidar watcher for the three board files.
 * chokidar tracks not-yet-existing paths through their parent.
 */
function ensureWatcher(entry, projectId, wss) {
    if (entry.watcher || boards.size > MAX_WATCHED_PROJECTS) {
        return;
    }

    const targets = [BOARD_STATE_FILE, ARCHITECTURE_FILE, ARCHITECTURE_AR_FILE]
        .map((relative) => path.join(entry.projectPath, relative));

    const watcher = chokidar.watch(targets, {
        ignoreInitial: true,
        // Writers (agents, editors) often write in bursts; wait for quiet.
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    // The debounce also coalesces the double event a symlinked state file
    // produces (its link path and its bound external target both fire).
    const notify = () => {
        if (entry.debounceTimer) {
            clearTimeout(entry.debounceTimer);
        }
        entry.debounceTimer = setTimeout(() => {
            entry.debounceTimer = null;
            broadcastBoardUpdate(wss, projectId);
        }, BROADCAST_DEBOUNCE_MS);
    };

    watcher.on('add', notify);
    watcher.on('change', notify);
    watcher.on('unlink', notify);
    watcher.on('error', (error) => {
        console.error(`Project board watcher error for ${projectId}:`, error.message);
    });

    entry.watcher = watcher;
}

/**
 * Keep the watcher on the bound external state file (if any) in step with the
 * file the last read actually resolved to. Added once, swapped on change.
 */
function syncExternalTarget(entry, stateRead) {
    if (!entry.watcher) {
        return;
    }
    const next = stateRead.realPath && isExternalStatePath(stateRead.realPath, stateRead.rootReal)
        ? stateRead.realPath
        : null;
    if (next === entry.externalTarget) {
        return;
    }
    if (entry.externalTarget) {
        entry.watcher.unwatch(entry.externalTarget);
    }
    if (next) {
        entry.watcher.add(next);
    }
    entry.externalTarget = next;
}

function readArchitecture(projectPath, relativePath) {
    const read = readProjectFile(projectPath, relativePath);
    return read.status === 'ok' ? read.content : null;
}

/** Turn a state read into the response's state fields, honouring lastGoodState. */
function projectState(entry, stateRead) {
    if (stateRead.status === 'ok') {
        entry.lastGoodState = stateRead.value;
        return { available: true, state: stateRead.value, stateError: false };
    }
    if (stateRead.status === 'invalid_json') {
        // Invalid JSON: serve the last good copy and flag the problem.
        return { available: true, state: entry.lastGoodState, stateError: true };
    }
    entry.lastGoodState = null;
    return { available: false, state: null, stateError: false };
}

/**
 * GET /api/project-board/:projectId
 *
 * Response shape (all fields always present):
 * {
 *   projectId,
 *   available,        // project-state exists (even if invalid JSON)
 *   state,            // parsed JSON, or last good copy on parse error, or null
 *   stateError,       // true when the file exists but is invalid JSON
 *   stateReason,      // 'ok'|'missing'|'invalid_json'|'too_large'|'outside_project'
 *                     // |'external_source_unconfigured'|'unreadable'
 *   stateLimitMb,     // the project-state.json size cap in MiB (always sent)
 *   architecture: { technical, simplified }  // raw markdown or null
 * }
 */
router.get('/:projectId', async (req, res) => {
    try {
        const { projectId } = req.params;
        // B-PRIV guard: the board is project CONTENT, so it must not be readable
        // for any projectId that is guessed or enumerated. assertProjectVisible
        // throws a 404 (not 403) before any file is touched, so a hidden
        // project's existence is never disclosed. The router is mounted behind
        // authenticateToken (index.js), so req.user is the authenticated caller.
        const projectPath = assertProjectVisible(projectId, coerceUserId(req.user?.id ?? null));

        const entry = getBoardEntry(projectId, projectPath);
        ensureWatcher(entry, projectId, req.app.locals.wss);

        const stateRead = readProjectBoardState(projectPath, {
            externalBinding: getExternalBinding(projectId),
        });
        syncExternalTarget(entry, stateRead);

        res.json({
            projectId,
            ...projectState(entry, stateRead),
            stateReason: stateRead.status,
            stateLimitMb: STATE_LIMIT_MB,
            architecture: {
                technical: readArchitecture(projectPath, ARCHITECTURE_FILE),
                simplified: readArchitecture(projectPath, ARCHITECTURE_AR_FILE),
            },
        });
    } catch (error) {
        // The visibility guard signals refusal as an AppError(404); surface its
        // status verbatim instead of collapsing it into a 500, so an
        // unauthorized/unknown project reads as "not found" to the client.
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Error building project board response:', error);
        res.status(500).json({ error: 'Failed to load project board' });
    }
});

/** Test seam: close every watcher so a real-chokidar test can exit cleanly. */
export const __test__ = Object.freeze({
    async closeAll() {
        const closing = [...boards.values()].map((entry) => entry.watcher?.close());
        for (const entry of boards.values()) {
            entry.watcher = null;
            closeEntryWatcher(entry);
        }
        boards.clear();
        await Promise.allSettled(closing);
    },
});

export default router;
