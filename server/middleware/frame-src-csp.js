// B-1657 / T-2040: ENFORCED frame restriction for every page this server emits.
//
// The app-wide Content-Security-Policy-Report-Only header (server/index.js)
// blocks nothing. A D3 rich block runs in <iframe sandbox="allow-scripts"
// srcdoc>, and script there can still run `location.href = 'https://…'`: the
// sandbox does not stop a frame from navigating ITSELF. The parent document's
// frame-src is what decides that navigation, and the browser refuses it before
// any request leaves, so an external page can never load inside the chat.
//
// Kept to the frame directive alone, in its own header, on purpose: a full
// enforced policy is a separate, verified change (see the Report-Only note in
// index.js). Two CSP headers combine as an intersection, so this adds one
// restriction and loosens nothing.
//
// Sources and why each one is needed (client inventory, B-1657):
//   'self' — same-origin frames; none ship today, kept so a future in-app
//            route frame is not silently broken.
//   blob:  — CodeEditorMediaPreview renders PDFs from a blob: URL.
// srcdoc frames (VizSandbox, Office preview, shared-document preview, the HTML
// file preview window) fetch nothing, so frame-src does not apply to their
// creation; their documents inherit this policy, which is the point.
//
// No child-src: when worker-src is absent it also governs workers, so it could
// break worker creation. Every supported browser honours frame-src.
//
// Routes that set their own `Content-Security-Policy` afterwards (share viewer,
// raw files, branding, overlays) REPLACE this value via setHeader. Each of those
// policies is stricter for frames (default-src 'none'/'self' or sandbox).

export const ENFORCED_FRAME_POLICY = "frame-src 'self' blob:";

/**
 * Express middleware that sets the enforced frame-src policy on the response.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function enforceFrameSrcPolicy(_req, res, next) {
    res.setHeader('Content-Security-Policy', ENFORCED_FRAME_POLICY);
    next();
}
