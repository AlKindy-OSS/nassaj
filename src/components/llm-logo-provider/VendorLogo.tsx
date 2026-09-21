import type { VendorProvider } from '../provider-auth/vendorProviders';

type VendorLogoProps = {
  provider: VendorProvider;
  className?: string;
};

/**
 * Initial-badge fallback for hosted vendor providers. Only used where no
 * dedicated mark exists — currently **glm** only. Kimi ships `BrandImageLogo`,
 * DeepSeek ships `DeepSeekLogo` (T-1761); both are routed by `SessionProviderLogo`
 * before this component is ever reached.
 *
 * Each badge is a rounded tile with the provider's initial on an accent fill —
 * distinct from the Claude logo, not a reproduction of any vendor's trademark.
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
