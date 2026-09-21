import { useTheme } from '../../contexts/ThemeContext';

/*
 * Source: the official DeepSeek brand mark — icon portion only, extracted from
 * github.com/deepseek-ai/DeepSeek-V2/blob/main/figures/logo.svg
 * (the whale/D glyph, geometry unaltered; colour swapped to white in dark mode).
 *
 * Same nominative-use rationale as CodexLogo, CursorLogo and QwenLogo:
 * this identifies the provider whose surface the tile selects — no mark is
 * recoloured beyond the light/dark swap, cropped, or composed into nassaj's
 * own identity.
 */
type DeepSeekLogoProps = {
  className?: string;
};

const DeepSeekLogo = ({ className = 'w-5 h-5' }: DeepSeekLogoProps) => {
  const { isDarkMode } = useTheme();

  return (
    <img
      src={isDarkMode ? '/icons/deepseek-white.svg' : '/icons/deepseek.svg'}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`${className} object-contain`}
    />
  );
};

export default DeepSeekLogo;
