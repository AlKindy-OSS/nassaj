/** Message contract consumed by the Android WebView host. */
export interface SystemBarThemeMessage {
  type: 'system-bar-theme';
  color: string;
}

interface AndroidWebMessageBridge {
  postMessage(message: string): void;
}

type BridgeWindow = Window & {
  NassajSystemBars?: AndroidWebMessageBridge;
};

const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]';
const OPAQUE_HEX_COLOR = /^#[0-9a-f]{6}$/i;

function currentThemeColor(documentRef: Document): string | null {
  const color = documentRef
    .querySelector<HTMLMetaElement>(THEME_COLOR_SELECTOR)
    ?.content.trim();
  return color && OPAQUE_HEX_COLOR.test(color) ? color.toLowerCase() : null;
}

/**
 * Mirrors the browser-owned theme color to the narrowly scoped Android host
 * object. Ordinary browsers and PWAs do not expose that object, making this a
 * no-op outside the native wrapper.
 */
export function installSystemBarsBridge(
  windowRef: Window = window,
  documentRef: Document = document,
): () => void {
  const bridge = (windowRef as BridgeWindow).NassajSystemBars;
  if (!bridge || typeof bridge.postMessage !== 'function') return () => {};

  let lastSentColor: string | null = null;
  const sendCurrentTheme = () => {
    const color = currentThemeColor(documentRef);
    if (!color || color === lastSentColor) return;

    const message: SystemBarThemeMessage = { type: 'system-bar-theme', color };
    try {
      bridge.postMessage(JSON.stringify(message));
      lastSentColor = color;
    } catch {
      // Native UI integration must never prevent the web app from rendering.
    }
  };

  sendCurrentTheme();

  const observer = new MutationObserver(sendCurrentTheme);
  observer.observe(documentRef.head, {
    attributes: true,
    attributeFilter: ['content'],
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}
