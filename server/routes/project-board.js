/**
 * PROJECT BOARD API ROUTES
 * ========================
 *
 * Read-only projection of product architecture plus optional governance state.
 * "Project Board" UI (spec: ~/.claude/wiki/project-board.md):
 *
 *   governance:project-state  — structured phases/tasks/issues/decisions
 *   docs/ARCHITECTURE.md      — technical architecture (Mermaid diagrams)
 *   docs/ARCHITECTURE_AR.md   — simplified owner-facing architecture
 *
 * Product architecture is local and versioned. Governance state is selected by
 * logical projectId/kind through the server-only resolver and never through a
 * product path or symlink. Architecture changes retain the existing watcher.
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
    readProductVersionedContent,
    tryResolveGovernanceContent,
} from '../services/governance-content-resolver.js';

const router = express.Router();

const ARCHITECTURE_FILE = 'docs/ARCHITECTURE.md';
const ARCHITECTURE_AR_FILE = 'docs/ARCHITECTURE_AR.md';

// Safety valve: never accumulate watchers without bound on a long-lived server.
const MAX_WATCHED_PROJECTS = 50;
const BROADCAST_DEBOUNCE_MS = 250;

/**
 * Per-project runtime cache.
 * projectId -> {
 *   projectPath: string,
 *   watcher: chokidar.FSWatcher | null,
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

function getBoardEntry(projectId, projectPath) {
    let entry = boards.get(projectId);
    if (!entry) {
        entry = { projectPath, watcher: null, lastGoodState: null, debounceTimer: null };
        boards.set(projectId, entry);
    }
    // Project paths can change (project re-created); keep the entry honest.
    if (entry.projectPath !== projectPath) {
        entry.projectPath = projectPath;
        if (entry.watcher) {
            entry.watcher.close().catch(() => {});
            entry.watcher = null;
        }
        entry.lastGoodState = null;
    }
    return entry;
}

/**
 * Lazily start a chokidar watcher for the two product-versioned architecture files.
 * chokidar tracks not-yet-existing architecture paths through their parent.
 */
function ensureWatcher(entry, projectId, wss) {
    if (entry.watcher || boards.size > MAX_WATCHED_PROJECTS) {
        return;
    }

    const targets = [ARCHITECTURE_FILE, ARCHITECTURE_AR_FILE]
        .map((relative) => path.join(entry.projectPath, relative));

    const watcher = chokidar.watch(targets, {
        ignoreInitial: true,
        // Writers (agents, editors) often write in bursts; wait for quiet.
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

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

async function readProductFileOrNull(projectPath, relativePath) {
    try {
        return readProductVersionedContent(projectPath, relativePath).content;
    } catch {
        return null;
    }
}

/**
 * GET /api/project-board/:projectId
 *
 * Response shape (all fields always present):
 * {
 *   projectId,
 *   available,        // governance project-state exists (even if invalid)
 *   state,            // parsed JSON, or last good copy on parse error, or null
 *   stateError,       // true when the file exists but is invalid JSON
 *   architecture: { technical, simplified }  // raw markdown or null
 * }
 */
router.get('/:projectId', async (req, res) => {
    try {
        const { projectId } = req.params;
        // B-PRIV guard: the board is project CONTENT — governance project-state
        // carries the full task/issue/decision history and the two ARCHITECTURE
        // files are read verbatim off disk — so it must not be readable for any
        // projectId that happens to be guessed or enumerated. assertProjectVisible
        // resolves the path itself and throws a 404 (not 403) when the project is
        // not visible, so a private project's existence is never disclosed.
        // The whole router is mounted behind authenticateToken (index.js), so
        // req.user is the authenticated caller.
        const projectPath = assertProjectVisible(projectId, coerceUserId(req.user?.id ?? null));

        const entry = getBoardEntry(projectId, projectPath);
        ensureWatcher(entry, projectId, req.app.locals.wss);

        const actorId = coerceUserId(req.user?.id ?? null);
        const governanceResolver = req.app.locals.governanceContentResolver
            ?? tryResolveGovernanceContent;
        const stateRead = governanceResolver({
            projectId,
            actorId,
            kind: 'project-state',
        });
        const [technical, simplified] = await Promise.all([
            readProductFileOrNull(projectPath, ARCHITECTURE_FILE),
            readProductFileOrNull(projectPath, ARCHITECTURE_AR_FILE),
        ]);

        let state = null;
        let stateError = stateRead.reason === 'invalid_json';

        if (stateRead.available) {
            try {
                state = stateRead.value ?? JSON.parse(stateRead.content);
                entry.lastGoodState = state;
            } catch {
                // Invalid JSON: serve the last good copy and flag the problem.
                state = entry.lastGoodState;
                stateError = true;
            }
        } else if (!stateError) {
            entry.lastGoodState = null;
        }

        res.json({
            projectId,
            available: stateRead.available || stateError,
            state,
            stateError,
            architecture: { technical, simplified },
            governance: stateRead.available
                ? { available: true, provenance: stateRead.provenance }
                : { available: false, reason: stateRead.reason ?? 'unavailable' },
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

export default router;
