/** @jsxRuntime automatic @jsxImportSource react */
/**
 * The Hammerprice logo as image files from public/brand. Images on purpose: the outlined letters are about
 * 9 kB of path data that would otherwise ship in every page's script; as files they are cached and cost no script.
 * `alt` is empty by default (the picture sits in a link that carries aria-label="Hammerprice"); pass `alt` where the logo stands alone (the About hero).
 * Sizes: the wordmark files are 365 x 58 and the symbol 42 x 58: give the height with a class, the width follows.
 */
export const WORDMARK_SRC = '/brand/logo-wordmark.svg';
export const TAGLINE_SRC = '/brand/logo-wordmark-tagline.svg';
export const SYMBOL_SRC = '/brand/logo-symbol.svg';

export default function Logo({ className = 'h-8 w-auto', variant = 'wordmark', alt = '' }: { className?: string; variant?: 'wordmark' | 'tagline' | 'symbol'; alt?: string }) {
  const src = variant === 'symbol' ? SYMBOL_SRC : variant === 'tagline' ? TAGLINE_SRC : WORDMARK_SRC;
  // eslint-disable-next-line @next/next/no-img-element -- an SVG file: nothing for next/image to resize
  return <img src={src} alt={alt} width={variant === 'symbol' ? 42 : 365} height={58} className={`block ${className}`} draggable={false} />;
}
