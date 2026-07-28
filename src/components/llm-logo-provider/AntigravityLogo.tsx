/**
 * Antigravity (agy CLI) logo.
 *
 * No vendor SVG exists for agy yet; we use a stylised lightning-bolt glyph
 * inside a rounded square. The geometry is laid out with logical properties
 * so it renders the same in RTL and LTR contexts. Decorative — the surrounding
 * label provides the accessible name.
 */
const AntigravityLogo = ({ className = 'w-5 h-5' }: { className?: string }) => {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="5"
        className="fill-emerald-500 dark:fill-emerald-400"
      />
      <path
        d="M13.2 4 7 13.4h4.1l-1.4 6.6 6.2-9.4h-4.1L13.2 4Z"
        className="fill-white"
      />
    </svg>
  );
};

export default AntigravityLogo;
