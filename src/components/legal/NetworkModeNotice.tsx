/** @jsxRuntime automatic @jsxImportSource react */
import type { Locale } from '@/lib/i18n/config';
import { networkNotice, type NetworkMode } from '@/legal/config';
import { parseInline } from '@/legal/markdown';

/**
 * The demonstration notice (SPEC 2.5): a slim strip that says tokens on the test network have no
 * value. Renders nothing on mainnet. The text lives in src/legal/config.ts, the same string the legal
 * pages print, so the strip and the pages cannot disagree. Pure, so server and client can both use it.
 */
export default function NetworkModeNotice({ locale, mode, className = '' }: { locale: Locale; mode?: NetworkMode; className?: string }) {
  const md = networkNotice(locale, mode);
  if (!md) return null;
  return (
    <p role="note" className={`rounded border border-[#C8A44D]/40 bg-[#C8A44D]/10 px-3 py-2 text-xs leading-relaxed text-[#F4F0E6]/90 ${className}`}>
      {parseInline(md).map((n, i) => (n.t === 'strong' ? <strong key={i} className="text-[#E8C776]">{n.children.map((c) => (c.t === 'text' ? c.v : ''))}</strong> : n.t === 'text' ? n.v : null))}
    </p>
  );
}
