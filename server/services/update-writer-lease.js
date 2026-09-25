import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

import {
    createUpdateMaintenanceGate, isComposedUpdateGateReasonCode,
    UPDATE_GATE_DEFERRABLE_REASON_CODES, UPDATE_GATE_REASON_CODES,
} from './update-maintenance-gate.js';

const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
let applicationGate = null;
const writerContext = new AsyncLocalStorage();

/** Test-only gate injection; production always resolves the real application maintenance gate. */
export function setApplicationWriterGateForTests(gate) {
    if (process.env.NODE_ENV !== 'test') throw new Error('test_gate_unavailable');
    applicationGate = gate;
    // Throttle state is process-wide; a fresh fixture must start from a fresh
    // window or the first denial of the next test would be folded away.
    gateLogWindows.clear();
}

/** Retain a nested writer without reacquiring admission after its parent was admitted. */
function retainContext(context) {
    context.references += 1;
    let released = false;
    return { release() {
        if (released) return;
        released = true;
        if (--context.references === 0) { context.held = false; context.lease.release(); }
    } };
}

/**
 * Map a writer-lease rejection to a client-safe update-gate reason code.
 *
 * The vocabulary comes from the gate itself (UPDATE_GATE_REASON_CODES plus the
 * composed families it declares), never from a copy kept here: a private copy
 * is how `update_lock_contended` — what a real concurrent update raises — was
 * being reported as "maintenance active". An unrecognised rejection (whose text
 * may carry paths or internals) collapses to the generic maintenance code, so
 * an unknown message can neither leak nor break a refusal path.
 *
 * The composed families are forwarded verbatim for the same reason the literals
 * are: collapsing `update_reopen_manifest_unsafe` to `update_maintenance_active`
 * puts a wrong cause in the log and tells an operator an update is running when
 * what actually happened is that an activation control file failed its
 * integrity check. The patterns are anchored over closed alternative sets, so
 * nothing variable and nothing untrusted can ride along.
 *
 * @param {unknown} error rejection raised by the gate
 * @returns {string} a declared gate code, or `update_maintenance_active`
 */
export function readUpdateGateCode(error) {
    const message = error instanceof Error ? error.message : '';
    if (UPDATE_GATE_REASON_CODES.includes(message)) return message;
    return isComposedUpdateGateReasonCode(message) ? message : 'update_maintenance_active';
}

/**
 * Is this rejection a refusal RAISED BY THE GATE, rather than any other failure?
 *
 * `readUpdateGateCode` deliberately collapses an unknown rejection to
 * `update_maintenance_active` so a refusal path can never break or leak — which
 * makes it useless for DECIDING whether a gate refusal happened at all. Where a
 * caller wraps an arbitrary operation (an Express layer wraps the whole route
 * handler), that distinction is the whole point: reporting an ordinary
 * application error as "denied by update gate" writes a FABRICATED root cause
 * into the production log, consumes the throttle window a real denial needs,
 * and marks the error so the error handler will not log it either.
 *
 * Classify with this first; only then announce or map to a code.
 *
 * BOTH declarations count. The literal list alone left the gate's three
 * runtime-composed families (`update_reopen_${label}_unsafe` and the two
 * generation families) classified as "not the gate" — so a REAL refusal
 * travelled on as an ordinary error: a generic 500, and not one log line naming
 * the gate. That is the same fabricated-cause defect as the original, pointed
 * the other way, and it hit precisely the codes that report tampering.
 *
 * @param {unknown} error rejection to classify
 * @returns {boolean} true only for a code this gate declares
 */
export function isGateDenial(error) {
    if (!(error instanceof Error)) return false;
    return UPDATE_GATE_REASON_CODES.includes(error.message)
        || isComposedUpdateGateReasonCode(error.message);
}

/**
 * Is this rejection a gate refusal a background tick may answer with "later"?
 *
 * The vocabulary — and the argument for why it is a strict subset rather than
 * all of `UPDATE_GATE_REASON_CODES` — lives beside the parent list in
 * update-maintenance-gate.js. The short form: deferral is honest only when the
 * same call can succeed later unaided; a corrupt journal or an unsafe token is
 * a fault, and a background job that swallows it is silently dead.
 *
 * @param {unknown} error rejection to classify
 * @returns {boolean} true only for a transient, retry-able gate refusal
 */
export function isDeferrableGateDenial(error) {
    return error instanceof Error && UPDATE_GATE_DEFERRABLE_REASON_CODES.includes(error.message);
}

/**
 * HTTP surfaces have no per-connection object to hang a "already announced"
 * flag on the way a websocket does, and a re-arm-on-success flag would still
 * emit one line per flock cycle (the gate takes and releases the lock in short
 * cycles during `transition()`, so denials and admissions alternate). A fixed
 * time window is therefore the only bound that holds for the WHOLE maintenance
 * window: at most one line per surface per window, with the count it swallowed
 * carried into the next line so nothing is hidden, only folded.
 */
const GATE_LOG_WINDOW_MS = 60_000;
const gateLogWindows = new Map();

/** Marks a rejection already reported, so `next(error)` cannot log it twice. */
const GATE_DENIAL_ANNOUNCED = Symbol('nassajUpdateGateDenialAnnounced');

/**
 * Log one throttled denial line for `surface` and return its reason code.
 *
 * @param {string} surface stable label for the refusal site
 * @param {unknown} error rejection raised by the gate
 * @returns {string} the classified reason code
 */
function announceGateDenial(surface, error) {
    const code = readUpdateGateCode(error);
    if (error && typeof error === 'object') {
        if (error[GATE_DENIAL_ANNOUNCED]) return code;
        try { error[GATE_DENIAL_ANNOUNCED] = true; } catch { /* frozen error */ }
    }
    const now = Date.now();
    const open = gateLogWindows.get(surface);
    if (open && now - open.at < GATE_LOG_WINDOW_MS) {
        open.suppressed += 1;
        return code;
    }
    const folded = open ? open.suppressed : 0;
    gateLogWindows.set(surface, { at: now, suppressed: 0 });
    console.error(`[ERROR] ${surface} denied by update gate (${code})`
        + (folded ? ` [+${folded} more suppressed since the previous line]` : ''));
    return code;
}

/**
 * The client-safe code a refusal surface reports when the operation was refused
 * but the update gate had NOTHING to do with it. Deliberately distinct from
 * every `update_*` code: a client (and an operator reading a frame) must be
 * able to tell "maintenance is running, retry later" from "this failed and
 * retrying changes nothing".
 */
export const WRITER_LEASE_UNAVAILABLE_CODE = 'writer_lease_unavailable';

/** A reason code shape: bounded, lowercase, no whitespace, no path separator. */
const BOUNDED_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Describe a NON-gate rejection for the server log without reprinting free text.
 *
 * @param {unknown} error rejection to describe
 * @returns {string} the error class, plus its message only when bounded-code shaped
 */
function describeNonGateFailure(error) {
    if (!(error instanceof Error)) return `${typeof error} (not an Error)`;
    return BOUNDED_CODE.test(error.message)
        ? `${error.name}: ${error.message}`
        : `${error.name} (message withheld: not a bounded reason code)`;
}

/**
 * The ONE classification every writer-lease refusal surface shares.
 *
 * Five surfaces (the /api/terminals 409, the shell PTY and shell/terminal/chat
 * frame catches) called `readUpdateGateCode` with no prior classification.
 * Because that reader deliberately COLLAPSES anything it does not recognise,
 * every failure — a TypeError in the wrapped operation, an `artifact_*` code
 * outside the gate's vocabulary — came out as `update_maintenance_active`: the
 * user was told "Source update maintenance is active" and the log recorded
 * "denied by update gate" while no update was running anywhere. That is a
 * fabricated root cause, and it is worse than silence because it is credible.
 *
 * FAIL-CLOSED EITHER WAY: this function only decides WHAT TO SAY. The caller
 * refuses the operation in both branches — a non-gate failure is still a
 * failure, and must never be allowed to fall through into proceeding.
 *
 * @param {string} surface stable label for the refusal site, used in the log
 * @param {unknown} error rejection to classify
 * @param {{ gateAlreadyAnnounced?: boolean }} [options] set `gateAlreadyAnnounced`
 *   when this connection already logged a gate denial (per-connection dedupe);
 *   it suppresses the GATE line only, never the ordinary-failure line, because
 *   ordinary failures are distinct events and folding them hides faults.
 * @returns {{ gateDenial: boolean, code: string }} `code` is always safe to put
 *   on the wire
 */
export function reportWriterLeaseRefusal(surface, error, options = {}) {
    if (isGateDenial(error)) {
        const code = readUpdateGateCode(error);
        if (!options.gateAlreadyAnnounced) {
            console.error(`[ERROR] ${surface} denied by update gate (${code})`);
        }
        return { gateDenial: true, code };
    }
    // The wording names the gate ONLY to exclude it: an operator grepping
    // "denied by update gate" must not find this line.
    //
    // WHY THE MESSAGE IS FILTERED rather than printed. A rejection reaching
    // here is arbitrary, and the gate's own rejection text can carry control
    // paths ("boom at /home/operator/.secret/token-zz9" is the fixture this
    // path is pinned against). A BOUNDED CODE — the realistic case, an
    // `artifact_*` literal — is safe and is the whole diagnostic value, so it
    // is printed; free text is withheld, leaving the class name. Nothing is
    // lost that the caller cannot log better: the websocket frame catches sit
    // OUTSIDE an inner catch that already logs ordinary handler errors in full,
    // and the terminals route rethrows into its own catch, which logs there.
    console.error(`[ERROR] ${surface} refused (not the update gate):`, describeNonGateFailure(error));
    return { gateDenial: false, code: WRITER_LEASE_UNAVAILABLE_CODE };
}

/** Acquire the shared source-update reader lease for an application writer. */
export function acquireApplicationWriterLease(kind, options = {}) {
    const current = writerContext.getStore();
    if (current?.held) return Promise.resolve(retainContext(current));
    applicationGate ||= createUpdateMaintenanceGate({ projectPath: path.resolve(APP_ROOT) });
    return applicationGate.acquireWriterLease({ kind, ...options });
}

/** Keep a local writer admitted through its entire async operation, including nested dispatch. */
export async function withLocalUpdateWriterLease(kind, operation, options = {}) {
    if (process.env.NASSAJ_UPDATE_MODE !== 'local-main') return operation();
    const existing = writerContext.getStore();
    if (existing?.held) {
        const retained = retainContext(existing);
        try { return await operation(); } finally { retained.release(); }
    }
    const lease = await acquireApplicationWriterLease(kind, { waitMs: 100, ...options });
    const context = { lease, references: 0, held: true };
    const retained = retainContext(context);
    try { return await writerContext.run(context, operation); } finally { retained.release(); }
}

/** A denied background tick remains pending and performs no work; later ticks may retry. */
export async function runLocalUpdateBackground(kind, operation) {
    try { return await withLocalUpdateWriterLease(kind, operation); }
    catch (error) {
        // Only a TRANSIENT gate refusal is "pending"; a fault (corrupt journal,
        // unsafe control file, invalid writer kind) must reach the caller. The
        // private list this replaced waited on `update_lock_timeout`, which the
        // gate never raises, and missed `update_lock_contended`, which is what a
        // real concurrent update raises — so the one case the swallow existed
        // for was the one case that threw.
        if (isDeferrableGateDenial(error)) return null;
        throw error;
    }
}

/** Express middleware retaining a writer lease until the response is complete. */
export function applicationWriterLeaseMiddleware(kind) {
    return async (_req, res, next) => {
        let lease;
        let context = writerContext.getStore();
        try {
            lease = await acquireApplicationWriterLease(kind, { waitMs: 100 });
            if (!context?.held) {
                context = { lease, references: 0, held: true };
                lease = retainContext(context);
            }
        } catch (error) {
            // Acquisition can fail for reasons that are NOT the gate refusing —
            // a TypeError while the gate is constructed, an `artifact_*` code
            // outside the declared vocabulary. Answering those with "Source
            // update maintenance is active" puts a fabricated root cause in the
            // log AND in the response body. Still fail-closed (the request is
            // refused either way); what changes is that the reason is true.
            if (!isGateDenial(error)) return next(error);
            // Same classification as every other refusal surface, and no longer
            // silent: the previous private mapping collapsed every non-generic
            // denial into `update_writer_unavailable` with nothing in the log.
            // Throttled: this runs per REQUEST, and polling UIs keep requesting
            // for the whole maintenance window.
            const code = announceGateDenial(`HTTP writer lease (kind ${kind})`, error);
            return res.status(409).json({ success: false, code, error: 'Source update maintenance is active' });
        }
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            lease.release();
        };
        res.once('finish', release);
        res.once('close', release);
        writerContext.run(context, next);
    };
}

/** Mount path of a router layer from its Express 4 regexp ('' for root mounts). */
function mountPathOf(layer) {
    if (layer.regexp?.fast_slash) return '';
    const source = layer.regexp?.source ?? '';
    const match = /^\^((?:\\\/[^\\?()[\]|*+]*)*)\\\/\?\(\?=\\\/\|\$\)/.exec(source);
    return match ? match[1].replace(/\\\//g, '/') : '';
}

/**
 * Shared Express 4 stack walker: the ONE traversal both the update-lease
 * installer and the ADR-172 route-protection probe use, so the probe sees the
 * exact layer set the lease wraps. `visitLeaf(layer)` gets every handler layer;
 * `visitRoute(route, fullPath)` (optional) gets every route with its mount prefix.
 */
export function walkExpressStack(stack, { visitLeaf = () => {}, visitRoute = null } = {}) {
    const visited = new Set();
    const walk = (layers, prefix) => {
        for (const layer of layers || []) {
            if (visited.has(layer)) continue;
            visited.add(layer);
            if (layer.route?.stack) {
                if (visitRoute) visitRoute(layer.route, prefix + layer.route.path);
                walk(layer.route.stack, prefix);
                continue;
            }
            if (layer.handle?.stack) {
                walk(layer.handle.stack, prefix + mountPathOf(layer));
                continue;
            }
            visitLeaf(layer);
        }
    };
    walk(stack, '');
}

/** Every registered route of an Express app as { method, path } (ADR-172 P1-1). */
export function listExpressRoutes(app) {
    const routes = [];
    walkExpressStack(app._router?.stack || app.router?.stack || app.stack, {
        visitRoute: (route, fullPath) => {
            for (const method of Object.keys(route.methods || {})) {
                if (route.methods[method]) routes.push({ method: method.toUpperCase(), path: fullPath });
            }
        },
    });
    return routes;
}

/** Retain application effects independently of response lifetime, including disconnected clients. */
export function installLocalUpdateRouteLeases(app) {
    if (process.env.NASSAJ_UPDATE_MODE !== 'local-main') return;
    const wrapLeaf = (layer) => {
        const original = layer.handle;
        if (typeof original !== 'function') return;
        if (original.length === 4) {
            layer.handle = function admittedError(error, req, res, next) {
                return withLocalUpdateWriterLease('http-error-handler', () => original.call(this, error, req, res, next))
                    .catch((leaseError) => {
                        // This catch also sees whatever the WRAPPED ERROR
                        // HANDLER threw, so classify before blaming the
                        // gate: an unrelated throw is forwarded untouched to
                        // the next error layer, never logged as a denial and
                        // never answered with a misleading 503.
                        if (!isGateDenial(leaseError)) return next(leaseError);
                        // The 503 used to be wholly silent; name the reason
                        // — once per window, and NEVER a second time for a
                        // request whose handler layer already announced its
                        // denial before handing it to `next` (that pairing
                        // is what produced two lines per rejected request).
                        if (!error?.[GATE_DENIAL_ANNOUNCED]) announceGateDenial('HTTP error-handler', leaseError);
                        // Raw ServerResponse API on purpose: the denial can
                        // fire at the `query`/`expressInit` layers, i.e.
                        // BEFORE expressInit has given `res` the express
                        // prototype, where `res.status()` does not exist yet
                        // and threw a TypeError instead of answering 503.
                        if (!res.headersSent) res.statusCode = 503;
                        res.end();
                    });
            };
            return;
        }
        layer.handle = function admittedHandler(req, res, next) {
            const rawPath = (req.originalUrl || req.url || '').split('?')[0];
            const exempt = rawPath === '/health'
                || (req.method === 'POST' && /^\/api\/system\/update\/local\/[1-9][0-9]*\/confirm$/.test(rawPath));
            if (exempt) return original.call(this, req, res, next);
            return withLocalUpdateWriterLease('http-handler', () => original.call(this, req, res, next))
                .catch((leaseError) => {
                    // This catch sees BOTH the lease refusal and every
                    // rejection of the route handler it wraps. Announcing
                    // unconditionally attributed ordinary application
                    // failures to the update gate — a fabricated root cause
                    // in the log, a throttle window burnt so a real denial
                    // in the same minute was folded away, and a marked error
                    // the error handler then declined to log as well.
                    if (!isGateDenial(leaseError)) return next(leaseError);
                    // Stamps the rejection as announced, so the wrapped
                    // error handler it is about to reach does not log the
                    // same denial a second time (2 lines per request).
                    announceGateDenial('HTTP handler', leaseError);
                    next(leaseError);
                });
        };
    };
    walkExpressStack(app._router?.stack || app.router?.stack, { visitLeaf: wrapLeaf });
}
