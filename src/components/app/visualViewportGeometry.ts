type VisualViewportGeometrySource = Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>;

export type ShellVisualViewportGeometry = {
  height: number;
  top: number;
};

/**
 * Return geometry that is safe to copy into the application shell CSS.
 *
 * Some mobile browsers briefly expose a zero or non-finite visual viewport
 * while their address bar is settling. Copying that value makes the fixed
 * shell zero-height until a later orientation/resize event. A null result
 * deliberately hands layout back to the CSS `inset-0` fallback.
 */
export function getShellVisualViewportGeometry(
  viewport: VisualViewportGeometrySource,
): ShellVisualViewportGeometry | null {
  const { height, offsetTop, scale } = viewport;

  if (
    !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(offsetTop)
    || offsetTop < 0
    || !Number.isFinite(scale)
    || scale <= 0
    || scale > 1.05
  ) {
    return null;
  }

  return { height, top: offsetTop };
}
