import type { VendorProvider } from '../provider-auth/vendorProviders';

type VendorLogoProps = {
  provider: VendorProvider;
  className?: string;
};

/**
 * Neutral mark for the hosted vendor providers (kimi/deepseek/glm). We do not
 * ship third-party brand logos; instead each provider gets a rounded badge with
 * its initial on an accent fill. This keeps the session/provider icon distinct
 * (never the Claude logo) without impersonating any vendor's trademark.
 */
const VENDOR_GLYPH: Record<VendorProvider, { initial: string; fillClass: string }> = {
  kimi: { initial: 'K', fillClass: 'fill-rose-500' },
  deepseek: { initial: 'D', fillClass: 'fill-sky-500' },
  glm: { initial: 'G', fillClass: 'fill-violet-500' },
};

const VENDOR_LABEL: Record<VendorProvider, string> = {
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
};

const VendorLogo = ({ provider, className = 'w-5 h-5' }: VendorLogoProps) => {
  const glyph = VENDOR_GLYPH[provider];
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={VENDOR_LABEL[provider]}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" className={glyph.fillClass} />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-white"
        fontSize="12"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {glyph.initial}
      </text>
    </svg>
  );
};

export default VendorLogo;
