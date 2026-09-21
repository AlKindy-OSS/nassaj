import React from 'react';
import { useTheme } from '../../contexts/ThemeContext';

/*
 * Source: the official Qwen Code brand mark, taken verbatim from the vendor's
 * own repository — QwenLM/qwen-code, `packages/zed-extension/qwen-code.svg`
 * (Apache-2.0). Same nominative-use rationale as CodexLogo and CursorLogo.
 *
 * DO NOT source this from the installed npm package: its only bundled SVGs are
 * `web-shell/assets/default-*.svg` (a generic hand/gesture placeholder avatar)
 * and `queue-*.svg`, and `web-shell/assets/logo-*.js` is a syntax grammar for
 * the LOGO programming language — not a brand asset. An earlier pass shipped
 * the hand as the Qwen mark on exactly that mistake.
 *
 * Geometry is unaltered; the light/dark variants differ in fill only.
 */
type QwenLogoProps = {
  className?: string;
};

const QwenLogo = ({ className = 'w-5 h-5' }: QwenLogoProps) => {
  const { isDarkMode } = useTheme();

  return (
    <img
      src={isDarkMode ? '/icons/qwen-white.svg' : '/icons/qwen.svg'}
      alt="Qwen"
      className={className}
    />
  );
};

export default QwenLogo;
