import { isRetiredProvider } from '../../../shared/retiredProviders';
import type { LLMProvider } from '../../types/app';
import { VENDOR_PROVIDERS, type VendorProvider } from '../provider-auth/vendorProviders';
import BrandImageLogo, { hasBrandImage } from './BrandImageLogo';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import DeepSeekLogo from './DeepSeekLogo';
import OpenCodeLogo from './OpenCodeLogo';
import QwenLogo from './QwenLogo';
import VendorLogo from './VendorLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

// Lightweight placeholder marks for providers whose brand SVGs are not yet
// wired. Each is a rounded tile with the provider's initials so the chips stay
// visually distinct until dedicated logo components land.
type InitialLogoProps = { className?: string };

const makeInitialLogo = (fill: string, initials: string) =>
  function InitialLogo({ className }: InitialLogoProps) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" role="presentation" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill={fill} />
        <text
          x="12"
          y="16"
          textAnchor="middle"
          fill="white"
          fontSize="10"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          {initials}
        </text>
      </svg>
    );
  };

// deepseek now has its own mark (T-1761). glm renders via the shared VendorLogo
// (ADR-036). antigravity, kimi, hermes and qwen moved to their REAL marks.
// sakana is the last placeholder, and is not shown in settings.
const SakanaLogo = makeInitialLogo('#14B8A6', 'S');

// A historical row may name a provider whose runtime was deleted (T-1853). It
// must not fall through to Claude's mark and misattribute the run; a neutral
// grey tile marks it as retired instead.
const RetiredProviderLogo = makeInitialLogo('#6B7280', '?');

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (isRetiredProvider(provider)) {
    return <RetiredProviderLogo className={className} />;
  }

  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  // Checked BEFORE the vendor branch: kimi is a hosted vendor id too, and the
  // generic "K" badge would otherwise win over its own mark.
  if (hasBrandImage(provider)) {
    return <BrandImageLogo provider={provider} className={className} />;
  }

  // deepseek has its own mark now (T-1761). Checked before the vendor branch so
  // the initialised VendorLogo badge does not shadow it.
  if (provider === 'deepseek') {
    return <DeepSeekLogo className={className} />;
  }

  // glm renders via the shared VendorLogo (ADR-036). kimi and deepseek no
  // longer reach this branch — they are matched above by their own marks.
  if (typeof provider === 'string' && (VENDOR_PROVIDERS as readonly string[]).includes(provider)) {
    return <VendorLogo provider={provider as VendorProvider} className={className} />;
  }

  if (provider === 'sakana') {
    return <SakanaLogo className={className} />;
  }

  if (provider === 'qwen') {
    return <QwenLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
